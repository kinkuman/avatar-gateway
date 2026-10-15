"""設定で選んだ提供元へ、音声合成と音声認識の呼び出しを振り分けます。"""

from pathlib import Path
from typing import Any

import httpx

from ..config import Settings
from . import openai_speech, stylebertvits2
from .openai_speech import SpeechStreamUnsupported
from .faster_whisper import FasterWhisperTranscriber, is_model_installed
from .speech_base import (
    NoSpeechDetectedError,
    TranscriptionError,
    TranscriptionUnavailableError,
    TtsError,
    create_tts_client,
)


__all__ = [
    "NoSpeechDetectedError",
    "OPENAI_PROVIDER",
    "STT_PROVIDERS",
    "SpeechStreamUnsupported",
    "TTS_PROVIDERS",
    "TranscriptionError",
    "TranscriptionUnavailableError",
    "TtsError",
    "create_transcriber",
    "create_tts_client",
    "iter_speech_pcm",
    "synthesize",
    "transcription_status",
]

OPENAI_PROVIDER = "openai"
TTS_PROVIDERS = ("stylebertvits2", OPENAI_PROVIDER)
STT_PROVIDERS = ("faster_whisper", OPENAI_PROVIDER)

_MODEL_MISSING_NOTICE = "Whisperモデルが未導入です。READMEの音声認識モデル導入手順を実行してください。"


async def synthesize(
    text: str,
    config: Settings,
    client: httpx.AsyncClient | None = None,
) -> tuple[str, Path]:
    """呼び出し側を変えずに、Style-Bert-VITS2とOpenAI互換APIを設定で切り替えます。"""
    if config.tts_provider == OPENAI_PROVIDER:
        return await openai_speech.synthesize(text, config, client)
    return await stylebertvits2.synthesize(text, config, client)


async def iter_speech_pcm(
    text: str,
    config: Settings,
    client: httpx.AsyncClient,
):
    """OpenAI互換のSSEから、再生できるPCMを届いた順に返します。"""
    async for item in openai_speech.iter_speech_pcm(text, config, client):
        yield item


def create_transcriber(config: Settings) -> Any:
    """起動時の設定に合わせ、ローカル推論かOpenAI互換APIの認識器を用意します。"""
    if config.stt_provider == OPENAI_PROVIDER:
        return openai_speech.OpenAiTranscriber(config)
    return FasterWhisperTranscriber(config)


def transcription_status(config: Settings) -> dict[str, Any]:
    """UIが利用可否と対処方法を判断できる、提供元ごとの音声入力状態を返します。"""
    if config.stt_provider == OPENAI_PROVIDER:
        # 外部サーバーの状態は起動時に確かめられないため、失敗は録音後のエラーで伝えます。
        return {
            "enabled": config.stt_enabled,
            "provider": OPENAI_PROVIDER,
            "available": config.stt_enabled,
            "model": config.openai_stt_model,
            "device": "",
            "compute_type": "",
            "message": None,
        }
    installed = is_model_installed(config)
    return {
        "enabled": config.stt_enabled,
        "provider": "faster_whisper",
        "available": config.stt_enabled and installed,
        "model": config.stt_model,
        "device": config.stt_device,
        "compute_type": config.stt_compute_type,
        "message": None if not config.stt_enabled or installed else _MODEL_MISSING_NOTICE,
    }
