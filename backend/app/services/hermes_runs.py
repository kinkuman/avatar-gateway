"""Hermes Runを単独購読し、安全化したイベントを再接続可能な形で一時保存します。"""

import asyncio
import time
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from typing import Any
from zoneinfo import ZoneInfo

from .daily_state import build_daily_instructions

from .hermes import (
    HermesClient,
    HermesConflictError,
    HermesError,
    HermesSessionMessage,
    HermesSessionNotFoundError,
)


_MAX_ACTIVE_RECORDS = 100
_MAX_EVENTS_PER_RUN = 1_000
_RECOVERY_POLL_INTERVAL_SECONDS = 1.0
_TERMINAL_EVENT_TYPES = {"assistant.completed", "agent.failed", "agent.stopped"}


@dataclass
class _RunRecord:
    """一つのRunについて、複数ブラウザへ再送する最小限の状態を保持します。"""

    run_id: str
    session_id: str
    status: str
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    events: list[dict[str, Any]] = field(default_factory=list)
    next_sequence: int = 1
    finished: bool = False
    recovered: bool = False
    event_history_available: bool = True
    approval_details_available: bool = True
    condition: asyncio.Condition = field(default_factory=asyncio.Condition)
    approval_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    task: asyncio.Task[None] | None = None

    def to_public_dict(self) -> dict[str, Any]:
        """上流の内部オブジェクトを含めず、画面が必要とするRun状態だけを返します。"""
        return {
            "run_id": self.run_id,
            "session_id": self.session_id,
            "status": self.status,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "last_sequence": self.next_sequence - 1,
            "finished": self.finished,
            "recovered": self.recovered,
            "event_history_available": self.event_history_available,
            "approval_details_available": self.approval_details_available,
        }


