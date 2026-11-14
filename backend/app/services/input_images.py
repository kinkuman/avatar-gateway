"""入力画像を保存せず検証し、Hermes用の画像付きメッセージを組み立てます。"""

import base64
import binascii
import re

from .messages import render_message

MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_IMAGE_DATA_URL_LENGTH = ((MAX_IMAGE_BYTES + 2) // 3) * 4 + 32


def validate_input_image(value: str) -> str:
    """外部URLを受け付けず、送信上限と画像形式を確認してHermesへ渡します。"""
    header, separator, encoded = value.partition(",")
    if not separator or header not in {
        "data:image/png;base64", "data:image/jpeg;base64", "data:image/webp;base64",
    }:
        raise ValueError(render_message("gateway.inputImage.invalid"))
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise ValueError(render_message("gateway.inputImage.invalid")) from None
    if len(raw) > MAX_IMAGE_BYTES:
        raise ValueError(render_message("gateway.inputImage.tooLarge"))
    matches = {
        "data:image/png;base64": raw.startswith(b"\x89PNG\r\n\x1a\n"),
        "data:image/jpeg;base64": raw.startswith(b"\xff\xd8\xff"),
        "data:image/webp;base64": raw[:4] == b"RIFF" and raw[8:12] == b"WEBP",
    }
    if not matches[header]:
        raise ValueError(render_message("gateway.inputImage.invalid"))
    return value


def build_image_input(text: str, image: str) -> list[dict]:
    """今回の画像だけをRun入力へ添付し、過去の画像を再送しません。"""
    return [{"role": "user", "content": [
        {"type": "text", "text": text},
        {"type": "image_url", "image_url": {"url": image}},
    ]}]


def present_image_input(text: str) -> str:
    """Hermesが保存した画像参照のパスは表示せず、添付があったことだけを残します。"""
    presented = re.sub(r"\[Image attached(?: at)?: [^\r\n]*\]", "", text)
    presented = presented.replace("[screenshot]", render_message("gateway.inputImage.attached"))
    # 通常の発言の改行・空白は保持し、画像参照を取り除いた場合だけ余白を整えます。
    return re.sub(r"\n{3,}", "\n\n", presented).strip() if presented != text else text
