"""Hermes Runの単一購読、イベント安全化、連番再送、失敗終端を確認します。"""

import asyncio
from collections.abc import AsyncIterator
from datetime import datetime

import pytest

from app.services import hermes_runs as hermes_runs_module
from app.services import daily_state as daily_state_module
from app.services.hermes import HermesConflictError, HermesError, HermesSession, HermesSessionMessage
from app.services.hermes_runs import HermesRunCoordinator


SESSION_ID = "avatar_gateway_0123456789abcdef0123456789abcdef"
RUN_ID = "run_0123456789abcdef0123456789abcdef"


@pytest.mark.asyncio
async def test_daily_context_refreshes_each_run_and_preserves_instructions(monkeypatch) -> None:
    """同じセッションの時間帯変更を反映し、既存指示とユーザー本文を保つことを確認します。"""
    class Clock(datetime):
        """外部時計を変更せず、会話開始時刻だけを制御します。"""

        hour = 17

        @classmethod
        def now(cls, tz=None):
            """指定タイムゾーンで検証用の日時を返します。"""
            return datetime(2026, 9, 7, cls.hour, 10, tzinfo=tz)

    monkeypatch.setattr(daily_state_module, "datetime", Clock)
    client = _FakeHermesClient(events=[{"event": "run.completed", "output": "完了"}])
    coordinator = HermesRunCoordinator(lambda: client)
    for hour, phase in [(17, "daytime"), (21, "evening")]:
        Clock.hour = hour
        await coordinator.start_run(SESSION_ID, "今の時間帯は？", "既存の音声・モーション指示")
        _ = [event async for event in coordinator.stream_events(RUN_ID)]
        sent = client.started_with
        assert sent["input"] == "今の時間帯は？"
        assert sent["instructions"].startswith("既存の音声・モーション指示\n\n")
        assert f"現在日時: 2026-09-07 {hour}:10" in sent["instructions"]
        assert f"現在の時間帯: {phase}" in sent["instructions"]
        assert sent["instructions"].count("現在日時:") == 1


class _FakeHermesClient:
    """外部Hermesなしで、Run APIと一購読者向けSSEの契約を再現します。"""

    def __init__(
        self,
        events: list[dict] | None = None,
        failure: HermesError | None = None,
        recovered_states: list[dict] | None = None,
    ) -> None:
        self.events = events or []
        self.failure = failure
        self.recovered_states = list(recovered_states or [])
        self.last_recovered_state: dict | None = None
        self.stream_calls = 0
        self.started_with: dict | None = None
        self.stopped_runs: list[str] = []
        self.approval_gate = asyncio.Event()
        self.approval_responses: list[tuple[str, str]] = []

    async def get_session(self, session_id: str) -> HermesSession:
        assert session_id == SESSION_ID
        return HermesSession({"id": session_id})

    async def get_session_messages(self, session_id: str) -> tuple[HermesSessionMessage, ...]:
        assert session_id == SESSION_ID
        return (
            HermesSessionMessage({"role": "user", "content": "以前の質問"}),
            HermesSessionMessage({"role": "assistant", "content": "以前の回答"}),
            HermesSessionMessage({"role": "tool", "content": "ツール結果"}),
        )

    async def start_run(
        self,
        session_id: str,
        user_input: str,
        conversation_history: list[dict[str, str]],
        instructions: str | None = None,
    ) -> dict:
        self.started_with = {
            "session_id": session_id,
            "input": user_input,
            "conversation_history": conversation_history,
            "instructions": instructions,
        }
        return {"run_id": RUN_ID, "status": "started"}

    async def get_run(self, run_id: str) -> dict:
        """バックエンド再起動後にHermesだけが保持するRun状態を順番に返します。"""
        assert run_id == RUN_ID
        if self.recovered_states:
            self.last_recovered_state = self.recovered_states.pop(0)
        if self.last_recovered_state is None:
            raise HermesError("回収用Run状態がありません")
        return dict(self.last_recovered_state)

    async def stream_run_events(self, run_id: str) -> AsyncIterator[dict]:
        assert run_id == RUN_ID
        self.stream_calls += 1
        if self.failure:
            raise self.failure
        for event in self.events:
            yield event
            if event.get("event") == "approval.request":
                await self.approval_gate.wait()

    async def stop_run(self, run_id: str) -> dict:
        """中断連携が正しいRun IDをHermesへ渡したか記録します。"""
        self.stopped_runs.append(run_id)
        return {"run_id": run_id, "status": "stopping"}

    async def respond_to_run_approval(self, run_id: str, choice: str) -> dict:
        """承認回答を記録し、待機中の模擬Hermes Runを再開します。"""
        self.approval_responses.append((run_id, choice))
        self.approval_gate.set()
        return {"run_id": run_id, "choice": choice, "resolved": 1}


