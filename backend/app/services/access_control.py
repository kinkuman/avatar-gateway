"""LAN公開時にAvatar Gateway全体を保護する認証と同一オリジン検証です。"""

import base64
import binascii
import secrets
from urllib.parse import urlsplit

from ..config import Settings


def gateway_authentication_enabled(config: Settings) -> bool:
    """パスワードを明示した場合だけ、画面とAPIのBasic認証を有効にします。"""
    return bool(config.gateway_auth_password)


def authenticate_basic_header(authorization: str | None, config: Settings) -> bool:
    """Basic認証値を一定時間比較し、ユーザー名・パスワードの推測情報を返しません。"""
    if not authorization:
        return False
    scheme, separator, encoded = authorization.partition(" ")
    if separator != " " or scheme.lower() != "basic" or not encoded:
        return False
    try:
        decoded = base64.b64decode(encoded, validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError):
        return False
    username, separator, password = decoded.partition(":")
    if separator != ":":
        return False
    return (
        secrets.compare_digest(username, config.gateway_auth_username)
        and secrets.compare_digest(password, config.gateway_auth_password)
    )


def is_same_origin_request(origin: str | None, host: str | None) -> bool:
    """ブラウザの更新系リクエストを、表示中ページと同じHostからの操作に限定します。"""
    if origin is None:
        # curl等の非ブラウザクライアントはBasic認証を必須にした上で利用できます。
        return True
    if not host or origin == "null":
        return False
    try:
        parsed = urlsplit(origin)
    except ValueError:
        return False
    return parsed.scheme in {"http", "https"} and parsed.netloc.lower() == host.lower()
