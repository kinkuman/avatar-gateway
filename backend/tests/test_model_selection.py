"""モデル選択が秘密情報を落とさず、次のRunへ渡ることを確認します。"""

import json
from dataclasses import replace

import httpx
import pytest

from app.config import Settings
from app.services.hermes import HermesClient
from app.services.model_selection import (
    ModelSelectionStore,
    SelectedHermesModel,
    public_model_catalog,
    selection_is_listed,
)


OWNED_SESSION_ID = "avatar_gateway_" + "ab" * 16
RUN_ID = "run_" + "cd" * 16


def test_public_catalog_keeps_names_and_drops_secrets() -> None:
    """一覧APIの認証情報や接続先を画面へ返さないことを確認します。"""
    catalog = public_model_catalog({
        "model": "omni_coding",
        "provider": "custom",
        "providers": [{
            "slug": "custom",
            "name": "Custom endpoint",
            "models": ["omni_coding", "omni_auto", {"id": "hidden"}],
            "api_key": "secret-value",
            "api_url": "http://secret.example",
            "is_current": True,
        }],
    })

    assert catalog["current_model"] == "omni_coding"
    assert catalog["providers"] == [{
        "slug": "custom",
        "name": "Custom endpoint",
        "models": ["omni_coding", "omni_auto"],
        "truncated": False,
    }]
    assert "secret-value" not in json.dumps(catalog)
    assert selection_is_listed(catalog, "omni_coding", "custom") is True
    assert selection_is_listed(catalog, "missing", "custom") is False


def test_selection_store_round_trip(tmp_path) -> None:
    """選択の保存と解除が、次回読み込みへ反映されることを確認します。"""
    store = ModelSelectionStore(tmp_path / "hermes_model.json")
    assert store.load() is None

    saved = store.save(SelectedHermesModel(model="omni_coding", provider="custom"))
    assert store.load() == saved
    store.clear()
    assert store.load() is None


@pytest.mark.asyncio
async def test_start_run_sends_saved_model_and_provider(tmp_path) -> None:
    """保存した選択が、次のHermes Runのモデルとプロバイダになることを確認します。"""
    path = tmp_path / "hermes_model.json"
    ModelSelectionStore(path).save(SelectedHermesModel(model="omni_coding", provider="custom"))
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(202, json={"run_id": RUN_ID, "status": "started"})

    config = replace(
        Settings(),
        hermes_api_key="secret-value",
        hermes_model="hermes-agent",
        hermes_model_file=path,
    )
    await HermesClient(config, httpx.MockTransport(handler)).start_run(
        OWNED_SESSION_ID,
        "切り替え確認",
        [],
    )

    assert json.loads(requests[0].content)["model"] == "omni_coding"
    assert json.loads(requests[0].content)["provider"] == "custom"