@pytest.mark.asyncio
async def test_coordinator_subscribes_once_and_replays_sanitized_events() -> None:
    """複数ブラウザへ再送してもHermes購読は一つで、推論とpreview本文を保存しません。"""
    client = _FakeHermesClient(events=[
        {"event": "reasoning.available", "text": "secret chain of thought"},
        {"event": "tool.started", "tool": "terminal", "preview": "token=secret-value"},
        {"event": "tool.completed", "tool": "terminal", "duration": 0.4, "error": False},
        {"event": "message.delta", "delta": "完了しました。"},
        {"event": "run.completed", "output": "完了しました。", "usage": {"total_tokens": 5}},
    ])
    coordinator = HermesRunCoordinator(lambda: client)

    started = await coordinator.start_run(SESSION_ID, "作業して")
    first = [event async for event in coordinator.stream_events(RUN_ID) if event is not None]
    replay = [event async for event in coordinator.stream_events(RUN_ID, after=2) if event is not None]

    assert started["run_id"] == RUN_ID
    assert client.stream_calls == 1
    assert client.started_with == {
        "session_id": SESSION_ID,
        "input": "作業して",
        "conversation_history": [
            {"role": "user", "content": "以前の質問"},
            {"role": "assistant", "content": "以前の回答"},
            {"role": "tool", "content": "ツール結果"},
        ],
        "instructions": client.started_with["instructions"],
    }
    assert "現在の時間帯:" in client.started_with["instructions"]
    assert "現在の時間帯と矛盾する挨拶や発言をしないこと。" in client.started_with["instructions"]
    assert [event["type"] for event in first] == [
        "agent.started",
        "agent.thinking",
        "tool.started",
        "tool.completed",
        "assistant.delta",
        "assistant.completed",
    ]
    assert [event["sequence"] for event in first] == [1, 2, 3, 4, 5, 6]
    assert [event["sequence"] for event in replay] == [3, 4, 5, 6]
    assert "secret chain of thought" not in str(first)
    assert "secret-value" not in str(first)
    assert coordinator.get_run(RUN_ID)["status"] == "completed"
    assert coordinator.get_run(RUN_ID)["finished"] is True


@pytest.mark.asyncio
async def test_upstream_failure_becomes_replayable_terminal_event() -> None:
    """ブラウザ接続前の上流障害も失わず、再接続可能な失敗イベントにします。"""
    client = _FakeHermesClient(failure=HermesError("Hermes Runイベントへ接続できません"))
    coordinator = HermesRunCoordinator(lambda: client)

    await coordinator.start_run(SESSION_ID, "失敗確認")
    events = [event async for event in coordinator.stream_events(RUN_ID) if event is not None]

    assert [event["type"] for event in events] == ["agent.started", "agent.failed"]
    assert events[1]["message"] == "Hermes Runイベントへ接続できません"
    assert coordinator.get_run(RUN_ID)["status"] == "failed"


@pytest.mark.asyncio
async def test_coordinator_forwards_stop_and_records_stopping_event() -> None:
    """所有Runの停止要求をHermesへ送り、再接続先にも停止中を通知します。"""
    client = _FakeHermesClient(events=[
        {"event": "run.cancelled"},
    ])
    coordinator = HermesRunCoordinator(lambda: client)

    await coordinator.start_run(SESSION_ID, "長い作業")
    stopped = await coordinator.stop_run(RUN_ID)
    events = [event async for event in coordinator.stream_events(RUN_ID) if event is not None]

    assert stopped["status"] == "stopping"
    assert client.stopped_runs == [RUN_ID]
    assert [event["type"] for event in events] == [
        "agent.started",
        "agent.stopping",
        "agent.stopped",
    ]


