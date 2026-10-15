"""OpenAI互換の音声APIへ合成と認識を委ね、speech.cppなどのサーバーを利用します。"""

import asyncio
import base64
import json
import re
from collections.abc import AsyncIterator, Callable
from io import BytesIO
from pathlib import Path
from typing import Any
import wave

import httpx

from ..config import Settings
from .speech_base import (
    NoSpeechDetectedError,
    StreamingSilenceTrimmer,
    TranscriptionError,
    TranscriptionUnavailableError,
    TtsError,
    create_tts_client,
    store_utterance_audio,
)

_AUDIO_FIELD = re.compile(r'"audio"\s*:\s*"')
_DONE_EVENT = '"type":"speech.audio.done"'
_BATCH_MS = 40


# OpenAI互換サーバーは知らない項目を無視せず拒否するため、未設定の声は本文へ入れません。
UNSET_VOICE_VALUES = frozenset({"", "none"})
# 認識サーバーが必ず受け取れるよう、録音は16kHzモノラルのWAVへそろえてから送ります。
TRANSCRIBE_SAMPLE_RATE = 16_000


def api_endpoint(base_url: str, path: str) -> str:
    """`http://127.0.0.1:8080/`のような基点にも、OpenAIの`/v1`配下を補います。"""
    base = base_url.strip().rstrip("/")
    if not base.endswith("/v1"):
        base = f"{base}/v1"
    return f"{base}/{path}"


def _authorization_headers(api_key: str) -> dict[str, str]:
    """鍵を設定したときだけBearerを付け、認証のないローカルサーバーも使えるようにします。"""
    return {"Authorization": f"Bearer {api_key}"} if api_key else {}


def _error_message(response: httpx.Response) -> str:
    """OpenAI形式のエラー本文から、利用者が設定を直せる一文を取り出します。"""
    try:
        payload = response.json()
    except ValueError:
        payload = None
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            return error["message"]
        if isinstance(payload.get("detail"), str):
            return payload["detail"]
    return response.text[:500]


def speech_payload(text: str, config: Settings) -> dict[str, Any]:
    """`/api/audio/{id}.wav`でそのまま配信できるWAVを、設定済みの項目だけで要求します。"""
    payload: dict[str, Any] = {"input": text, "response_format": "wav"}
    if config.openai_tts_model:
        payload["model"] = config.openai_tts_model
    voice = config.openai_tts_voice.strip()
    if voice.lower() not in UNSET_VOICE_VALUES:
        payload["voice"] = voice
    if config.openai_tts_speed is not None:
        payload["speed"] = config.openai_tts_speed
    if config.openai_tts_instructions:
        payload["instructions"] = config.openai_tts_instructions
    if config.openai_tts_language:
        payload["language"] = config.openai_tts_language
    return payload


async def synthesize(
    text: str,
    config: Settings,
    client: httpx.AsyncClient | None = None,
) -> tuple[str, Path]:
    """OpenAI互換の音声合成を呼び、文単位の一時WAVとして保存します。"""
    if client is None:
        # 単体利用時も従来どおり呼べるよう、必要な場合だけ一時クライアントを所有します。
        async with create_tts_client() as owned_client:
            return await synthesize(text, config, owned_client)

    endpoint = api_endpoint(config.openai_tts_base_url, "audio/speech")
    try:
        response = await client.post(
            endpoint,
            json=speech_payload(text, config),
            headers=_authorization_headers(config.openai_tts_api_key),
        )
        if response.status_code >= 400:
            raise TtsError(
                f"OpenAI互換TTS APIエラー ({response.status_code}): {_error_message(response)}",
            )
    except httpx.HTTPError as exc:
        raise TtsError(f"OpenAI互換TTSへ接続できません: {exc}") from exc

    return await store_utterance_audio(response.content, config)


class SpeechStreamUnsupported(TtsError):
    """SSEのPCMを受け取れないサーバーなので、WAVの一括取得へ戻します。"""


def speech_stream_payload(text: str, config: Settings) -> dict[str, Any]:
    """生成中の音を先に受け取れるよう、PCMのSSEを要求します。"""
    payload = speech_payload(text, config)
    payload["response_format"] = "pcm"
    payload["stream_format"] = "sse"
    return payload


def _unsupported_stream(message: str) -> bool:
    """声の指定ミスと、SSE非対応の拒否を分けます。"""
    lowered = message.lower()
    return "stream_format" in lowered or "response_format" in lowered


