"""翻訳情報をHTTP・状態通知・履歴で失わず、通常の会話や上流診断を改変しないことを確認します。"""

import json
from pathlib import Path

import pytest

from app import main as gateway
from app.services.hermes import HermesClient, HermesError
from app.services.hermes_diagnostics import EMPTY_RESPONSE_KEY, EMPTY_RESPONSE_NOTICE
from app.services.hermes_runs import HermesRunCoordinator, _RunRecord
from app.services.messages import UiHttpError, UiMessageError, message_payload, message_ref
from app.services.motion_tags import MotionCatalog, load_motion_catalog_safely


def test_keyed_exception_keeps_metadata_when_wrapped() -> None:
    """例外を別の層で包み直しても、翻訳キーと数値引数が失われません。"""
    source = UiMessageError(message_key="gateway.hermesClient.requestFailed", message_params={"status": 418})
    wrapped = HermesError(source)
    assert message_payload(wrapped) == {
        "message": "Hermes APIリクエストに失敗しました (418)",
        "message_key": "gateway.hermesClient.requestFailed",
        "message_params": {"status": 418},
    }


def test_operation_name_is_a_nested_translation_reference() -> None:
    """文面だけでなく差し込み先の操作名も、ブラウザの選択言語で解決できます。"""
    error = HermesClient._api_error(404, "gateway.operations.models")
    payload = message_payload(error)
    assert payload["message_params"]["operation"] == message_ref("gateway.operations.models")
    assert str(error) == "Hermesがモデル一覧APIに対応していません"
    assert str(HermesClient._api_error(404, "unknown operation")) == "Hermesがunknown operationに対応していません"


def test_unknown_upstream_error_is_not_guessed_from_its_text() -> None:
    """上流由来の未知の文へ、推測した翻訳キーを付けません。"""
    assert message_payload(HermesError("Upstream diagnostics")) == {"message": "Upstream diagnostics"}


def test_http_error_preserves_status_and_legacy_detail() -> None:
    """既存クライアント用detailと、新クライアント用の翻訳情報を併存させます。"""
    error = UiHttpError(503, UiMessageError(message_key="gateway.whisper.modelMissingNotice"))
    assert error.status_code == 503
    assert error.detail == error.payload["detail"]
    assert error.payload["message_key"] == "gateway.whisper.modelMissingNotice"
    assert error.payload["message_params"] == {}


def test_history_marks_only_gateway_generated_diagnostics() -> None:
    """通常の利用者発言や回答を翻訳せず、アプリが作る無応答案内だけにキーを付けます。"""
    catalog = MotionCatalog((), None)
    messages = gateway._present_session_messages([
        {"role": "user", "content": EMPTY_RESPONSE_NOTICE},
        {"role": "assistant", "content": "通常の返答です。"},
        {"role": "assistant", "content": "(empty)"},
    ], catalog)
    assert "message_key" not in messages[0]
    assert "message_key" not in messages[1]
    assert messages[1]["content"] == "通常の返答です。"
    assert messages[2]["message_key"] == EMPTY_RESPONSE_KEY
    assert messages[2]["content"] == EMPTY_RESPONSE_NOTICE


def test_run_failure_keeps_external_diagnostics_and_keys_its_own_fallback() -> None:
    """ストリームの失敗でも、アプリの定型文と外部の診断を区別します。"""
    fallback = HermesRunCoordinator._translate_event({"event": "run.failed"})
    assert fallback["message_key"] == "gateway.runs.failed"
    external = HermesRunCoordinator._translate_event({"event": "run.failed", "error": "Server diagnostics"})
    assert external == {"type": "agent.failed", "message": "Server diagnostics"}


def test_motion_configuration_failure_keeps_translation_arguments(tmp_path: Path) -> None:
    """読み込みエラーを空カタログへ変えても、画面が原因を翻訳できる情報を残します。"""
    catalog = load_motion_catalog_safely(tmp_path / "missing.json", tmp_path / "local")
    assert catalog.motions == ()
    assert catalog.error_message["message_key"] == "gateway.motionCatalog.readFailed"
    assert "detail" in catalog.error_message["message_params"]


@pytest.mark.asyncio
async def test_http_handler_serializes_key_and_legacy_detail() -> None:
    """HTTPハンドラーが辞書を落とさずJSONへ載せることを確認します。"""
    error = UiHttpError(502, HermesError(message_key="gateway.hermesClient.authFailed"))
    response = await gateway.localized_http_error(None, error)
    payload = json.loads(response.body)
    assert response.status_code == 502
    assert payload["message_key"] == "gateway.hermesClient.authFailed"
    assert payload["detail"] == "Hermes APIの認証に失敗しました"


@pytest.mark.asyncio
async def test_run_event_buffer_preserves_failure_translation() -> None:
    """接続失敗を再接続用のイベントへ保存しても、翻訳情報が失われません。"""
    class FailingClient:
        """上流接続の失敗だけを再現し、外部通信を行いません。"""

        async def stream_run_events(self, _run_id):
            """実際と同じ非同期ストリームの開始時に接続失敗を返します。"""
            raise HermesError(message_key="gateway.hermesClient.runEventsConnectionFailed")
            yield  # 非同期イテレーターとして、例外で終わるストリームを表します。

    coordinator = HermesRunCoordinator(lambda: FailingClient())
    record = _RunRecord(run_id="run_test", session_id="session_test", status="running")
    await coordinator._consume_upstream(record, FailingClient())
    assert record.finished is True
    assert record.events[0]["message_key"] == "gateway.hermesClient.runEventsConnectionFailed"
    assert record.events[0]["message_params"] == {}