@pytest.mark.asyncio
async def test_coordinator_answers_only_waiting_approval_and_resumes_run() -> None:
    """承認要求を保持したRunだけへ回答し、回答イベント後に作業中へ戻します。"""
    client = _FakeHermesClient(events=[
        {
            "event": "approval.request",
            "command": "safe-command",
            "description": "確認が必要です",
            "choices": ["once", "session", "always", "deny"],
        },
        {"event": "approval.responded", "choice": "once", "resolved": 1},
        {"event": "run.completed", "output": "完了"},
    ])
    coordinator = HermesRunCoordinator(lambda: client)

    await coordinator.start_run(SESSION_ID, "承認が必要な作業")
    for _attempt in range(20):
        if coordinator.get_run(RUN_ID)["status"] == "waiting_for_approval":
            break
        await asyncio.sleep(0)

    approved = await coordinator.respond_to_approval(RUN_ID, "once")
    with pytest.raises(HermesConflictError):
        await coordinator.respond_to_approval(RUN_ID, "once")
    events = [event async for event in coordinator.stream_events(RUN_ID) if event is not None]

    assert approved["status"] == "running"
    assert client.approval_responses == [(RUN_ID, "once")]
    assert [event["type"] for event in events] == [
        "agent.started",
        "approval.requested",
        "approval.responded",
        "assistant.completed",
    ]
    assert events[1]["command"] == "safe-command"
    assert coordinator.get_run(RUN_ID)["status"] == "completed"


@pytest.mark.asyncio
async def test_coordinator_recovers_completed_run_without_fabricating_event_history() -> None:
    """再起動前の本文やツールを捏造せず、Hermesの確定状態だけを回収します。"""
    client = _FakeHermesClient(recovered_states=[{
        "run_id": RUN_ID,
        "session_id": SESSION_ID,
        "status": "completed",
        "created_at": 100.0,
        "updated_at": 200.0,
        "output": "再取得してはいけない詳細",
    }])
    coordinator = HermesRunCoordinator(lambda: client)

    recovered = await coordinator.get_or_recover_run(RUN_ID)
    events = [event async for event in coordinator.stream_events(RUN_ID) if event is not None]

    assert recovered["status"] == "completed"
    assert recovered["recovered"] is True
    assert recovered["event_history_available"] is False
    assert recovered["approval_details_available"] is False
    assert [event["type"] for event in events] == ["run.recovered", "assistant.completed"]
    assert events[1]["output"] == ""
    assert "再取得してはいけない詳細" not in str(events)
    assert client.stream_calls == 0


@pytest.mark.asyncio
async def test_recovered_approval_is_blocked_but_run_can_be_stopped() -> None:
    """承認内容を失ったRunへ回答せず、利用者が安全に中断できることを確認します。"""
    client = _FakeHermesClient(recovered_states=[{
        "run_id": RUN_ID,
        "session_id": SESSION_ID,
        "status": "waiting_for_approval",
    }])
    coordinator = HermesRunCoordinator(lambda: client)

    recovered = await coordinator.get_or_recover_run(RUN_ID)
    with pytest.raises(HermesConflictError, match="承認内容を復元できない"):
        await coordinator.respond_to_approval(RUN_ID, "once")
    stopped = await coordinator.stop_run(RUN_ID)

    assert recovered["status"] == "waiting_for_approval"
    assert stopped["status"] == "stopping"
    assert client.approval_responses == []
    assert client.stopped_runs == [RUN_ID]
    task = coordinator._records[RUN_ID].task
    assert task is not None
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_recovered_running_run_is_polled_until_formal_terminal_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """SSEを再購読せず、状態APIの完了だけを再接続ブラウザへ通知します。"""
    monkeypatch.setattr(hermes_runs_module, "_RECOVERY_POLL_INTERVAL_SECONDS", 0)
    client = _FakeHermesClient(recovered_states=[
        {"run_id": RUN_ID, "session_id": SESSION_ID, "status": "running"},
        {"run_id": RUN_ID, "session_id": SESSION_ID, "status": "completed"},
    ])
    coordinator = HermesRunCoordinator(lambda: client)

    await coordinator.get_or_recover_run(RUN_ID)
    events = [event async for event in coordinator.stream_events(RUN_ID) if event is not None]

    assert [event["type"] for event in events] == ["run.recovered", "assistant.completed"]
    assert coordinator.get_run(RUN_ID)["status"] == "completed"
    assert client.stream_calls == 0
