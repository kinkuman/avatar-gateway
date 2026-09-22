"""Hermes固有APIへの認証、機能確認、会話ストリームを一か所に集約します。"""

import json
import re
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

import httpx

from ..config import Settings
REQUIRED_AGENT_FEATURES = (
    "run_submission",
    "run_status",
    "run_events_sse",
    "run_stop",
    "run_approval_response",
    "tool_progress_events",
    "approval_events",
    "session_resources",
    "session_fork",
)
OPTIONAL_AGENT_FEATURES = (
    "skills_api",
)
AVATAR_SESSION_ID_PREFIX = "avatar_gateway_"
_AVATAR_SESSION_ID_PATTERN = re.compile(r"^avatar_gateway_[0-9a-f]{32}$")
_HERMES_RUN_ID_PATTERN = re.compile(r"^run_[0-9a-f]{32}$")
_SESSION_LIST_SCAN_LIMIT = 5_000


class HermesError(RuntimeError):
    """Hermesへの接続・応答異常を、秘密情報を含まない利用者向けエラーへ統一します。"""


class HermesSessionNotFoundError(HermesError):
    """Avatar Gatewayが所有するHermesセッションを参照できない場合に使います。"""


class HermesConflictError(HermesError):
    """Run状態が既に変わり、要求された操作を安全に適用できない場合に使います。"""


@dataclass(frozen=True)
class HermesSession:
    """Hermesのセッション情報から、Avatar Gatewayが画面へ公開する項目だけを保持します。"""

    data: Mapping[str, Any]

    @classmethod
    def from_response(cls, payload: Any) -> "HermesSession":
        """Hermesの可変JSONを検証し、system prompt等を含まない表現へ変換します。"""
        if not isinstance(payload, dict):
            raise HermesError("Hermes Sessionの応答形式が正しくありません")
        session_id = payload.get("id")
        if not isinstance(session_id, str) or not session_id:
            raise HermesError("Hermes SessionにIDがありません")

        safe_keys = (
            "id",
            "source",
            "model",
            "title",
            "started_at",
            "ended_at",
            "end_reason",
            "message_count",
            "tool_call_count",
            "input_tokens",
            "output_tokens",
            "cache_read_tokens",
            "cache_write_tokens",
            "reasoning_tokens",
            "estimated_cost_usd",
            "actual_cost_usd",
            "api_call_count",
            "parent_session_id",
            "last_active",
            "preview",
            "has_system_prompt",
            "has_model_config",
        )
        return cls({key: payload.get(key) for key in safe_keys if key in payload})

    @property
    def id(self) -> str:
        """検証済みのHermesセッションIDを返します。"""
        return str(self.data["id"])

    def to_public_dict(self) -> dict[str, Any]:
        """許可済み項目だけを新しい辞書としてブラウザへ渡します。"""
        return dict(self.data)


@dataclass(frozen=True)
class HermesSessionMessage:
    """内部推論と生のツール引数を除いた、セッション履歴の一件を保持します。"""

    data: Mapping[str, Any]

    @classmethod
    def from_response(cls, payload: Any) -> "HermesSessionMessage | None":
        """systemメッセージを除外し、安全な会話履歴だけへ変換します。"""
        if not isinstance(payload, dict):
            raise HermesError("Hermes Sessionメッセージの応答形式が正しくありません")
        role = payload.get("role")
        if role == "system":
            return None
        if role not in {"user", "assistant", "tool"}:
            raise HermesError("Hermes Sessionメッセージのroleが正しくありません")

        safe_keys = (
            "id",
            "session_id",
            "role",
            "content",
            "tool_call_id",
            "tool_name",
            "timestamp",
            "token_count",
            "finish_reason",
        )
        return cls({key: payload.get(key) for key in safe_keys if key in payload})

    def to_public_dict(self) -> dict[str, Any]:
        """reasoningやtool_callsを含まない会話履歴を返します。"""
        return dict(self.data)


