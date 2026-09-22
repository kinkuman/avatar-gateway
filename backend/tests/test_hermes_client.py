"""Hermes接続のURL正規化、Capabilities検証、秘密情報を含まないエラーを確認します。"""

from dataclasses import replace
import json

import httpx
import pytest

from app.config import Settings
from app.services.hermes import (
    HermesClient,
    HermesConflictError,
    HermesError,
    HermesSessionNotFoundError,
    REQUIRED_AGENT_FEATURES,
)


OWNED_SESSION_ID = "avatar_gateway_0123456789abcdef0123456789abcdef"
RUN_ID = "run_0123456789abcdef0123456789abcdef"


def _capabilities_payload(**feature_overrides: bool) -> dict:
    """Hermes専用UIが要求する最小Capabilities応答を生成します。"""
    features = {name: True for name in REQUIRED_AGENT_FEATURES}
    features.update(feature_overrides)
    return {
        "object": "hermes.api_server.capabilities",
        "platform": "hermes-agent",
        "model": "hermes-agent",
        "auth": {"type": "bearer", "required": True},
        "features": features,
    }


@pytest.mark.asyncio
async def test_capabilities_normalizes_legacy_v1_base_url() -> None:
    """既存.envの末尾/v1を保ったまま、Hermes固有APIの正しいURLへ接続します。"""
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=_capabilities_payload())

    config = replace(
        Settings(),
        hermes_base_url="http://127.0.0.1:8642/v1",
        hermes_api_key="secret-value",
    )
    capabilities = await HermesClient(config, httpx.MockTransport(handler)).get_capabilities()

    assert str(requests[0].url) == "http://127.0.0.1:8642/v1/capabilities"
    assert requests[0].headers["authorization"] == "Bearer secret-value"
    assert capabilities.missing_required_features == ()
    assert capabilities.to_public_dict()["features"]["run_stop"] is True
    assert "secret-value" not in json.dumps(capabilities.to_public_dict())


@pytest.mark.asyncio
async def test_capabilities_reports_missing_required_feature() -> None:
    """到達可能でもRun停止がないHermesを互換ありとして扱わないことを確認します。"""
    transport = httpx.MockTransport(
        lambda _request: httpx.Response(200, json=_capabilities_payload(run_stop=False)),
    )
    config = replace(Settings(), hermes_api_key="secret-value")

    capabilities = await HermesClient(config, transport).get_capabilities()

    assert capabilities.missing_required_features == ("run_stop",)


@pytest.mark.asyncio
async def test_api_error_does_not_expose_response_body_or_key() -> None:
    """Hermes内部エラーに秘密が含まれても、利用者向け例外へ転送しません。"""
    transport = httpx.MockTransport(
        lambda _request: httpx.Response(500, text="provider failed: token=secret-value"),
    )
    config = replace(Settings(), hermes_api_key="secret-value")

    with pytest.raises(HermesError) as captured:
        await HermesClient(config, transport).get_capabilities()

    message = str(captured.value)
    assert message == "Hermes APIで内部エラーが発生しました"
    assert "secret-value" not in message


@pytest.mark.asyncio
async def test_session_list_filters_other_api_server_sessions() -> None:
    """同じapi_server由来でも、Avatar Gateway所有ID以外を一覧へ出しません。"""
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={
            "object": "list",
            "data": [
                {"id": "api_other_client", "source": "api_server", "title": "Other"},
                {
                    "id": OWNED_SESSION_ID,
                    "source": "api_server",
                    "title": "Avatar session",
                    "system_prompt": "secret prompt",
                    "has_system_prompt": True,
                },
            ],
            "has_more": False,
        })

    config = replace(Settings(), hermes_api_key="secret-value")
    page = await HermesClient(config, httpx.MockTransport(handler)).list_sessions()
    public = page.to_public_dict()

    assert [session["id"] for session in public["data"]] == [OWNED_SESSION_ID]
    assert "system_prompt" not in public["data"][0]
    assert public["data"][0]["has_system_prompt"] is True
    assert requests[0].url.params["source"] == "api_server"
    assert requests[0].url.params["include_children"] == "true"


