"""UI設定の検証、原子的保存、同一オリジンAPI境界を外部サービスなしで確認します。"""

from dataclasses import replace
import json
from pathlib import Path

import httpx
import pytest
from pydantic import ValidationError

from app import main as main_module
from app.services.ui_settings import UiSettings, UiSettingsError, UiSettingsStore, list_backgrounds


def _settings(camera: dict | None = None) -> UiSettings:
    """各テストで同じ公開設定スキーマを使える標準値を返します。"""
    return UiSettings.model_validate({
        "schema_version": 1,
        "cast_off_enabled": False,
        "show_motion_controls": True,
        "show_camera_help": False,
        "speech_volume": 0.7,
        "camera": camera,
        "background": {"file": "青 空.webp", "fit": "cover"},
        "touch_interaction": {
            "extended_regions_enabled": False,
            "enabled": True,
            "debug_hitboxes": False,
            "edit_hitboxes": False,
            "recoil_test_enabled": False,
            "hitbox_profiles": {},
            "regions": {
                "head": True,
                "chest": True,
                "hips": True,
                "groin": True,
                "thigh": True,
                "hand": True,
                "foot": True,
            },
        },
        "voice_input": {
            "silence_ms": 800,
            "speech_threshold": 0.02,
        },
    })


def test_store_round_trips_validated_settings(tmp_path: Path) -> None:
    """日本語や浮動小数を含まない公開設定が、整形JSONで確実に往復することを確認します。"""
    path = tmp_path / "ui.json"
    store = UiSettingsStore(path)
    expected = _settings({
        "position": {"x": 0, "y": 1.4, "z": 2.5},
        "target": {"x": 0, "y": 1.3, "z": 0},
    })

    store.save(expected)

    assert store.load() == expected
    assert json.loads(path.read_text(encoding="utf-8"))["speech_volume"] == 0.7
    assert list(tmp_path.glob(".ui.json.*.tmp")) == []


def test_invalid_file_and_unsafe_camera_are_rejected(tmp_path: Path) -> None:
    """壊れた正本や操作不能なカメラを既定値として採用しないことを確認します。"""
    path = tmp_path / "ui.json"
    path.write_text('{"schema_version": 2}', encoding="utf-8")
    with pytest.raises(UiSettingsError, match="UI設定を読み込めません"):
        UiSettingsStore(path).load()

    with pytest.raises(ValidationError):
        _settings({
            "position": {"x": 1, "y": 1, "z": 1},
            "target": {"x": 1, "y": 1, "z": 1},
        })

    with pytest.raises(ValidationError):
        UiSettings.model_validate({
            **_settings().model_dump(mode="json"),
            "background": {"file": "../private.png", "fit": "cover"},
        })


def test_touch_interaction_defaults_keep_existing_ui_files_compatible() -> None:
    """旧いui.jsonに新設定がなくても、ふれあいの安全な初期値を補います。"""
    payload = _settings().model_dump(mode="json")
    del payload["touch_interaction"]

    loaded = UiSettings.model_validate(payload)

    assert loaded.touch_interaction.enabled is True
    assert loaded.touch_interaction.extended_regions_enabled is False
    assert loaded.touch_interaction.debug_hitboxes is False
    assert loaded.touch_interaction.edit_hitboxes is False
    assert loaded.touch_interaction.recoil_test_enabled is False
    assert loaded.touch_interaction.hitbox_profiles == {}
    assert loaded.touch_interaction.regions.ear is False
    assert loaded.touch_interaction.regions.tail is False
    assert all(
        enabled
        for region, enabled in loaded.touch_interaction.regions.model_dump().items()
        if region not in {"ear", "tail"}
    )


def test_cast_off_defaults_to_disabled_for_existing_ui_files() -> None:
    """旧いui.jsonでもキャストオフを表示せず、明示設定した場合だけ有効にします。"""
    payload = _settings().model_dump(mode="json")
    del payload["cast_off_enabled"]

    loaded = UiSettings.model_validate(payload)

    assert loaded.cast_off_enabled is False


def test_touch_regions_add_disabled_optional_regions_to_existing_settings() -> None:
    """従来7部位を維持しながら、新しい耳・尻尾判定だけを無効で補います。"""
    payload = _settings().model_dump(mode="json")
    del payload["touch_interaction"]["regions"]["ear"]
    del payload["touch_interaction"]["regions"]["tail"]

    loaded = UiSettings.model_validate(payload)

    assert loaded.touch_interaction.regions.ear is False
    assert loaded.touch_interaction.regions.tail is False


def test_touch_adjustment_defaults_keep_existing_touch_settings_compatible() -> None:
    """旧いふれあい設定へ、反動テストと判定編集の安全な初期値を補います。"""
    payload = _settings().model_dump(mode="json")
    del payload["touch_interaction"]["recoil_test_enabled"]
    del payload["touch_interaction"]["edit_hitboxes"]
    del payload["touch_interaction"]["hitbox_profiles"]

    loaded = UiSettings.model_validate(payload)

    assert loaded.touch_interaction.recoil_test_enabled is False
    assert loaded.touch_interaction.edit_hitboxes is False
    assert loaded.touch_interaction.hitbox_profiles == {}