@dataclass(frozen=True)
class HermesSessionPage:
    """Avatar Gateway所有セッションだけを含むページング結果です。"""

    sessions: tuple[HermesSession, ...]
    limit: int
    offset: int
    has_more: bool

    def to_public_dict(self) -> dict[str, Any]:
        """FastAPIがJSON化できる一覧応答へ変換します。"""
        return {
            "data": [session.to_public_dict() for session in self.sessions],
            "limit": self.limit,
            "offset": self.offset,
            "has_more": self.has_more,
        }


@dataclass(frozen=True)
class HermesSkill:
    """Hermesが利用できるSkillの公開メタデータだけを保持します。"""

    name: str
    description: str
    category: str

    @classmethod
    def from_response(cls, payload: Any) -> "HermesSkill":
        """任意のSkill応答から、画面表示に必要な文字列だけを検証します。"""
        if not isinstance(payload, dict):
            raise HermesError("Hermes Skill一覧の応答形式が正しくありません")
        name = payload.get("name")
        if not isinstance(name, str) or not name.strip():
            raise HermesError("Hermes Skillに名前がありません")
        description = payload.get("description")
        category = payload.get("category")
        if description is not None and not isinstance(description, str):
            raise HermesError("Hermes Skillの説明が正しくありません")
        if category is not None and not isinstance(category, str):
            raise HermesError("Hermes Skillの分類が正しくありません")
        return cls(
            name=name.strip(),
            description=(description or "").strip(),
            category=(category or "").strip(),
        )

    def to_public_dict(self) -> dict[str, str]:
        """Skill本文やローカルパスを含めず、安全な一覧項目を返します。"""
        return {
            "name": self.name,
            "description": self.description,
            "category": self.category,
        }


@dataclass(frozen=True)
class HermesToolset:
    """Hermes API Serverが公開するToolsetの有効状態とツール名を保持します。"""

    name: str
    label: str
    description: str
    enabled: bool
    configured: bool
    tools: tuple[str, ...]

    @classmethod
    def from_response(cls, payload: Any) -> "HermesToolset":
        """Toolset応答を検証し、秘密値を含まない参照用データへ変換します。"""
        if not isinstance(payload, dict):
            raise HermesError("Hermes Toolset一覧の応答形式が正しくありません")
        name = payload.get("name")
        label = payload.get("label")
        description = payload.get("description")
        raw_tools = payload.get("tools")
        if not isinstance(name, str) or not name.strip() or not isinstance(raw_tools, list):
            raise HermesError("Hermes Toolset一覧の応答形式が正しくありません")
        if label is not None and not isinstance(label, str):
            raise HermesError("Hermes Toolsetの表示名が正しくありません")
        if description is not None and not isinstance(description, str):
            raise HermesError("Hermes Toolsetの説明が正しくありません")
        tools: list[str] = []
        for tool in raw_tools:
            if not isinstance(tool, str) or not tool.strip():
                raise HermesError("Hermes Toolsetのツール名が正しくありません")
            tools.append(tool.strip())
        return cls(
            name=name.strip(),
            label=(label or name).strip(),
            description=(description or "").strip(),
            enabled=payload.get("enabled") is True,
            configured=payload.get("configured") is True,
            tools=tuple(tools),
        )

    def to_public_dict(self) -> dict[str, Any]:
        """設定値を出さず、利用可否と展開後のツール名だけを返します。"""
        return {
            "name": self.name,
            "label": self.label,
            "description": self.description,
            "enabled": self.enabled,
            "configured": self.configured,
            "tools": list(self.tools),
        }