@pytest.mark.asyncio
async def test_create_session_assigns_owned_id_and_restricts_payload() -> None:
    """利用者指定IDやsystem promptを送らず、所有判定できるIDで作成します。"""
    request_bodies: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        request_bodies.append(body)
        return httpx.Response(201, json={
            "object": "hermes.session",
            "session": {
                "id": body["id"],
                "source": "api_server",
                "model": body["model"],
                "title": body["title"],
            },
        })

    config = replace(Settings(), hermes_api_key="secret-value", hermes_model="hermes-agent")
    session = await HermesClient(config, httpx.MockTransport(handler)).create_session("作業用")

    assert session.id.startswith("avatar_gateway_")
    assert len(session.id) == len("avatar_gateway_") + 32
    assert request_bodies == [{
        "id": session.id,
        "model": "hermes-agent",
        "title": "作業用",
    }]


@pytest.mark.asyncio
async def test_non_owned_session_is_rejected_before_request() -> None:
    """Slackや他クライアントのIDをHermesへ問い合わせる前に拒否します。"""
    request_count = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal request_count
        request_count += 1
        return httpx.Response(200, json={})

    config = replace(Settings(), hermes_api_key="secret-value")
    client = HermesClient(config, httpx.MockTransport(handler))

    with pytest.raises(HermesSessionNotFoundError):
        await client.get_session("agent:main:slack:dm:123")

    assert request_count == 0


@pytest.mark.asyncio
async def test_end_session_marks_owned_session_with_user_reset() -> None:
    """新しい会話への切り替えが、削除ではなく固定理由の終了操作になることを確認します。"""
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={
            "object": "hermes.session",
            "session": {
                "id": OWNED_SESSION_ID,
                "source": "api_server",
                "ended_at": 1_785_024_000,
                "end_reason": "user_reset",
            },
        })

    config = replace(Settings(), hermes_api_key="secret-value")
    session = await HermesClient(config, httpx.MockTransport(handler)).end_session(OWNED_SESSION_ID)

    assert session.to_public_dict()["end_reason"] == "user_reset"
    assert requests[0].method == "PATCH"
    assert str(requests[0].url) == f"http://127.0.0.1:8642/api/sessions/{OWNED_SESSION_ID}"
    assert json.loads(requests[0].content) == {"end_reason": "user_reset"}


@pytest.mark.asyncio
async def test_delete_session_requires_ended_owned_session() -> None:
    """削除前に終了状態を確認し、継続中の会話を誤って消さないことを検証します。"""
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "GET":
            return httpx.Response(200, json={
                "object": "hermes.session",
                "session": {"id": OWNED_SESSION_ID, "ended_at": 1_785_024_000},
            })
        return httpx.Response(200, json={
            "object": "hermes.session.deleted",
            "id": OWNED_SESSION_ID,
            "deleted": True,
        })

    config = replace(Settings(), hermes_api_key="secret-value")
    await HermesClient(config, httpx.MockTransport(handler)).delete_ended_session(OWNED_SESSION_ID)

    assert [request.method for request in requests] == ["GET", "DELETE"]


@pytest.mark.asyncio
async def test_delete_session_rejects_open_session_before_delete() -> None:
    """継続中セッションではHermesのDELETEを呼ばず、競合として拒否します。"""
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={
            "object": "hermes.session",
            "session": {"id": OWNED_SESSION_ID, "ended_at": None},
        })

    config = replace(Settings(), hermes_api_key="secret-value")
    with pytest.raises(HermesConflictError):
        await HermesClient(config, httpx.MockTransport(handler)).delete_ended_session(OWNED_SESSION_ID)

    assert [request.method for request in requests] == ["GET"]


@pytest.mark.asyncio
async def test_skills_and_toolsets_are_sanitized() -> None:
    """参照APIがSkill本文やToolset設定値をブラウザへ転送しないことを確認します。"""
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/skills":
            return httpx.Response(200, json={"data": [{
                "name": "github",
                "description": "GitHub workflow",
                "category": "development",
                "content": "secret instructions",
                "path": "/private/skill.md",
            }]})
        return httpx.Response(200, json={"data": [{
            "name": "web",
            "label": "Web",
            "description": "Web tools",
            "enabled": True,
            "configured": True,
            "tools": ["web_search"],
            "api_key": "secret-value",
        }]})

    config = replace(Settings(), hermes_api_key="secret-value")
    client = HermesClient(config, httpx.MockTransport(handler))
    skills = [item.to_public_dict() for item in await client.list_skills()]
    toolsets = [item.to_public_dict() for item in await client.list_toolsets()]

    assert skills == [{"name": "github", "description": "GitHub workflow", "category": "development"}]
    assert toolsets == [{
        "name": "web",
        "label": "Web",
        "description": "Web tools",
        "enabled": True,
        "configured": True,
        "tools": ["web_search"],
    }]
    assert "secret" not in json.dumps({"skills": skills, "toolsets": toolsets})


