"""Style-Bert-VITS2の音声を生成し、ブラウザが再生できる一時資産へ保存します。"""

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
            raise TtsError(f"Style-Bert-VITS2 APIエラー ({response.status_code}): {response.text[:500]}")
    except httpx.HTTPError as exc:
        raise TtsError(f"Style-Bert-VITS2へ接続できません: {exc}") from exc

    return await store_utterance_audio(response.content, config)