def _error_message_from_bytes(body: bytes) -> str:
    """ストリームを読む前のエラー本文から、利用者向けの一文を取り出します。"""
    try:
        payload = json.loads(body)
    except ValueError:
        return body[:500].decode("utf-8", errors="replace")
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            return error["message"]
        if isinstance(payload.get("detail"), str):
            return payload["detail"]
    return body[:500].decode("utf-8", errors="replace")


def _decode_base64_ready(data: str) -> tuple[bytes, str]:
    """4文字揃った分だけPCMへ戻し、端数は次の受信まで残します。"""
    usable = len(data) - (len(data) % 4)
    if usable <= 0:
        return b"", data
    return base64.b64decode(data[:usable]), data[usable:]


def _decode_base64_final(data: str) -> bytes:
    """音声フィールドの末尾に付く端数も、パディングして残さず戻します。"""
    if not data:
        return b""
    return base64.b64decode(data + ("=" * ((-len(data)) % 4)))


def _sample_rate(headers: httpx.Headers) -> int:
    """speech.cppのX-Sample-Rateを優先し、無いときはOpenAIのPCM既定にします。"""
    raw = headers.get("x-sample-rate", "")
    if raw.isdigit():
        rate = int(raw)
        if 8_000 <= rate <= 96_000:
            return rate
    return 24_000


async def iter_speech_pcm(
    text: str,
    config: Settings,
    client: Any,
) -> AsyncIterator[tuple[str, Any]]:
    """SSEの1行が閉じる前でも、届いたPCMを再生できる単位で返します。"""
    endpoint = api_endpoint(config.openai_tts_base_url, "audio/speech")
    try:
        async with client.stream(
            "POST",
            endpoint,
            json=speech_stream_payload(text, config),
            headers=_authorization_headers(config.openai_tts_api_key),
        ) as response:
            if response.status_code >= 400:
                message = _error_message_from_bytes(await response.aread())
                if response.status_code == 400 and _unsupported_stream(message):
                    raise SpeechStreamUnsupported(message)
                raise TtsError(f"OpenAI互換TTS APIエラー ({response.status_code}): {message}")
            rate = _sample_rate(response.headers)
            yield ("rate", rate)
            async for kind, pcm in _iter_sse_pcm(response, rate):
                yield (kind, pcm)
    except SpeechStreamUnsupported:
        raise
    except TtsError:
        raise
    except httpx.HTTPError as exc:
        raise TtsError(f"OpenAI互換TTSへ接続できません: {exc}") from exc


