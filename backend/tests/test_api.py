"""外部エンジンなしでも設定確認と入力検証が壊れていないことを確認します。"""

import asyncio
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app import main as main_module
from app.main import health
from app.models import (
    HermesConversationRequest,
    HermesRunApprovalRequest,
    HermesRunCreateRequest,
    HermesSessionCreateRequest,
    SpeechEvent,
)
from app.services.hermes import (
    HermesCapabilities,
    HermesConflictError,
    HermesSession,
    HermesSessionMessage,
    HermesSessionNotFoundError,
    HermesSessionPage,
    HermesSkill,
    HermesToolset,
)
from app.services.motion_tags import MotionCatalog


def test_raw_assistant_output_is_logged_before_presentation(caplog: pytest.LogCaptureFixture) -> None:
    """読み上げ範囲を調査できるよう、制御タグ付きの生応答がINFOログへ残ることを確認します。"""
    raw_output = "[motion:none] [speech]最初の文。[/speech] タグ外の文。"
    caplog.set_level("INFO", logger="uvicorn.error.avatar_gateway")

    main_module._log_raw_assistant_output(raw_output)

    assert raw_output in caplog.text
    assert "Hermes raw assistant output BEGIN" in caplog.text
    assert "Hermes raw assistant output END" in caplog.text


def test_agent_speech_instruction_distinguishes_conversation_and_tool_results() -> None:
    """Markdownの区分により、通常会話とツール前後の発話規則を明確に分けます。"""
    instructions = main_module._agent_response_instructions(MotionCatalog((), None))

    assert instructions.startswith("# アバター制御規則")
    assert '[avatar]{"v":1,"motion":"none","expression":"neutral"}[/avatar]' in instructions
    assert "- `angry`:" in instructions
    assert "# 読み上げ規則" in instructions
    assert "## 通常会話" in instructions
    assert "最初から最後まですべて" in instructions
    assert "最初の一文だけで `[/speech]` を閉じない" in instructions
    assert "`[speech]` の外に会話の続きを残さない" in instructions
    assert "## ツール実行前" in instructions
    assert "## ツール実行後" in instructions
    assert "結果の短い結論だけ" in instructions
    assert "ユーザー命令の復唱" in instructions
    assert "ファイルパス" in instructions