@pytest.mark.asyncio
async def test_fork_ended_session_creates_owned_open_child() -> None:
    """終了済み履歴の分岐が、所有IDと親子関係を固定した継続可能な子を作ることを確認します。"""
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "GET":
            return httpx.Response(200, json={
                "object": "hermes.session",
                "session": {"id": OWNED_SESSION_ID, "ended_at": 1_785_024_000},
            })
        body = json.loads(request.content)
        return httpx.Response(201, json={
            "object": "hermes.session",
            "session": {
                "id": body["id"],
                "parent_session_id": OWNED_SESSION_ID,
                "ended_at": None,
            },
        })

    config = replace(Settings(), hermes_api_key="secret-value")
    fork = await HermesClient(config, httpx.MockTransport(handler)).fork_ended_session(OWNED_SESSION_ID)

    fork_id = fork.id
    assert fork_id.startswith("avatar_gateway_")
    assert len(fork_id) == len("avatar_gateway_") + 32
    assert requests[0].method == "GET"
    assert requests[1].method == "POST"
    assert str(requests[1].url) == f"http://127.0.0.1:8642/api/sessions/{OWNED_SESSION_ID}/fork"
    assert json.loads(requests[1].content) == {"id": fork_id}
    assert fork.to_public_dict()["parent_session_id"] == OWNED_SESSION_ID
    assert fork.to_public_dict()["ended_at"] is None


@pytest.mark.asyncio
async def test_fork_rejects_open_session_before_posting() -> None:
    """継続中セッションを誤って終了させるFork要求を、HermesへPOSTする前に拒否します。"""
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={
            "object": "hermes.session",
            "session": {"id": OWNED_SESSION_ID, "ended_at": None},
        })

    config = replace(Settings(), hermes_api_key="secret-value")
    client = HermesClient(config, httpx.MockTransport(handler))

    with pytest.raises(HermesConflictError) as captured:
        await client.fork_ended_session(OWNED_SESSION_ID)

    assert str(captured.value) == "継続中のセッションは分岐せず、そのまま再開してください"
    assert [request.method for request in requests] == ["GET"]


@pytest.mark.asyncio
async def test_session_messages_remove_system_reasoning_and_raw_tool_calls() -> None:
    """正式履歴を返しつつ、system promptと内部推論・生ツール引数を公開しません。"""
    transport = httpx.MockTransport(lambda _request: httpx.Response(200, json={
        "object": "list",
        "session_id": OWNED_SESSION_ID,
        "data": [
            {"role": "system", "content": "secret system prompt"},
            {"role": "user", "content": "調べて"},
            {
                "role": "assistant",
                "content": "確認します",
                "reasoning": "internal reasoning",
                "reasoning_content": "hidden",
                "tool_calls": [{"function": {"arguments": "secret-value"}}],
            },
            {"role": "tool", "tool_name": "terminal", "content": "完了"},
        ],
    }))
    config = replace(Settings(), hermes_api_key="secret-value")

    messages = await HermesClient(config, transport).get_session_messages(OWNED_SESSION_ID)
    public = [message.to_public_dict() for message in messages]

    assert [message["role"] for message in public] == ["user", "assistant", "tool"]
    assert all("reasoning" not in message for message in public)
    assert all("reasoning_content" not in message for message in public)
    assert all("tool_calls" not in message for message in public)
    assert "secret system prompt" not in json.dumps(public, ensure_ascii=False)
    assert "secret-value" not in json.dumps(public, ensure_ascii=False)


@pytest.mark.asyncio
async def test_start_run_sends_session_and_explicit_history() -> None:
    """Hermesが自動取得しない会話履歴を、所有セッションIDとともに明示します。"""
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(202, json={"run_id": RUN_ID, "status": "started"})

    config = replace(Settings(), hermes_api_key="secret-value", hermes_model="hermes-agent")
    history = [{"role": "user", "content": "以前の質問"}]
    started = await HermesClient(config, httpx.MockTransport(handler)).start_run(
        OWNED_SESSION_ID,
        "続けて",
        history,
    )

    assert started == {"run_id": RUN_ID, "status": "started"}
    assert str(requests[0].url) == "http://127.0.0.1:8642/v1/runs"
    assert json.loads(requests[0].content) == {
        "input": "続けて",
        "session_id": OWNED_SESSION_ID,
        "model": "hermes-agent",
        "conversation_history": history,
    }