async def _iter_sse_pcm(
    response: httpx.Response,
    rate: int,
) -> AsyncIterator[tuple[str, bytes | None]]:
    """`audio`フィールドの途中からbase64を解き、長い無音は詰めてから渡します。"""
    trimmer = StreamingSilenceTrimmer(rate)
    pending = ""
    in_audio = False
    batch = bytearray()
    batch_bytes = max(2, rate * 2 * _BATCH_MS // 1000)

    def take(pcm: bytes, force: bool = False) -> bytes | None:
        if pcm:
            batch.extend(pcm)
        if batch and (force or len(batch) >= batch_bytes):
            chunk = bytes(batch)
            batch.clear()
            return chunk
        return None

    async for chunk in response.aiter_bytes():
        pending += chunk.decode("ascii", errors="ignore")
        while pending:
            if not in_audio:
                done_at = pending.find(_DONE_EVENT)
                audio_match = _AUDIO_FIELD.search(pending)
                audio_at = audio_match.start() if audio_match else -1
                if done_at != -1 and (audio_at == -1 or done_at < audio_at):
                    tail = take(trimmer.finish(), force=True)
                    if tail:
                        yield ("pcm", tail)
                    yield ("done", None)
                    return
                if audio_match is None:
                    if '"error"' in pending:
                        message = _error_message_from_bytes(pending.encode("utf-8"))
                        raise TtsError(f"OpenAI互換TTS APIエラー: {message}")
                    keep = 32
                    if len(pending) > keep:
                        pending = pending[-keep:]
                    break
                pending = pending[audio_match.end():]
                in_audio = True
                continue
            end = pending.find('"')
            piece = pending if end == -1 else pending[:end]
            if end == -1:
                decoded, pending = _decode_base64_ready(piece)
                ready = take(trimmer.push(decoded))
                if ready:
                    yield ("pcm", ready)
                break
            decoded = _decode_base64_final(piece)
            ready = take(trimmer.push(decoded))
            if ready:
                yield ("pcm", ready)
            pending = pending[end + 1:]
            in_audio = False

    tail = take(trimmer.finish(), force=True)
    if tail:
        yield ("pcm", tail)
    yield ("done", None)


def is_wav(audio: bytes) -> bool:
    """すでにWAVの録音を作り直さず、無駄な再エンコードを避けます。"""
    return len(audio) >= 12 and audio[:4] == b"RIFF" and audio[8:12] == b"WAVE"


def to_wav(audio: bytes) -> bytes:
    """WAVしか受け取らないサーバーのため、ブラウザのWebMやMP4録音を変換します。"""
    try:
        import av
    except ImportError as exc:
        raise TranscriptionUnavailableError(
            "録音をWAVへ変換するavがインストールされていません",
        ) from exc

    destination = BytesIO()
    try:
        with (
            av.open(BytesIO(audio)) as source,
            av.open(destination, mode="w", format="wav") as sink,
        ):
            stream = sink.add_stream("pcm_s16le", rate=TRANSCRIBE_SAMPLE_RATE, layout="mono")
            resampler = av.AudioResampler(
                format="s16",
                layout="mono",
                rate=TRANSCRIBE_SAMPLE_RATE,
            )
            for frame in source.decode(audio=0):
                for resampled in resampler.resample(frame):
                    sink.mux(stream.encode(resampled))
            # 変換器と符号化器に残った末尾を押し出し、最後の発話を切り落としません。
            for resampled in resampler.resample(None):
                sink.mux(stream.encode(resampled))
            sink.mux(stream.encode(None))
    except Exception as exc:
        raise TranscriptionError("録音を音声データへ変換できません") from exc
    return destination.getvalue()


def _wav_duration(audio: bytes) -> float | None:
    """長さを返さない提供元でも、送った録音から会話ログ用の秒数を求めます。"""
    try:
        with wave.open(BytesIO(audio)) as source:
            frame_rate = source.getframerate()
            return source.getnframes() / frame_rate if frame_rate else None
    except Exception:
        return None


class OpenAiTranscriber:
    """OpenAI互換の文字起こしAPIへ録音を渡し、会話入力に使う本文を取り出します。"""

    def __init__(
        self,
        config: Settings,
        client_factory: Callable[[], Any] | None = None,
    ) -> None:
        self._config = config
        self._client_factory = client_factory or create_tts_client

    def _form_fields(self) -> dict[str, str]:
        """受け付けない項目を送ると拒否されるため、設定された項目だけを送ります。"""
        config = self._config
        fields = {"response_format": config.openai_stt_response_format}
        if config.openai_stt_model:
            fields["model"] = config.openai_stt_model
        if config.openai_stt_language:
            fields["language"] = config.openai_stt_language
        if config.openai_stt_prompt:
            fields["prompt"] = config.openai_stt_prompt
        return fields

    def _present(self, response: httpx.Response, audio: bytes) -> dict[str, Any]:
        """json・text・verbose_jsonのどの応答でも、同じ会話入力の形へそろえます。"""
        config = self._config
        payload: dict[str, Any] = {}
        if config.openai_stt_response_format == "text":
            text = response.text.strip()
        else:
            try:
                decoded = response.json()
            except ValueError as exc:
                raise TranscriptionError("音声認識サーバーの応答を解釈できません") from exc
            if not isinstance(decoded, dict):
                raise TranscriptionError("音声認識サーバーの応答を解釈できません")
            payload = decoded
            text = str(payload.get("text") or "").strip()

        if not text:
            raise NoSpeechDetectedError("発話を認識できませんでした")
        language = payload.get("language")
        duration = payload.get("duration")
        return {
            "text": text,
            "language": language if isinstance(language, str) else (config.openai_stt_language or None),
            "duration": (
                float(duration)
                if isinstance(duration, (int, float))
                else _wav_duration(audio)
            ),
        }

    async def transcribe(self, audio: bytes) -> dict[str, Any]:
        """録音の変換だけをスレッドへ逃がし、通信待ちでイベントループを塞ぎません。"""
        wav = audio if is_wav(audio) else await asyncio.to_thread(to_wav, audio)
        endpoint = api_endpoint(self._config.openai_stt_base_url, "audio/transcriptions")
        try:
            async with self._client_factory() as client:
                response = await client.post(
                    endpoint,
                    data=self._form_fields(),
                    files={"file": ("speech.wav", wav, "audio/wav")},
                    headers=_authorization_headers(self._config.openai_stt_api_key),
                )
        except httpx.HTTPError as exc:
            raise TranscriptionUnavailableError("音声認識サーバーへ接続できません") from exc

        if response.status_code in {404, 503}:
            raise TranscriptionUnavailableError(
                f"音声認識モデルを利用できません: {_error_message(response)}",
            )
        if response.status_code >= 400:
            raise TranscriptionError(
                f"音声を文字起こしできません: {_error_message(response)}",
            )
        return self._present(response, wav)
