"""Hermesがassistant本文で返す運用診断を、通常会話から分離します。"""


EMPTY_RESPONSE_NOTICE = "⚠️ Hermesから応答を取得できませんでした。もう一度お試しください。"

_NO_REPLY_PREFIXES = (
    "⚠️ No reply: the model returned empty content after retries",
    "⚠️ No reply: all API retries were exhausted before a response was produced",
    "⚠️ No reply: streaming stopped early and only a partial response was recovered",
)


def hermes_diagnostic_notice(text: str) -> str | None:
    """Hermes既知の応答失敗センチネルだけを、日本語の非発話表示へ変換します。"""
    normalized = " ".join(text.strip().split())
    if normalized == "(empty)" or normalized.startswith(_NO_REPLY_PREFIXES):
        return EMPTY_RESPONSE_NOTICE
    return None
