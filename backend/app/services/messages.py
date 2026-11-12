"""表示文は日本語JSONを正本にし、APIには言語に依存しないキーと引数を渡します。"""

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

from fastapi import HTTPException


@lru_cache(maxsize=1)
def _japanese_messages() -> dict:
    """ログと従来クライアント向けの文面も、コードへ重複記載せず辞書から取得します。"""
    return json.loads((Path(__file__).resolve().parents[3] / "assets/locales/ja.json").read_text(encoding="utf-8"))


def message_ref(key: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    """操作名など、文へ差し込む項目自身も翻訳キーとして渡せるようにします。"""
    return {"message_key": key, "message_params": params or {}}


def render_message(key: str, params: dict[str, Any] | None = None) -> str:
    """ブラウザの選択言語には触れず、サーバーログと互換表示用の日本語だけを作ります。"""
    template = _japanese_messages().get(key, key)
    values = params or {}

    def substitute(match: re.Match) -> str:
        """入れ子の操作名は同じ辞書で解決し、外部サービスの詳細文字列は改変しません。"""
        value = values.get(match[1], match[0])
        if isinstance(value, dict) and isinstance(value.get("message_key"), str):
            return render_message(value["message_key"], value.get("message_params"))
        return str(value)

    return re.sub(r"\{\{([A-Za-z][A-Za-z0-9]*)\}\}", substitute, template)


class UiMessageError(RuntimeError):
    """Gatewayのエラーはキーで識別し、外部から来た未知のエラー本文も保持します。"""

    def __init__(self, message: str | BaseException | None = None, *, message_key: str | None = None,
                 message_params: dict[str, Any] | None = None) -> None:
        """例外を包み直す場合も、翻訳キーをstr変換で落とさず引き継ぎます。"""
        if isinstance(message, UiMessageError) and message_key is None:
            message_key, message_params = message.message_key, message.message_params
        self.message_key = message_key
        self.message_params = dict(message_params or {})
        super().__init__(render_message(message_key, self.message_params) if message_key else (str(message) if message is not None else ""))


def message_payload(value: BaseException | str, field: str = "message") -> dict[str, Any]:
    """HTTP・SSE・状態APIのどの経路でも、表示文と翻訳情報を一緒に公開します。"""
    payload: dict[str, Any] = {field: str(value)}
    if isinstance(value, UiMessageError) and value.message_key:
        payload.update(message_ref(value.message_key, value.message_params))
    return payload


class UiHttpError(HTTPException):
    """従来のdetail文字列を維持しながら、追加の翻訳情報をHTTP応答へ載せます。"""

    def __init__(self, status_code: int, error: BaseException) -> None:
        """既存の例外種別・状態コードの振り分けを変えず、情報だけを追加します。"""
        super().__init__(status_code=status_code, detail=str(error))
        self.payload = message_payload(error, "detail")
