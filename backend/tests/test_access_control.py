"""LAN公開設定、Basic認証、更新系の同一オリジン判定を検証します。"""

import base64
from dataclasses import replace

import httpx
import pytest

from app import main as main_module
from app.config import Settings, validate_gateway_security
from app.services.access_control import (
    authenticate_basic_header,
    gateway_authentication_enabled,
    is_same_origin_request,
)


def _basic(username: str, password: str) -> str:
    """実ブラウザと同じBasic認証ヘッダーをテスト用に生成します。"""
    encoded = base64.b64encode(f"{username}:{password}".encode()).decode()
    return f"Basic {encoded}"


def test_lan_mode_allows_no_auth_but_requires_explicit_hosts() -> None:
    """イントラネット用の認証なし待受を許可しつつ、Host制限は必須にします。"""
    base = replace(
        Settings(),
        gateway_host="127.0.0.1",
        gateway_lan_mode=False,
        gateway_auth_username="avatar",
        gateway_auth_password="",
        gateway_allowed_hosts=("127.0.0.1", "localhost"),
    )
    with pytest.raises(RuntimeError, match="LAN_MODE"):
        validate_gateway_security(replace(base, gateway_host="0.0.0.0"))
    validate_gateway_security(replace(
        base,
        gateway_host="0.0.0.0",
        gateway_lan_mode=True,
        gateway_auth_password="",
        gateway_allowed_hosts=("192.168.2.197",),
    ))
    with pytest.raises(RuntimeError, match="16文字以上"):
        validate_gateway_security(replace(
            base,
            gateway_host="0.0.0.0",
            gateway_lan_mode=True,
            gateway_auth_password="short",
        ))
    with pytest.raises(RuntimeError, match="ALLOWED_HOSTS"):
        validate_gateway_security(replace(
            base,
            gateway_host="0.0.0.0",
            gateway_lan_mode=True,
            gateway_auth_password="long-enough-password",
            gateway_allowed_hosts=("*",),
        ))


def test_authentication_is_enabled_only_when_password_is_configured() -> None:
    """LANモード自体では認証を要求せず、任意設定した場合だけ有効にします。"""
    assert gateway_authentication_enabled(replace(
        Settings(),
        gateway_lan_mode=True,
        gateway_auth_password="",
    )) is False
    assert gateway_authentication_enabled(replace(
        Settings(),
        gateway_lan_mode=True,
        gateway_auth_password="long-enough-password",
    )) is True


def test_basic_authentication_uses_exact_credentials() -> None:
    """正しい資格情報だけを許可し、壊れたヘッダーを例外にしません。"""
    config = replace(
        Settings(),
        gateway_auth_username="avatar",
        gateway_auth_password="long-enough-password",
    )
    assert authenticate_basic_header(_basic("avatar", "long-enough-password"), config) is True
    assert authenticate_basic_header(_basic("avatar", "wrong-password"), config) is False
    assert authenticate_basic_header("Basic invalid!", config) is False
    assert authenticate_basic_header(None, config) is False


def test_state_changing_browser_request_must_match_host() -> None:
    """LAN上の別サイトから送られた更新操作をHost比較で拒否します。"""
    assert is_same_origin_request("http://192.168.1.20:8000", "192.168.1.20:8000") is True
    assert is_same_origin_request("https://avatar.local", "avatar.local") is True
    assert is_same_origin_request("http://attacker.local", "avatar.local") is False
    assert is_same_origin_request("null", "avatar.local") is False
    assert is_same_origin_request(None, "avatar.local") is True


@pytest.mark.asyncio
async def test_gateway_middleware_protects_all_routes_and_rejects_cross_origin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """実ASGI境界でも未認証アクセスと別オリジンの更新操作を拒否します。"""
    no_auth_config = replace(
        Settings(),
        gateway_lan_mode=True,
        gateway_auth_password="",
    )
    config = replace(
        Settings(),
        gateway_lan_mode=True,
        gateway_auth_username="avatar",
        gateway_auth_password="long-enough-password",
    )
    # TrustedHostMiddlewareはアプリimport時の設定で固定されるため、その許可値をテストHostにも使います。
    allowed_host = main_module.settings.gateway_allowed_hosts[0]
    transport = httpx.ASGITransport(app=main_module.app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url=f"http://{allowed_host}",
    ) as client:
        monkeypatch.setattr(main_module, "settings", no_auth_config)
        no_auth = await client.get("/openapi.json")
        assert no_auth.status_code == 200

        monkeypatch.setattr(main_module, "settings", config)
        unauthenticated = await client.get("/openapi.json")
        assert unauthenticated.status_code == 401
        assert unauthenticated.headers["www-authenticate"].startswith("Basic")

        headers = {"Authorization": _basic("avatar", "long-enough-password")}
        authenticated = await client.get("/openapi.json", headers=headers)
        assert authenticated.status_code == 200

        cross_origin = await client.post(
            "/__access_control_test__",
            headers={**headers, "Origin": "http://attacker.local"},
        )
        assert cross_origin.status_code == 403


def test_bundled_motion_asset_is_mounted_without_hiding_vite_assets() -> None:
    """VRMAだけを限定公開し、ViteのJS/CSS用/assetsを奪わないことを確認します。"""
    motion_mount = next(
        route for route in main_module.app.routes if route.name == "bundled-motions"
    )
    assert motion_mount.path == "/assets/motions"
    assert not any(route.path == "/assets" for route in main_module.app.routes)

    # StaticFilesの実経路解決も通し、cloneに完成VRMAが含まれることを確かめます。
    full_path, stat_result = motion_mount.app.lookup_path("nod.vrma")
    assert stat_result is not None
    with open(full_path, "rb") as asset:
        assert asset.read(4) == b"glTF"


def test_bundled_sample_vrm_is_mounted_separately_from_vite_assets() -> None:
    """clone直後のサンプルVRMを公開し、利用者固有モデルの配置を必須にしません。"""
    vrm_mount = next(route for route in main_module.app.routes if route.name == "bundled-vrm")

    assert vrm_mount.path == "/assets/vrm"
    full_path, stat_result = vrm_mount.app.lookup_path("はむ子.vrm")
    assert stat_result is not None
    with open(full_path, "rb") as asset:
        assert asset.read(4) == b"glTF"