@dataclass(frozen=True)
class HermesCapabilities:
    """Avatar Gatewayが利用するHermes機能だけを検証済みの値として保持します。"""

    platform: str
    model: str
    auth_required: bool
    features: Mapping[str, bool]

    @classmethod
    def from_response(cls, payload: Any) -> "HermesCapabilities":
        """外部APIの任意JSONから、安全に参照できるCapabilitiesを組み立てます。"""
        if not isinstance(payload, dict):
            raise HermesError("Hermes Capabilitiesの応答形式が正しくありません")

        raw_features = payload.get("features")
        if not isinstance(raw_features, dict):
            raise HermesError("Hermes Capabilitiesにfeaturesがありません")

        raw_auth = payload.get("auth")
        auth_required = bool(raw_auth.get("required")) if isinstance(raw_auth, dict) else False
        features = {
            name: raw_features.get(name) is True
            for name in (*REQUIRED_AGENT_FEATURES, *OPTIONAL_AGENT_FEATURES)
        }
        return cls(
            platform=str(payload.get("platform") or ""),
            model=str(payload.get("model") or ""),
            auth_required=auth_required,
            features=features,
        )

    @property
    def missing_required_features(self) -> tuple[str, ...]:
        """Hermesネイティブな作業UIに不足している必須機能を返します。"""
        return tuple(name for name in REQUIRED_AGENT_FEATURES if not self.features.get(name, False))

    def to_public_dict(self) -> dict[str, Any]:
        """APIキーや内部設定を含めず、ブラウザの機能判定に必要な情報だけを返します。"""
        return {
            "platform": self.platform,
            "model": self.model,
            "auth_required": self.auth_required,
            "features": dict(self.features),
            "missing_required_features": list(self.missing_required_features),
        }