@pytest.mark.asyncio
async def test_health_returns_runtime_capabilities(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """起動確認APIがUIに必要な基本情報を返すことを検証します。"""
    async def fake_capabilities(_self) -> HermesCapabilities:
        """外部Hermesなしで、対応済みサーバーの機能応答を再現します。"""
        return HermesCapabilities(
            platform="hermes-agent",
            model="hermes-agent",
            auth_required=True,
            features={
                "run_submission": True,
                "run_status": True,
                "run_events_sse": True,
                "run_stop": True,
                "run_approval_response": True,
                "tool_progress_events": True,
                "approval_events": True,
                "session_resources": True,
                "session_fork": True,
            },
        )

    monkeypatch.setattr(main_module.HermesClient, "get_capabilities", fake_capabilities)
    monkeypatch.setattr(
        main_module,
        "settings",
        replace(
            main_module.settings,
            hermes_api_key="test-secret",
            vrm_file="はむ子.vrm",
            stt_model_dir=tmp_path / "whisper",
            local_assets_dir=tmp_path / "local-assets",
        ),
    )
    response = await health()
    assert response["status"] == "ok"
    assert response["hermes"]["status"] == "ready"
    assert response["hermes"]["capabilities"]["features"]["run_submission"] is True
    assert response["stt"] == {
        "enabled": True,
        "available": False,
        "model": "small",
        "device": "cpu",
        "compute_type": "int8",
        "message": "Whisperモデルが未導入です。READMEの音声認識モデル導入手順を実行してください。",
    }
    assert response["vrm_available"] is True
    assert response["vrm_url"] == "/assets/vrm/はむ子.vrm"
    assert response["generating_motion"] == "hands_behind_back"
    assert {motion["name"] for motion in response["motions"]} == {
        "nod",
        "lean_forward",
        "hands_behind_back",
        "energetic_raise",
        "put_your_hands_up",
        "bow",
        "deep_bow",
        "lightly_spread_arms",
        "sexy_pose",
        "cute_standing",
        "cute_confident",
        "small_open_arms",
        "extend_hands",
        "salute",
        "gentle_open_arms",
        "please",
        "wave",
        "crossed_arms",
        "angry_pose",
        "nervous_pose",
        "hopping_vampire_pose",
        "strange_pose",
        "zua_pose",
        "bat_pose",
        "maru_pose",
        "thinking_pose",
        "inspiration_pose",
    }
    please = next(motion for motion in response["motions"] if motion["name"] == "please")
    assert please["playback"] == "pose"
    assert please["exit_duration_seconds"] == 1.0
    assert all(
        motion["url"].startswith(("/assets/motions/", "/local-assets/motions/"))
        for motion in response["motions"]
    )
    assert response["motion_catalog_error"] is None


@pytest.mark.asyncio
async def test_health_reports_incompatible_hermes(monkeypatch: pytest.MonkeyPatch) -> None:
    """接続できても必須機能が欠けるHermesを、作業UI利用可能とは表示しません。"""
    async def fake_capabilities(_self) -> HermesCapabilities:
        """Run停止だけが不足する古いHermesを再現します。"""
        return HermesCapabilities(
            platform="hermes-agent",
            model="hermes-agent",
            auth_required=True,
            features={
                "run_submission": True,
                "run_status": True,
                "run_events_sse": True,
                "run_stop": False,
                "run_approval_response": True,
                "tool_progress_events": True,
                "approval_events": True,
                "session_resources": True,
                "session_fork": True,
            },
        )

    monkeypatch.setattr(main_module.HermesClient, "get_capabilities", fake_capabilities)
    monkeypatch.setattr(
        main_module,
        "settings",
        replace(main_module.settings, hermes_api_key="test-secret"),
    )

    response = await health()

    assert response["status"] == "ok"
    assert response["hermes"]["status"] == "incompatible"
    assert response["hermes"]["capabilities"]["missing_required_features"] == ["run_stop"]


def test_conversation_rejects_blank_input() -> None:
    """空白だけの入力がHermes Runを無駄に作らないことを検証します。"""
    with pytest.raises(ValidationError):
        HermesConversationRequest(input="   ")


def test_conversation_rejects_legacy_messages_payload() -> None:
    """撤去したChat Completions形式を会話APIへ再導入できないことを確認します。"""
    with pytest.raises(ValidationError):
        HermesConversationRequest.model_validate({
            "input": "調べて",
            "messages": [{"role": "user", "content": "旧形式"}],
        })


def test_conversation_uses_only_hermes_specific_route() -> None:
    """旧チャット経路を公開せず、Hermes専用の会話経路だけを登録します。"""
    paths = {route.path for route in main_module.app.routes}

    assert "/api/hermes/conversation/stream" in paths
    assert "/api/chat/stream" not in paths


def test_session_create_rejects_internal_fields_and_blank_title() -> None:
    """ブラウザから任意IDやsystem promptをHermesへ渡せないことを確認します。"""
    with pytest.raises(ValidationError):
        HermesSessionCreateRequest(title="   ")
    with pytest.raises(ValidationError):
        HermesSessionCreateRequest.model_validate({
            "title": "作業用",
            "system_prompt": "override",
        })


@pytest.mark.asyncio
async def test_session_routes_return_sanitized_client_results(monkeypatch: pytest.MonkeyPatch) -> None:
    """中継APIがHermesClientの検証済みセッションと履歴だけを返します。"""
    session_id = "avatar_gateway_0123456789abcdef0123456789abcdef"
    session = HermesSession({"id": session_id, "title": "作業用"})
    messages = (
        HermesSessionMessage({"role": "user", "content": "調べて"}),
        HermesSessionMessage({
            "role": "assistant",
            "content": "",
            "tool_calls": [{"type": "function", "function": {"name": "terminal"}}],
        }),
        HermesSessionMessage({"role": "assistant", "content": "確認します"}),
    )

    async def fake_list(_self, limit: int, offset: int) -> HermesSessionPage:
        """一覧中継がページ指定を保つことも同時に確認します。"""
        return HermesSessionPage((session,), limit, offset, False)

    async def fake_create(_self, title: str | None) -> HermesSession:
        assert title == "作業用"
        return session

    async def fake_get(_self, requested_id: str) -> HermesSession:
        assert requested_id == session_id
        return session

    async def fake_end(_self, requested_id: str) -> HermesSession:
        assert requested_id == session_id
        return HermesSession({
            "id": session_id,
            "ended_at": 1_785_024_000,
            "end_reason": "user_reset",
        })

    async def fake_fork(_self, requested_id: str) -> HermesSession:
        assert requested_id == session_id
        return HermesSession({
            "id": "avatar_gateway_fedcba9876543210fedcba9876543210",
            "parent_session_id": session_id,
            "ended_at": None,
        })

    async def fake_messages(_self, requested_id: str) -> tuple[HermesSessionMessage, ...]:
        assert requested_id == session_id
        return messages

    async def fake_delete(_self, requested_id: str) -> None:
        assert requested_id == session_id

    async def fake_skills(_self) -> tuple[HermesSkill, ...]:
        return (HermesSkill("github", "GitHub workflow", "development"),)

    async def fake_toolsets(_self) -> tuple[HermesToolset, ...]:
        return (HermesToolset("web", "Web", "Web tools", True, True, ("web_search",)),)

    monkeypatch.setattr(main_module.HermesClient, "list_sessions", fake_list)
    monkeypatch.setattr(main_module.HermesClient, "create_session", fake_create)
    monkeypatch.setattr(main_module.HermesClient, "get_session", fake_get)
    monkeypatch.setattr(main_module.HermesClient, "end_session", fake_end)
    monkeypatch.setattr(main_module.HermesClient, "fork_ended_session", fake_fork)
    monkeypatch.setattr(main_module.HermesClient, "get_session_messages", fake_messages)
    monkeypatch.setattr(main_module.HermesClient, "delete_ended_session", fake_delete)
    monkeypatch.setattr(main_module.HermesClient, "list_skills", fake_skills)
    monkeypatch.setattr(main_module.HermesClient, "list_toolsets", fake_toolsets)

    listed = await main_module.list_hermes_sessions(limit=10, offset=2)
    created = await main_module.create_hermes_session(HermesSessionCreateRequest(title=" 作業用 "))
    got = await main_module.get_hermes_session(session_id)
    ended = await main_module.end_hermes_session(session_id)
    forked = await main_module.fork_hermes_session(session_id)
    history = await main_module.get_hermes_session_messages(session_id)
    deleted = await main_module.delete_hermes_session(session_id)
    skills = await main_module.list_hermes_skills()
    toolsets = await main_module.list_hermes_toolsets()

    assert listed == {
        "data": [{"id": session_id, "title": "作業用"}],
        "limit": 10,
        "offset": 2,
        "has_more": False,
    }
    assert created == {"session": {"id": session_id, "title": "作業用"}}
    assert got == created
    assert ended == {
        "session": {
            "id": session_id,
            "ended_at": 1_785_024_000,
            "end_reason": "user_reset",
        },
    }
    assert forked == {
        "session": {
            "id": "avatar_gateway_fedcba9876543210fedcba9876543210",
            "parent_session_id": session_id,
            "ended_at": None,
        },
    }
    assert history == {
        "session_id": session_id,
        "data": [
            {"role": "user", "content": "調べて"},
            {"role": "assistant", "content": "確認します"},
        ],
    }
    assert deleted == {"id": session_id, "deleted": True}
    assert skills == {
        "data": [{"name": "github", "description": "GitHub workflow", "category": "development"}],
    }
    assert toolsets == {
        "data": [{
            "name": "web",
            "label": "Web",
            "description": "Web tools",
            "enabled": True,
            "configured": True,
            "tools": ["web_search"],
        }],
    }


@pytest.mark.asyncio
async def test_session_route_maps_unowned_id_to_404(monkeypatch: pytest.MonkeyPatch) -> None:
    """所有外セッションを上流障害ではなく、存在しないリソースとして返します。"""
    async def fake_get(_self, _session_id: str) -> HermesSession:
        raise HermesSessionNotFoundError("Avatar Gatewayのセッションが見つかりません")

    monkeypatch.setattr(main_module.HermesClient, "get_session", fake_get)

    with pytest.raises(HTTPException) as captured:
        await main_module.get_hermes_session("agent:main:slack:dm:123")

    assert captured.value.status_code == 404


@pytest.mark.asyncio
async def test_expired_approval_route_maps_conflict_to_409(monkeypatch: pytest.MonkeyPatch) -> None:
    """期限切れ承認を上流障害ではなく、UIが説明できる競合状態として返します。"""
    run_id = "run_0123456789abcdef0123456789abcdef"

    class FakeCoordinator:
        """承認期限切れだけをHTTP境界で再現します。"""

        async def respond_to_approval(self, _run_id: str, _choice: str) -> dict:
            raise HermesConflictError("この承認要求は既に解決済みか、期限切れです")

    monkeypatch.setattr(main_module, "run_coordinator", FakeCoordinator())

    with pytest.raises(HTTPException) as captured:
        await main_module.respond_to_hermes_run_approval(
            run_id,
            HermesRunApprovalRequest(choice="once"),
        )

    assert captured.value.status_code == 409


def test_run_create_rejects_unowned_session_and_blank_input() -> None:
    """Run開始境界で所有外IDと空の作業入力を拒否します。"""
    with pytest.raises(ValidationError):
        HermesRunCreateRequest(session_id="agent:main:slack:dm:123", input="作業して")
    with pytest.raises(ValidationError):
        HermesRunCreateRequest(
            session_id="avatar_gateway_0123456789abcdef0123456789abcdef",
            input="   ",
        )


def test_run_approval_rejects_unknown_choice_and_extra_scope() -> None:
    """ブラウザから未定義の回答やresolve_allを承認APIへ持ち込めないことを確認します。"""
    with pytest.raises(ValidationError):
        HermesRunApprovalRequest(choice="approve")
    with pytest.raises(ValidationError):
        HermesRunApprovalRequest.model_validate({"choice": "once", "resolve_all": True})


@pytest.mark.asyncio
async def test_run_routes_start_report_and_stream_cached_events(monkeypatch: pytest.MonkeyPatch) -> None:
    """Run中継APIが開始・状態・SSEを同じCoordinatorへ接続します。"""
    session_id = "avatar_gateway_0123456789abcdef0123456789abcdef"
    run_id = "run_0123456789abcdef0123456789abcdef"

    class FakeCoordinator:
        """HTTP境界だけを検証するため、保存済みRunを最小構成で再現します。"""

        async def start_run(self, requested_session_id: str, user_input: str) -> dict:
            assert requested_session_id == session_id
            assert user_input == "作業して"
            return {"run_id": run_id, "session_id": session_id, "status": "started"}

        async def get_or_recover_run(self, requested_run_id: str) -> dict:
            assert requested_run_id == run_id
            return {"run_id": run_id, "session_id": session_id, "status": "completed"}

        async def stream_events(self, requested_run_id: str, after: int = 0):
            assert requested_run_id == run_id
            assert after == 1
            yield {
                "type": "assistant.completed",
                "run_id": run_id,
                "session_id": session_id,
                "sequence": 2,
                "output": "完了",
            }

        async def stop_run(self, requested_run_id: str) -> dict:
            assert requested_run_id == run_id
            return {"run_id": run_id, "session_id": session_id, "status": "stopping"}

        async def respond_to_approval(self, requested_run_id: str, choice: str) -> dict:
            assert requested_run_id == run_id
            assert choice == "once"
            return {
                "run_id": run_id,
                "session_id": session_id,
                "choice": choice,
                "resolved": 1,
                "status": "running",
            }

    monkeypatch.setattr(main_module, "run_coordinator", FakeCoordinator())
    request = HermesRunCreateRequest(session_id=session_id, input=" 作業して ")

    started = await main_module.start_hermes_run(request)
    status = await main_module.get_hermes_run(run_id)
    stopped = await main_module.stop_hermes_run(run_id)
    approved = await main_module.respond_to_hermes_run_approval(
        run_id,
        HermesRunApprovalRequest(choice="once"),
    )
    response = await main_module.stream_hermes_run_events(run_id, after=1)
    body = "".join([
        chunk.decode() if isinstance(chunk, bytes) else chunk
        async for chunk in response.body_iterator
    ])

    assert started["status"] == "started"
    assert status["status"] == "completed"
    assert stopped["status"] == "stopping"
    assert approved["choice"] == "once"
    assert "event: assistant.completed" in body
    assert '"sequence": 2' in body


@pytest.mark.asyncio
async def test_conversation_stream_creates_session_runs_and_syncs_formal_history(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """初回会話をSession+Runへ接続し、完了後にHermes正本を返す一連の境界を確認します。"""
    session_id = "avatar_gateway_0123456789abcdef0123456789abcdef"
    run_id = "run_0123456789abcdef0123456789abcdef"

    class FakeClient:
        """自動作成と正式履歴取得だけを再現し、外部Hermesへの書き込みを避けます。"""

        async def create_session(self) -> HermesSession:
            return HermesSession({"id": session_id})

        async def get_session_messages(self, requested_session_id: str):
            assert requested_session_id == session_id
            return (
                HermesSessionMessage({"role": "user", "content": "調べて"}),
                HermesSessionMessage({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{"type": "function", "function": {"name": "terminal"}}],
                }),
                HermesSessionMessage({"role": "assistant", "content": "[motion:cheer]\n完了"}),
            )

    class FakeCoordinator:
        """Run開始引数とイベント順を検査できる最小のCoordinatorです。"""

        async def start_run(
            self,
            requested_session_id: str,
            user_input: str,
            instructions: str | None,
        ) -> dict:
            assert requested_session_id == session_id
            assert user_input == "調べて"
            assert instructions == "motion instructions"
            return {"run_id": run_id, "status": "started"}

        async def stream_events(self, requested_run_id: str):
            assert requested_run_id == run_id
            yield {"type": "assistant.delta", "delta": "完了", "sequence": 1}
            yield {"type": "assistant.completed", "output": "完了", "sequence": 2}

    client = FakeClient()
    monkeypatch.setattr(main_module, "HermesClient", lambda _settings: client)
    monkeypatch.setattr(main_module, "run_coordinator", FakeCoordinator())

    events = [
        event
        async for event in main_module._stream_agent_run(
            HermesConversationRequest(input="調べて"),
            "motion instructions",
        )
    ]

    assert [name for name, _data in events] == [
        "session.ready",
        "run.started",
        "assistant.delta",
        "assistant.completed",
        "session.messages",
    ]
    assert events[0][1] == {"session_id": session_id, "created": True}
    # 低レベルRun列はHermes正本を保持し、公開会話経路で表示用フィルタを適用します。
    assert events[-1][1]["data"][1]["content"] == ""
    assert events[-1][1]["data"][2]["content"] == "[motion:cheer]\n完了"


@pytest.mark.asyncio
async def test_completed_speech_removes_temporary_chunk(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """再生済みの文単位WAVだけを削除し、一時音声の増加を抑えることを確認します。"""
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    audio_path = audio_dir / "utterance-1.wav"
    audio_path.write_bytes(b"wav")
    monkeypatch.setattr(main_module, "settings", replace(main_module.settings, audio_dir=audio_dir))

    await main_module.speech_event(SpeechEvent(
        type="speech.completed",
        utterance_id="utterance-1",
        sequence_id="sequence-1",
        segment_index=0,
        played_ms=100,
    ))

    assert not audio_path.exists()


@pytest.mark.asyncio
async def test_cancelled_speech_removes_temporary_chunk(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """利用者が中断した未再生WAVも、失敗扱いにせず同じ後始末経路で削除します。"""
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    audio_path = audio_dir / "utterance-cancelled.wav"
    audio_path.write_bytes(b"wav")
    monkeypatch.setattr(main_module, "settings", replace(main_module.settings, audio_dir=audio_dir))

    await main_module.speech_event(SpeechEvent(
        type="speech.cancelled",
        utterance_id="utterance-cancelled",
        sequence_id="sequence-1",
        segment_index=1,
        reason="利用者が会話を中断しました",
    ))

    assert not audio_path.exists()


@pytest.mark.asyncio
async def test_cancel_speech_sequence_stops_only_registered_tts_worker() -> None:
    """読み上げ停止が対象TTSワーカーを中断し、Hermes用タスクへ波及しないことを確認します。"""
    sequence_id = "0123456789abcdef0123456789abcdef"
    worker = asyncio.create_task(asyncio.Event().wait())
    main_module.speech_sequence_workers[sequence_id] = worker
    try:
        response = await main_module.cancel_speech_sequence(sequence_id)
        await asyncio.gather(worker, return_exceptions=True)

        assert response.status_code == 200
        assert worker.cancelled()
    finally:
        main_module.speech_sequence_workers.pop(sequence_id, None)
        if not worker.done():
            worker.cancel()


@pytest.mark.asyncio
async def test_cancel_speech_sequence_rejects_invalid_id() -> None:
    """任意パスを音声ワーカーの識別子として受け付けないことを確認します。"""
    with pytest.raises(HTTPException) as exc_info:
        await main_module.cancel_speech_sequence("invalid")

    assert exc_info.value.status_code == 422


def test_speech_event_rejects_unsafe_utterance_id() -> None:
    """一時音声削除でディレクトリ外を参照できるIDを入力境界で拒否します。"""
    with pytest.raises(ValidationError):
        SpeechEvent(type="speech.failed", utterance_id="../outside", reason="test")
