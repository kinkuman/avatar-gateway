"""利用者の追加訳が壊れても同梱UIと言語設定を維持できることを確認します。"""

import json
from dataclasses import replace
from pathlib import Path

import httpx
import pytest
from pydantic import ValidationError

from app import main as main_module
from app.services.locales import list_locales
from app.services.ui_settings import UiSettings, UiSettingsStore


def write_locale(directory: Path, code: str, messages: dict, name: str = "") -> None:
    """本番と同じファイル形式で、同梱・追加訳の組み合わせを作ります。"""
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{code}.json").write_text(json.dumps({
        "_meta": {"name": name or code}, **messages,
    }), encoding="utf-8")


def test_local_overrides_keep_bundled_keys_and_discover_new_languages(tmp_path: Path) -> None:
    """同名言語の部分上書きと、新言語の自動列挙を一つの経路で扱います。"""
    bundled, local = tmp_path / "assets", tmp_path / "local-assets"
    write_locale(bundled, "en", {"settings.title": "Settings", "app.avatar.idle": "Idle"}, "English")
    write_locale(local, "en", {"settings.title": "Preferences"}, "Custom English")
    write_locale(local, "id", {"settings.title": "Pengaturan"}, "Bahasa Indonesia")

    result = {item["code"]: item for item in list_locales(bundled, local)}

    assert result["en"]["messages"] == {"settings.title": "Preferences", "app.avatar.idle": "Idle"}
    assert result["en"]["name"] == "Custom English"
    assert result["id"]["name"] == "Bahasa Indonesia"


def test_invalid_local_files_do_not_hide_bundled_language(tmp_path: Path) -> None:
    """破損JSON、不正コード、リンクで既定辞書を隠したり別ファイルを公開したりしません。"""
    bundled, local = tmp_path / "assets", tmp_path / "local-assets"
    write_locale(bundled, "ja", {"settings.title": "設定"}, "日本語")
    local.mkdir()
    (local / "ja.json").write_text("{broken", encoding="utf-8")
    write_locale(local, "invalid_code", {"settings.title": "Invalid"})
    (local / "en.json").symlink_to(bundled / "ja.json")

    assert list_locales(bundled, local) == [{
        "code": "ja", "name": "日本語", "messages": {"settings.title": "設定"},
    }]


def test_language_compatibility_validation_and_round_trip(tmp_path: Path) -> None:
    """旧設定は日本語を補い、追加言語のコードは既定値へ保存できます。"""
    assert UiSettings.model_validate({}).language == "ja"
    store = UiSettingsStore(tmp_path / "ui.json")
    store.save(UiSettings(language="id"))
    assert store.load().language == "id"
    for invalid in ("../en", "", "en.json", "en_US", "x" * 65):
        with pytest.raises(ValidationError):
            UiSettings(language=invalid)


@pytest.mark.asyncio
async def test_locale_api_and_language_default_save(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """同じAPI境界で追加言語を列挙し、UI既定値として往復できることを確認します。"""
    bundled, local = tmp_path / "assets", tmp_path / "local-assets"
    write_locale(bundled / "locales", "ja", {"settings.title": "設定"}, "日本語")
    write_locale(local / "locales", "id", {"settings.title": "Pengaturan"}, "Bahasa Indonesia")
    settings_file = tmp_path / "ui.json"
    UiSettingsStore(settings_file).save(UiSettings())
    monkeypatch.setattr(main_module, "settings", replace(
        main_module.settings, bundled_assets_dir=bundled, local_assets_dir=local,
        ui_settings_file=settings_file, gateway_auth_password="",
    ))
    transport = httpx.ASGITransport(app=main_module.app)
    async with httpx.AsyncClient(transport=transport, base_url=f"http://{main_module.settings.gateway_allowed_hosts[0]}") as client:
        response = await client.get("/api/locales")
        assert response.status_code == 200
        assert {item["code"] for item in response.json()["data"]} == {"ja", "id"}
        response = await client.put("/api/ui-settings", json=UiSettings(language="id").model_dump(),
                                    headers={"Origin": f"http://{main_module.settings.gateway_allowed_hosts[0]}"})
        assert response.status_code == 200
        assert (await client.get("/api/ui-settings")).json()["language"] == "id"
    assert UiSettingsStore(settings_file).load().language == "id"