class HermesClient:
    """Hermes APIのURL・認証・エラー処理を共有する非同期クライアントです。"""

    def __init__(
        self,
        config: Settings,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._config = config
        # テストではネットワークを使わず、実運用と同じHTTP境界を検証できるよう差し替えます。
        self._transport = transport
        # 既存の.envに /v1 が含まれていても、/api/sessions等を同じサーバーへ向けられるようにします。
        base_url = config.hermes_base_url.rstrip("/")
        self._server_base_url = base_url[:-3] if base_url.endswith("/v1") else base_url

    def _url(self, path: str) -> str:
        """Hermesサーバールートと絶対APIパスを重複なく結合します。"""
        return f"{self._server_base_url}/{path.lstrip('/')}"

    def _headers(self) -> dict[str, str]:
        """秘密情報をペイロードやURLへ混ぜず、Bearerヘッダーだけに限定します。"""
        if not self._config.hermes_api_key:
            raise HermesError("HERMES_API_KEYが設定されていません")
        return {"Authorization": f"Bearer {self._config.hermes_api_key}"}

    @staticmethod
    def _require_owned_session_id(session_id: str) -> None:
        """他経路のHermesセッションをAvatar Gateway経由で参照させないよう境界を固定します。"""
        if not _AVATAR_SESSION_ID_PATTERN.fullmatch(session_id):
            raise HermesSessionNotFoundError("Avatar Gatewayのセッションが見つかりません")

    @staticmethod
    def _require_run_id(run_id: str) -> None:
        """上流URLへ埋め込むRun IDをHermesの生成形式だけに制限します。"""
        if not _HERMES_RUN_ID_PATTERN.fullmatch(run_id):
            raise HermesSessionNotFoundError("Avatar GatewayのRunが見つかりません")

    @staticmethod
    def _api_error(status_code: int, operation: str) -> HermesError:
        """Hermesの応答本文を外部へ転送せず、状態コードを安全な説明へ変換します。"""
        if status_code in {401, 403}:
            return HermesError("Hermes APIの認証に失敗しました")
        if status_code == 404:
            return HermesError(f"Hermesが{operation}に対応していません")
        if status_code == 429:
            return HermesError("Hermes APIが混雑しています。少し待ってから再試行してください")
        if status_code >= 500:
            return HermesError("Hermes APIで内部エラーが発生しました")
        return HermesError(f"Hermes APIリクエストに失敗しました ({status_code})")

    async def _request_json(
        self,
        method: str,
        path: str,
        *,
        operation: str,
        params: Mapping[str, Any] | None = None,
        body: Mapping[str, Any] | None = None,
        not_found_message: str | None = None,
        conflict_message: str | None = None,
    ) -> dict[str, Any]:
        """HermesのJSON APIに共通する認証、短いタイムアウト、応答検証を適用します。"""
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(10, connect=2),
                transport=self._transport,
            ) as client:
                response = await client.request(
                    method,
                    self._url(path),
                    headers=self._headers(),
                    params=params,
                    json=body,
                )
        except httpx.HTTPError as exc:
            raise HermesError("Hermesへ接続できません") from exc

        if response.status_code == 404 and not_found_message:
            raise HermesSessionNotFoundError(not_found_message)
        if response.status_code == 409 and conflict_message:
            raise HermesConflictError(conflict_message)
        if response.status_code >= 400:
            raise self._api_error(response.status_code, operation)
        try:
            payload = response.json()
        except json.JSONDecodeError as exc:
            raise HermesError(f"Hermes {operation}の応答形式が正しくありません") from exc
        if not isinstance(payload, dict):
            raise HermesError(f"Hermes {operation}の応答形式が正しくありません")
        return payload

    async def get_capabilities(self) -> HermesCapabilities:
        """Hermes専用UIに必要な機能を、短い接続待ち時間で取得します。"""
        payload = await self._request_json(
            "GET",
            "/v1/capabilities",
            operation="Capabilities API",
        )
        return HermesCapabilities.from_response(payload)

    async def list_sessions(self, limit: int = 50, offset: int = 0) -> HermesSessionPage:
        """HermesのAPI Serverセッションから、Avatar Gateway所有分だけをページングして返します。"""
        target_count = offset + limit + 1
        owned: list[HermesSession] = []
        hermes_offset = 0
        upstream_has_more = True

        # HermesはID接頭辞で絞り込めないため、sourceで狭めてから安全な所有IDだけを採用します。
        while upstream_has_more and hermes_offset < _SESSION_LIST_SCAN_LIMIT and len(owned) < target_count:
            payload = await self._request_json(
                "GET",
                "/api/sessions",
                operation="Session一覧API",
                params={
                    "source": "api_server",
                    "include_children": "true",
                    "limit": 200,
                    "offset": hermes_offset,
                },
            )
            raw_sessions = payload.get("data")
            if not isinstance(raw_sessions, list):
                raise HermesError("Hermes Session一覧の応答形式が正しくありません")

            for raw_session in raw_sessions:
                session = HermesSession.from_response(raw_session)
                if _AVATAR_SESSION_ID_PATTERN.fullmatch(session.id):
                    owned.append(session)

            hermes_offset += len(raw_sessions)
            upstream_has_more = payload.get("has_more") is True
            if not raw_sessions:
                upstream_has_more = False

        page_items = tuple(owned[offset:offset + limit])
        has_more = len(owned) > offset + limit or (
            upstream_has_more and hermes_offset >= _SESSION_LIST_SCAN_LIMIT
        )
        return HermesSessionPage(page_items, limit, offset, has_more)

    async def create_session(self, title: str | None = None) -> HermesSession:
        """system promptを受け付けず、Avatar Gateway所有IDで空のHermesセッションを作成します。"""
        session_id = f"{AVATAR_SESSION_ID_PREFIX}{uuid4().hex}"
        body: dict[str, Any] = {
            "id": session_id,
            "model": self._config.hermes_model,
        }
        if title is not None:
            body["title"] = title
        payload = await self._request_json(
            "POST",
            "/api/sessions",
            operation="Session作成API",
            body=body,
        )
        session = HermesSession.from_response(payload.get("session"))
        if session.id != session_id:
            raise HermesError("Hermes Session作成のIDが一致しません")
        return session

    async def get_session(self, session_id: str) -> HermesSession:
        """Avatar Gatewayが作成した一件のHermesセッションだけを取得します。"""
        self._require_owned_session_id(session_id)
        payload = await self._request_json(
            "GET",
            f"/api/sessions/{session_id}",
            operation="Session取得API",
            not_found_message="Avatar Gatewayのセッションが見つかりません",
        )
        session = HermesSession.from_response(payload.get("session"))
        if session.id != session_id:
            raise HermesError("Hermes Session取得のIDが一致しません")
        return session

    async def end_session(self, session_id: str) -> HermesSession:
        """新しい会話へ移る前に、所有セッションを履歴を残したまま終了扱いにします。"""
        self._require_owned_session_id(session_id)
        payload = await self._request_json(
            "PATCH",
            f"/api/sessions/{session_id}",
            operation="Session終了API",
            body={"end_reason": "user_reset"},
            not_found_message="Avatar Gatewayのセッションが見つかりません",
        )
        session = HermesSession.from_response(payload.get("session"))
        if session.id != session_id:
            raise HermesError("Hermes Session終了のIDが一致しません")
        if session.data.get("ended_at") is None:
            raise HermesError("Hermes Sessionが終了状態になっていません")
        return session

    async def fork_ended_session(self, source_session_id: str) -> HermesSession:
        """終了済みの所有セッションを保存したまま、履歴を引き継ぐ子セッションを作ります。"""
        self._require_owned_session_id(source_session_id)
        source = await self.get_session(source_session_id)
        if source.data.get("ended_at") is None:
            raise HermesConflictError("継続中のセッションは分岐せず、そのまま再開してください")

        fork_id = f"{AVATAR_SESSION_ID_PREFIX}{uuid4().hex}"
        payload = await self._request_json(
            "POST",
            f"/api/sessions/{source_session_id}/fork",
            operation="Session分岐API",
            body={"id": fork_id},
            not_found_message="Avatar Gatewayのセッションが見つかりません",
            conflict_message="セッションを分岐できませんでした。履歴を更新して再試行してください",
        )
        fork = HermesSession.from_response(payload.get("session"))
        if fork.id != fork_id:
            raise HermesError("Hermes Session分岐のIDが一致しません")
        if fork.data.get("parent_session_id") != source_session_id:
            raise HermesError("Hermes Session分岐の親IDが一致しません")
        if "ended_at" not in fork.data or fork.data.get("ended_at") is not None:
            raise HermesError("Hermes Session分岐が継続可能な状態ではありません")
        return fork

    async def get_session_messages(self, session_id: str) -> tuple[HermesSessionMessage, ...]:
        """所有セッションの履歴からsystemメッセージと内部推論を除いて取得します。"""
        self._require_owned_session_id(session_id)
        payload = await self._request_json(
            "GET",
            f"/api/sessions/{session_id}/messages",
            operation="SessionメッセージAPI",
            not_found_message="Avatar Gatewayのセッションが見つかりません",
        )
        raw_messages = payload.get("data")
        if not isinstance(raw_messages, list):
            raise HermesError("Hermes Sessionメッセージの応答形式が正しくありません")

        messages: list[HermesSessionMessage] = []
        for raw_message in raw_messages:
            message = HermesSessionMessage.from_response(raw_message)
            if message is not None:
                messages.append(message)
        return tuple(messages)

    async def delete_ended_session(self, session_id: str) -> None:
        """終了済みの所有セッションだけを、事前状態確認後に完全削除します。"""
        self._require_owned_session_id(session_id)
        session = await self.get_session(session_id)
        if session.data.get("ended_at") is None:
            raise HermesConflictError("継続中のセッションは削除できません。先に終了してください")
        payload = await self._request_json(
            "DELETE",
            f"/api/sessions/{session_id}",
            operation="Session削除API",
            not_found_message="Avatar Gatewayのセッションが見つかりません",
            conflict_message="セッションを削除できませんでした。履歴を更新して再試行してください",
        )
        if payload.get("id") != session_id or payload.get("deleted") is not True:
            raise HermesError("Hermes Session削除の応答形式が正しくありません")

    async def list_skills(self) -> tuple[HermesSkill, ...]:
        """Hermes API Serverから利用可能なSkillの公開情報だけを取得します。"""
        payload = await self._request_json(
            "GET",
            "/v1/skills",
            operation="Skill一覧API",
        )
        raw_items = payload.get("data")
        if not isinstance(raw_items, list):
            raise HermesError("Hermes Skill一覧の応答形式が正しくありません")
        return tuple(HermesSkill.from_response(item) for item in raw_items)

    async def list_toolsets(self) -> tuple[HermesToolset, ...]:
        """Hermes API ServerのToolsetと展開後ツールを読み取り専用で取得します。"""
        payload = await self._request_json(
            "GET",
            "/v1/toolsets",
            operation="Toolset一覧API",
        )
        raw_items = payload.get("data")
        if not isinstance(raw_items, list):
            raise HermesError("Hermes Toolset一覧の応答形式が正しくありません")
        return tuple(HermesToolset.from_response(item) for item in raw_items)

    async def start_run(
        self,
        session_id: str,
        user_input: str,
        conversation_history: list[dict[str, str]],
        instructions: str | None = None,
    ) -> dict[str, Any]:
        """所有セッションと明示的な履歴を渡し、Hermes Runを非同期で開始します。"""
        self._require_owned_session_id(session_id)
        body: dict[str, Any] = {
            "input": user_input,
            "session_id": session_id,
            "model": self._config.hermes_model,
            "conversation_history": conversation_history,
        }
        if instructions:
            body["instructions"] = instructions
        payload = await self._request_json(
            "POST",
            "/v1/runs",
            operation="Run開始API",
            body=body,
        )
        run_id = payload.get("run_id")
        if not isinstance(run_id, str) or not _HERMES_RUN_ID_PATTERN.fullmatch(run_id):
            raise HermesError("Hermes Run開始の応答に正しいRun IDがありません")
        return {"run_id": run_id, "status": str(payload.get("status") or "started")}

    async def get_run(self, run_id: str) -> dict[str, Any]:
        """Hermes Runの安全な状態項目だけをポーリング用に取得します。"""
        self._require_run_id(run_id)
        payload = await self._request_json(
            "GET",
            f"/v1/runs/{run_id}",
            operation="Run状態API",
            not_found_message="Avatar GatewayのRunが見つかりません",
        )
        if payload.get("run_id") != run_id:
            raise HermesError("Hermes Run状態APIのRun IDが一致しません")
        safe_keys = (
            "object",
            "run_id",
            "status",
            "created_at",
            "updated_at",
            "session_id",
            "model",
            "last_event",
            "output",
            "usage",
            "error",
        )
        return {key: payload.get(key) for key in safe_keys if key in payload}

    async def stream_run_events(self, run_id: str) -> AsyncIterator[dict[str, Any]]:
        """Hermesの一購読者向けRun SSEから、構造化JSONイベントを順番に取り出します。"""
        self._require_run_id(run_id)
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(None, connect=10),
                transport=self._transport,
            ) as client:
                async with client.stream(
                    "GET",
                    self._url(f"/v1/runs/{run_id}/events"),
                    headers=self._headers(),
                ) as response:
                    if response.status_code == 404:
                        raise HermesSessionNotFoundError("Avatar GatewayのRunが見つかりません")
                    if response.status_code >= 400:
                        raise self._api_error(response.status_code, "RunイベントAPI")

                    async for line in response.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if not data:
                            continue
                        try:
                            event = json.loads(data)
                        except json.JSONDecodeError as exc:
                            raise HermesError("Hermes Runイベントの応答形式が正しくありません") from exc
                        if not isinstance(event, dict) or not isinstance(event.get("event"), str):
                            raise HermesError("Hermes Runイベントの応答形式が正しくありません")
                        yield event
        except httpx.HTTPError as exc:
            raise HermesError("Hermes Runイベントへ接続できません") from exc

    async def stop_run(self, run_id: str) -> dict[str, Any]:
        """Hermesエージェント自体へ停止要求を送り、受付状態だけを安全に返します。"""
        self._require_run_id(run_id)
        payload = await self._request_json(
            "POST",
            f"/v1/runs/{run_id}/stop",
            operation="Run停止API",
            not_found_message="Avatar GatewayのRunが見つかりません",
        )
        return {
            "run_id": run_id,
            "status": str(payload.get("status") or "stopping"),
        }

    async def respond_to_run_approval(self, run_id: str, choice: str) -> dict[str, Any]:
        """承認待ちRunへ一件だけ回答し、Hermesが解決した件数を検証して返します。"""
        self._require_run_id(run_id)
        if choice not in {"once", "session", "always", "deny"}:
            raise HermesError("承認回答が正しくありません")
        payload = await self._request_json(
            "POST",
            f"/v1/runs/{run_id}/approval",
            operation="Run承認API",
            body={"choice": choice},
            not_found_message="Avatar GatewayのRunが見つかりません",
            conflict_message="この承認要求は既に解決済みか、期限切れです",
        )
        resolved = payload.get("resolved")
        if not isinstance(resolved, int) or isinstance(resolved, bool) or resolved < 1:
            raise HermesError("Hermes Run承認APIの応答形式が正しくありません")
        return {
            "run_id": run_id,
            "choice": choice,
            "resolved": resolved,
        }