class HermesRunCoordinator:
    """Hermesの一購読者向けSSEを所有し、Avatar Gatewayのイベントへ変換します。"""

    def __init__(
        self, client_factory: Callable[[], HermesClient], timezone: str = "Asia/Tokyo",
    ) -> None:
        """時刻基準を起動時に検証し、Runごとの会話処理で共有します。"""
        self._timezone = ZoneInfo(timezone)
        self._client_factory = client_factory
        self._records: dict[str, _RunRecord] = {}
        # 状態APIとイベントAPIの同時アクセスでも、同じRunを二重回収しないため直列化します。
        self._recovery_lock = asyncio.Lock()

    @staticmethod
    def _normalize_run_status(value: Any) -> str:
        """Hermesの内部状態名を、Avatar Gatewayが公開する状態集合へ揃えます。"""
        if value in {"queued", "started"}:
            return "started"
        if value in {
            "running",
            "waiting_for_approval",
            "stopping",
            "completed",
            "failed",
            "cancelled",
        }:
            return str(value)
        raise HermesError("Hermes Run状態APIのstatusが正しくありません")

    @staticmethod
    def _terminal_event(status: str) -> dict[str, Any] | None:
        """再取得できない本文を推測せず、確定状態だけを終端イベントへ変換します。"""
        if status == "completed":
            return {"type": "assistant.completed", "output": "", "recovered": True}
        if status == "failed":
            return {"type": "agent.failed", "message": "Hermes Runは失敗しました", "recovered": True}
        if status == "cancelled":
            return {"type": "agent.stopped", "recovered": True}
        return None

    @staticmethod
    def _conversation_history(messages: tuple[HermesSessionMessage, ...]) -> list[dict[str, str]]:
        """Run APIが受け付けるrole/contentだけの履歴へ安全に縮約します。"""
        history: list[dict[str, str]] = []
        for message in messages:
            role = message.data.get("role")
            content = message.data.get("content")
            if role in {"user", "assistant", "tool"} and isinstance(content, str) and content:
                history.append({"role": role, "content": content})
        return history

    @staticmethod
    def _translate_event(raw: dict[str, Any]) -> dict[str, Any] | None:
        """reasoning本文や生ツール引数を落とし、画面用イベントへ明示的に変換します。"""
        event_type = raw.get("event")
        if event_type == "message.delta":
            return {"type": "assistant.delta", "delta": str(raw.get("delta") or "")}
        if event_type == "tool.started":
            return {"type": "tool.started", "tool": str(raw.get("tool") or "")}
        if event_type == "tool.completed":
            return {
                "type": "tool.completed",
                "tool": str(raw.get("tool") or ""),
                "duration": raw.get("duration"),
                "error": raw.get("error") is True,
            }
        if event_type == "reasoning.available":
            # 内部推論本文は保存せず、利用者には一般的な思考中状態だけを通知します。
            return {"type": "agent.thinking"}
        if event_type == "approval.request":
            raw_choices = raw.get("choices")
            choices = raw_choices if isinstance(raw_choices, list) else []
            return {
                "type": "approval.requested",
                "command": str(raw.get("command") or ""),
                "description": str(raw.get("description") or ""),
                "choices": [
                    choice for choice in choices
                    if choice in {"once", "session", "always", "deny"}
                ],
            }
        if event_type == "approval.responded":
            return {
                "type": "approval.responded",
                "choice": str(raw.get("choice") or ""),
                "resolved": raw.get("resolved"),
            }
        if event_type == "run.completed":
            return {
                "type": "assistant.completed",
                "output": str(raw.get("output") or ""),
                "usage": raw.get("usage") if isinstance(raw.get("usage"), dict) else {},
            }
        if event_type == "run.failed":
            return {"type": "agent.failed", "message": str(raw.get("error") or "Runに失敗しました")}
        if event_type == "run.cancelled":
            return {"type": "agent.stopped"}
        return None

    def _prune_records(self) -> None:
        """長時間運用で完了Runが無制限に増えないよう、古い完了記録から削除します。"""
        if len(self._records) < _MAX_ACTIVE_RECORDS:
            return
        finished = sorted(
            (record for record in self._records.values() if record.finished),
            key=lambda record: record.updated_at,
        )
        for record in finished:
            self._records.pop(record.run_id, None)
            if len(self._records) < _MAX_ACTIVE_RECORDS:
                return
        raise HermesError("実行中または保存中のRunが多すぎます")

    async def _append_event(self, record: _RunRecord, event: dict[str, Any]) -> None:
        """連番を付けて保存し、待機中の全ブラウザ購読者を起こします。"""
        async with record.condition:
            stored = {
                **event,
                "run_id": record.run_id,
                "session_id": record.session_id,
                "sequence": record.next_sequence,
                "timestamp": time.time(),
            }
            record.next_sequence += 1
            record.updated_at = stored["timestamp"]
            record.events.append(stored)
            if len(record.events) > _MAX_EVENTS_PER_RUN:
                record.events.pop(0)

            event_type = stored["type"]
            if event_type == "agent.started":
                record.status = "running"
            elif event_type == "approval.requested":
                record.status = "waiting_for_approval"
            elif event_type == "approval.responded":
                record.status = "running"
            elif event_type in {"tool.started", "tool.completed", "agent.thinking", "assistant.delta"}:
                record.status = "running"
            elif event_type in {"run.recovered", "run.status"}:
                record.status = self._normalize_run_status(stored.get("status"))
            elif event_type == "assistant.completed":
                record.status = "completed"
            elif event_type == "agent.failed":
                record.status = "failed"
            elif event_type == "agent.stopped":
                record.status = "cancelled"

            if event_type in _TERMINAL_EVENT_TYPES:
                record.finished = True
            record.condition.notify_all()

    async def _consume_upstream(self, record: _RunRecord, client: HermesClient) -> None:
        """Run開始直後からHermes SSEを所有し、切断も明示的な失敗イベントへ変換します。"""
        try:
            async for raw_event in client.stream_run_events(record.run_id):
                event = self._translate_event(raw_event)
                if event is not None:
                    await self._append_event(record, event)
        except asyncio.CancelledError:
            raise
        except HermesError as exc:
            if not record.finished:
                await self._append_event(record, {"type": "agent.failed", "message": str(exc)})
        finally:
            if not record.finished:
                await self._append_event(
                    record,
                    {"type": "agent.failed", "message": "Hermes Runイベントが完了前に終了しました"},
                )

    async def _poll_recovered_run(self, record: _RunRecord) -> None:
        """失われたSSEを再購読せず、Hermes状態APIだけで回収Runの終端を監視します。"""
        client = self._client_factory()
        while not record.finished:
            await asyncio.sleep(_RECOVERY_POLL_INTERVAL_SECONDS)
            try:
                state = await client.get_run(record.run_id)
            except asyncio.CancelledError:
                raise
            except HermesSessionNotFoundError:
                await self._append_event(
                    record,
                    {
                        "type": "agent.failed",
                        "message": "Hermes側でRun状態を確認できなくなりました",
                        "recovered": True,
                    },
                )
                return
            except HermesError:
                # 一時的な通信障害ではRun失敗と断定せず、次回ポーリングで再確認します。
                continue

            if state.get("session_id") != record.session_id:
                await self._append_event(
                    record,
                    {
                        "type": "agent.failed",
                        "message": "回収したHermes Runのセッションが一致しません",
                        "recovered": True,
                    },
                )
                return

            try:
                status = self._normalize_run_status(state.get("status"))
            except HermesError:
                await self._append_event(
                    record,
                    {
                        "type": "agent.failed",
                        "message": "Hermes側のRun状態を解釈できません",
                        "recovered": True,
                    },
                )
                return
            terminal_event = self._terminal_event(status)
            if terminal_event is not None:
                await self._append_event(record, terminal_event)
                return

            # 停止要求後に上流が一時的にrunningを返しても、画面を作業中へ戻しません。
            if record.status == "stopping" and status in {"started", "running", "waiting_for_approval"}:
                continue
            if status != record.status:
                await self._append_event(
                    record,
                    {
                        "type": "run.status",
                        "status": status,
                        "recovered": True,
                        "event_history_available": False,
                    },
                )

    async def get_or_recover_run(self, run_id: str) -> dict[str, Any]:
        """プロセス内にない所有RunをHermes状態APIから限定情報で回収します。"""
        record = self._records.get(run_id)
        if record is not None:
            return record.to_public_dict()

        async with self._recovery_lock:
            record = self._records.get(run_id)
            if record is not None:
                return record.to_public_dict()

            self._prune_records()
            client = self._client_factory()
            state = await client.get_run(run_id)
            session_id = state.get("session_id")
            if not isinstance(session_id, str):
                raise HermesSessionNotFoundError("Avatar GatewayのRunが見つかりません")
            # Session取得の所有ID検証を再利用し、他クライアントのRunを回収対象にしません。
            await client.get_session(session_id)
            status = self._normalize_run_status(state.get("status"))
            created_at = state.get("created_at")
            updated_at = state.get("updated_at")
            record = _RunRecord(
                run_id=run_id,
                session_id=session_id,
                status=status,
                created_at=(
                    float(created_at)
                    if isinstance(created_at, (int, float)) and not isinstance(created_at, bool)
                    else time.time()
                ),
                updated_at=(
                    float(updated_at)
                    if isinstance(updated_at, (int, float)) and not isinstance(updated_at, bool)
                    else time.time()
                ),
                recovered=True,
                event_history_available=False,
                approval_details_available=False,
            )
            self._records[run_id] = record
            await self._append_event(
                record,
                {
                    "type": "run.recovered",
                    "status": status,
                    "recovered": True,
                    "event_history_available": False,
                    "approval_details_available": False,
                },
            )
            terminal_event = self._terminal_event(status)
            if terminal_event is not None:
                await self._append_event(record, terminal_event)
            else:
                record.task = asyncio.create_task(self._poll_recovered_run(record))
            return record.to_public_dict()

    async def start_run(
        self,
        session_id: str,
        user_input: str,
        instructions: str | None = None,
    ) -> dict[str, Any]:
        """正式履歴を添えてRunを開始し、ブラウザ応答前に上流SSE購読を予約します。"""
        self._prune_records()
        client = self._client_factory()
        await client.get_session(session_id)
        messages = await client.get_session_messages(session_id)
        # 全入力経路で最新時刻を渡し、音声やモーションの既存指示も維持します。
        daily_instructions = build_daily_instructions(messages, self._timezone)
        instructions = "\n\n".join(part for part in (instructions, daily_instructions) if part)
        started = await client.start_run(
            session_id,
            user_input,
            self._conversation_history(messages),
            instructions,
        )
        record = _RunRecord(
            run_id=started["run_id"],
            session_id=session_id,
            status=started["status"],
        )
        self._records[record.run_id] = record
        await self._append_event(record, {"type": "agent.started"})
        record.task = asyncio.create_task(self._consume_upstream(record, client))
        return record.to_public_dict()

    def get_run(self, run_id: str) -> dict[str, Any]:
        """このプロセスが開始したRunだけを状態参照の対象にします。"""
        record = self._records.get(run_id)
        if record is None:
            raise HermesSessionNotFoundError("Avatar GatewayのRunが見つかりません")
        return record.to_public_dict()

    async def stop_run(self, run_id: str) -> dict[str, Any]:
        """所有Runをstoppingへ移し、Hermesの明示的な停止APIを呼びます。"""
        record = self._records.get(run_id)
        if record is None:
            await self.get_or_recover_run(run_id)
            record = self._records[run_id]
        if record.finished:
            return record.to_public_dict()

        await self._append_event(record, {"type": "agent.stopping"})
        record.status = "stopping"
        await self._client_factory().stop_run(run_id)
        return record.to_public_dict()

    async def respond_to_approval(self, run_id: str, choice: str) -> dict[str, Any]:
        """承認待ちの所有Runだけへ回答し、同時クリックによる二重解決を防ぎます。"""
        record = self._records.get(run_id)
        if record is None:
            await self.get_or_recover_run(run_id)
            record = self._records[run_id]

        async with record.approval_lock:
            if not record.approval_details_available:
                raise HermesConflictError(
                    "承認内容を復元できないため回答できません。安全のためRunを中断してください"
                )
            if record.finished or record.status != "waiting_for_approval":
                raise HermesConflictError("この承認要求は既に解決済みか、期限切れです")
            approval_sequence = record.next_sequence - 1
            result = await self._client_factory().respond_to_run_approval(run_id, choice)
            # SSEが未到着の場合だけ暫定更新し、連続する次の承認要求をrunningで上書きしません。
            async with record.condition:
                if (
                    record.next_sequence - 1 == approval_sequence
                    and record.status == "waiting_for_approval"
                ):
                    record.status = "running"
                    record.updated_at = time.time()
            return {
                **result,
                "session_id": record.session_id,
                "status": record.status,
            }

    async def stream_events(
        self,
        run_id: str,
        after: int = 0,
    ) -> AsyncIterator[dict[str, Any] | None]:
        """保存済み連番の次から再送し、その後は新しいイベントまたはkeepaliveを返します。"""
        record = self._records.get(run_id)
        if record is None:
            raise HermesSessionNotFoundError("Avatar GatewayのRunが見つかりません")

        cursor = after
        truncated_notified = False
        while True:
            async with record.condition:
                if record.events and cursor < record.events[0]["sequence"] - 1 and not truncated_notified:
                    truncated_notified = True
                    cursor = record.events[0]["sequence"] - 1
                    event: dict[str, Any] | None = {
                        "type": "run.replay_truncated",
                        "run_id": run_id,
                        "session_id": record.session_id,
                        "sequence": cursor,
                        "timestamp": time.time(),
                    }
                else:
                    pending = [item for item in record.events if item["sequence"] > cursor]
                    if pending:
                        event = pending[0]
                        cursor = event["sequence"]
                    elif record.finished:
                        return
                    else:
                        try:
                            await asyncio.wait_for(record.condition.wait(), timeout=15)
                        except asyncio.TimeoutError:
                            event = None
                        else:
                            continue
            yield event