@pytest.mark.asyncio
async def test_stop_run_posts_to_hermes_agent() -> None:
    """画面の中断がローカル切断だけでなく、Hermesの停止APIへ届くことを確認します。"""
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(202, json={"run_id": RUN_ID, "status": "stopping"})

    config = replace(Settings(), hermes_api_key="secret-value")
    stopped = await HermesClient(config, httpx.MockTransport(handler)).stop_run(RUN_ID)

    assert stopped == {"run_id": RUN_ID, "status": "stopping"}
    assert requests[0].method == "POST"
    assert str(requests[0].url) == f"http://127.0.0.1:8642/v1/runs/{RUN_ID}/stop"


@pytest.mark.asyncio
async def test_run_approval_sends_one_scoped_choice() -> None:
    """一件のRunへ選択だけを送り、resolve_all等の広い操作を公開しないことを確認します。"""
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={
            "object": "hermes.run.approval_response",
            "run_id": RUN_ID,
            "choice": "once",
            "resolved": 1,
        })

    config = replace(Settings(), hermes_api_key="secret-value")
    approved = await HermesClient(config, httpx.MockTransport(handler)).respond_to_run_approval(
        RUN_ID,
        "once",
    )

    assert approved == {"run_id": RUN_ID, "choice": "once", "resolved": 1}
    assert requests[0].method == "POST"
    assert str(requests[0].url) == f"http://127.0.0.1:8642/v1/runs/{RUN_ID}/approval"
    assert json.loads(requests[0].content) == {"choice": "once"}


@pytest.mark.asyncio
async def test_expired_run_approval_becomes_safe_conflict() -> None:
    """Hermesの内部409本文を隠し、UIが再試行判断できる競合例外へ変換します。"""
    transport = httpx.MockTransport(
        lambda _request: httpx.Response(409, text="expired token=secret-value"),
    )
    config = replace(Settings(), hermes_api_key="secret-value")

    with pytest.raises(HermesConflictError) as captured:
        await HermesClient(config, transport).respond_to_run_approval(RUN_ID, "deny")

    assert str(captured.value) == "この承認要求は既に解決済みか、期限切れです"
    assert "secret-value" not in str(captured.value)


@pytest.mark.asyncio
async def test_run_event_stream_parses_structured_sse() -> None:
    """Hermes Run SSEのJSONイベントを順序どおり取り出します。"""
    body = "\n".join([
        'data: {"event":"tool.started","run_id":"' + RUN_ID + '","tool":"terminal"}',
        "",
        'data: {"event":"run.completed","run_id":"' + RUN_ID + '","output":"完了"}',
        "",
        ": stream closed",
        "",
    ])
    transport = httpx.MockTransport(lambda _request: httpx.Response(200, text=body))
    config = replace(Settings(), hermes_api_key="secret-value")

    events = [
        event
        async for event in HermesClient(config, transport).stream_run_events(RUN_ID)
    ]

    assert [event["event"] for event in events] == ["tool.started", "run.completed"]


@pytest.mark.asyncio
async def test_get_run_excludes_unknown_upstream_fields() -> None:
    """状態取得でもHermes内部オブジェクトをブラウザ向けデータへ混ぜません。"""
    transport = httpx.MockTransport(lambda _request: httpx.Response(200, json={
        "object": "hermes.run",
        "run_id": RUN_ID,
        "status": "running",
        "session_id": OWNED_SESSION_ID,
        "private_agent": {"api_key": "secret-value"},
    }))
    config = replace(Settings(), hermes_api_key="secret-value")

    status = await HermesClient(config, transport).get_run(RUN_ID)

    assert status["status"] == "running"
    assert "private_agent" not in status
    assert "secret-value" not in str(status)


@pytest.mark.asyncio
async def test_get_run_rejects_mismatched_upstream_run_id() -> None:
    """別Runの状態を回収対象へ誤って結び付けないことを確認します。"""
    transport = httpx.MockTransport(lambda _request: httpx.Response(200, json={
        "run_id": "run_ffffffffffffffffffffffffffffffff",
        "status": "running",
        "session_id": OWNED_SESSION_ID,
    }))
    config = replace(Settings(), hermes_api_key="secret-value")

    with pytest.raises(HermesError, match="Run IDが一致しません"):
        await HermesClient(config, transport).get_run(RUN_ID)
