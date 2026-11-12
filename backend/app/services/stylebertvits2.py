"""Style-Bert-VITS2の音声を生成し、ブラウザが再生できる一時資産へ保存します。"""

from .messages import UiMessageError, message_ref

from pathlib import Path

import httpx

from ..config import Settings
from .speech_base import TtsError, create_tts_client, store_utterance_audio


__all__ = ["TtsError", "create_tts_client", "synthesize"]


async def synthesize(
    text: str,
    config: Settings,
    client: httpx.AsyncClient | None = None,
) -> tuple[str, Path]:
    """前実装と互換性のあるパラメーターで音声を作り、文単位の一時WAVとして保存します。"""
    if client is None:
        # 単体利用時も従来どおり呼べるよう、必要な場合だけ一時クライアントを所有します。
        async with create_tts_client() as owned_client:
            return await synthesize(text, config, owned_client)

    endpoint = config.tts_server_url
    if not endpoint.endswith("/voice"):
        endpoint = f"{endpoint}/voice"

    params = {
        "text": text,
        "model_id": config.tts_model_id,
        "style": config.tts_style,
        "sdp_ratio": config.tts_sdp_ratio,
        "length": config.tts_length,
        "language": "JP",
    }
    headers = {"Content-Type": "audio/wav"}
    if config.tts_api_key:
        headers["Authorization"] = f"Bearer {config.tts_api_key}"

    try:
        response = await client.post(endpoint, params=params, headers=headers)
        if response.status_code >= 400:
            # 利用者へ通知する条件: Style-Bert-VITS2 APIエラー (対象値)
            raise TtsError(message_key='gateway.stylebertvits2.apiError', message_params={'status': response.status_code, 'detail': response.text[:500]})
    except httpx.HTTPError as exc:
        # Style-Bert-VITS2への接続失敗を通知します
        raise TtsError(message_key='gateway.stylebertvits2.connectionFailed', message_params={'detail': message_ref(exc.message_key, exc.message_params) if isinstance(exc, UiMessageError) and exc.message_key else str(exc)}) from exc

    return await store_utterance_audio(response.content, config)