def test_touch_hitbox_profiles_validate_model_specific_transforms() -> None:
    """左右別の調整値を保存でき、危険なモデルキーや倍率は拒否することを確認します。"""
    payload = _settings().model_dump(mode="json")
    payload["touch_interaction"]["hitbox_profiles"] = {
        "sample.vrm": {
            "leftHand": {
                "offset": {"x": -0.02, "y": 0.01, "z": 0.03},
                "scale": {"x": 1.2, "y": 0.9, "z": 1.1},
            },
        },
    }

    loaded = UiSettings.model_validate(payload)

    assert loaded.touch_interaction.hitbox_profiles["sample.vrm"]["leftHand"].scale.x == 1.2

    payload["touch_interaction"]["hitbox_profiles"] = {
        "sample.vrm": {
            "leftEar": {
                "offset": {"x": 0, "y": 0.04, "z": 0},
                "scale": {"x": 0.9, "y": 1.1, "z": 0.8},
            },
        },
    }
    loaded = UiSettings.model_validate(payload)
    assert loaded.touch_interaction.hitbox_profiles["sample.vrm"]["leftEar"].offset.y == 0.04

    payload["touch_interaction"]["hitbox_profiles"] = {
        "sample.vrm": {
            "tail": {
                "offset": {"x": 0, "y": 0.05, "z": 0.18},
                "scale": {"x": 1, "y": 1.4, "z": 1},
            },
        },
    }
    loaded = UiSettings.model_validate(payload)
    assert loaded.touch_interaction.hitbox_profiles["sample.vrm"]["tail"].scale.y == 1.4

    payload["touch_interaction"]["hitbox_profiles"] = {"../sample.vrm": {}}
    with pytest.raises(ValidationError):
        UiSettings.model_validate(payload)

    payload["touch_interaction"]["hitbox_profiles"] = {
        "sample.vrm": {
            "head": {
                "offset": {"x": 0, "y": 0, "z": 0},
                "scale": {"x": 0, "y": 1, "z": 1},
            },
        },
    }
    with pytest.raises(ValidationError):
        UiSettings.model_validate(payload)


def test_voice_input_defaults_keep_existing_ui_files_compatible() -> None:
    """旧いui.jsonにも安全なVAD初期値を補い、更新前の設定を読み続けられるようにします。"""
    payload = _settings().model_dump(mode="json")
    del payload["voice_input"]

    loaded = UiSettings.model_validate(payload)

    assert loaded.voice_input.silence_ms == 800
    assert loaded.voice_input.speech_threshold == 0.02


def test_background_catalog_merges_bundled_and_local_files(tmp_path: Path) -> None:
    """対応画像を安定順で統合し、同名のローカル版と日本語URLを正しく優先します。"""
    bundled = tmp_path / "assets"
    local = tmp_path / "local-assets"
    bundled.mkdir()
    local.mkdir()
    (bundled / "room.png").write_bytes(b"bundled")
    (bundled / "photo.JPG").write_bytes(b"jpeg")
    (local / "room.png").write_bytes(b"local override")
    (local / "青 空.webp").write_bytes(b"webp")
    (local / "notes.txt").write_text("ignored", encoding="utf-8")
    (local / ".hidden.png").write_bytes(b"hidden")
    (local / "nested").mkdir()
    (local / "nested" / "inside.png").write_bytes(b"nested")

    backgrounds = list_backgrounds(bundled, local)

    assert [item["file"] for item in backgrounds] == ["photo.JPG", "room.png", "青 空.webp"]
    assert backgrounds[1]["url"] == "/local-assets/backgrounds/room.png"
    assert backgrounds[2]["url"] == "/local-assets/backgrounds/%E9%9D%92%20%E7%A9%BA.webp"


@pytest.mark.asyncio
async def test_ui_settings_api_reads_and_updates_server_defaults(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """APIが検証済みJSONだけを書き、別オリジンのブラウザ更新を拒否します。"""
    path = tmp_path / "ui.json"
    bundled_backgrounds_dir = tmp_path / "assets" / "backgrounds"
    bundled_backgrounds_dir.mkdir(parents=True)
    (bundled_backgrounds_dir / "included.png").write_bytes(b"png")
    backgrounds_dir = tmp_path / "local-assets" / "backgrounds"
    backgrounds_dir.mkdir(parents=True)
    (backgrounds_dir / "青 空.webp").write_bytes(b"webp")
    UiSettingsStore(path).save(_settings())
    monkeypatch.setattr(
        main_module,
        "settings",
        replace(
            main_module.settings,
            ui_settings_file=path,
            bundled_assets_dir=tmp_path / "assets",
            local_assets_dir=tmp_path / "local-assets",
            gateway_auth_password="",
        ),
    )
    allowed_host = main_module.settings.gateway_allowed_hosts[0]
    transport = httpx.ASGITransport(app=main_module.app)
    async with httpx.AsyncClient(transport=transport, base_url=f"http://{allowed_host}") as client:
        loaded = await client.get("/api/ui-settings")
        assert loaded.status_code == 200
        assert loaded.json()["speech_volume"] == 0.7
        assert loaded.json()["cast_off_enabled"] is False
        assert loaded.json()["touch_interaction"]["extended_regions_enabled"] is False
        assert loaded.json()["touch_interaction"]["recoil_test_enabled"] is False
        assert loaded.json()["touch_interaction"]["edit_hitboxes"] is False
        assert loaded.json()["touch_interaction"]["hitbox_profiles"] == {}
        assert loaded.json()["touch_interaction"]["regions"]["ear"] is False
        assert loaded.json()["touch_interaction"]["regions"]["tail"] is False

        backgrounds = await client.get("/api/backgrounds")
        assert backgrounds.status_code == 200
        assert [item["file"] for item in backgrounds.json()["data"]] == ["included.png", "青 空.webp"]

        updated_payload = {**loaded.json(), "speech_volume": 0.4}
        updated = await client.put(
            "/api/ui-settings",
            json=updated_payload,
            headers={"Origin": f"http://{allowed_host}"},
        )
        assert updated.status_code == 200
        assert UiSettingsStore(path).load().speech_volume == 0.4

        rejected = await client.put(
            "/api/ui-settings",
            json=updated_payload,
            headers={"Origin": "http://attacker.invalid"},
        )
        assert rejected.status_code == 403
