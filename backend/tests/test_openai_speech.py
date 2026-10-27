"""OpenAI互換サーバーを起動せず、音声合成と音声認識の送受信を検証します。"""

import base64
import math
import struct
import wave
from array import array
from dataclasses import replace
from io import BytesIO

import httpx
import pytest

from app.config import settings
from app.services import openai_speech, speech_backends
from app.services.openai_speech import (
    OpenAiTranscriber,
    SpeechStreamUnsupported,
    api_endpoint,
    is_wav,
    iter_speech_pcm,
    speech_payload,
    to_wav,
)
from app.services.speech_base import (
    NoSpeechDetectedError,
    TranscriptionError,
    TranscriptionUnavailableError,
    TtsError,
)


def _pcm_tone(seconds: float, rate: int, channels: int) -> bytes:
    """numpyに頼らず、変換結果を確認できる長さの試験音を作ります。"""
    samples = array("h")
    for index in range(int(seconds * rate)):
        value = int(12_000 * math.sin(2 * math.pi * 440 * index / rate))
        samples.extend(value for _ in range(channels))
    return struct.pack(f"<{len(samples)}h", *samples)


def _wav_recording(seconds: float = 0.3, rate: int = 44_100, channels: int = 2) -> bytes:
    """ブラウザがWAVを送る場合の録音を、外部ファイルなしで用意します。"""
    destination = BytesIO()
    with wave.open(destination, "wb") as writer:
        writer.setnchannels(channels)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        writer.writeframes(_pcm_tone(seconds, rate, channels))
    return destination.getvalue()


def _webm_recording(seconds: float = 0.3) -> bytes:
    """MediaRecorderが送るWebM/Opusと同じ形式の録音を作ります。"""
    av = pytest.importorskip("av")
    source = BytesIO(_wav_recording(seconds, rate=48_000, channels=1))
    destination = BytesIO()
    with av.open(source) as reader, av.open(destination, mode="w", format="webm") as writer:
        stream = writer.add_stream("libopus", rate=48_000, layout="mono")
        for frame in reader.decode(audio=0):
            frame.pts = None
            writer.mux(stream.encode(frame))
        writer.mux(stream.encode(None))
    return destination.getvalue()


class _RecordingClient:
    """通信せずに、送信内容を記録して固定応答を返すHTTPクライアントです。"""

    def __init__(self, response: httpx.Response) -> None:
        self.response = response
        self.calls: list[dict] = []

    async def __aenter__(self) -> "_RecordingClient":
        return self

    async def __aexit__(self, _exc_type, _exc, _traceback) -> None:
        return None

    async def post(self, url, **options):
        self.calls.append({"url": url, **options})
        return self.response


def test_base_url_without_version_reaches_openai_paths() -> None:
    """既定の`http://127.0.0.1:8080/`にも`/v1`を補い、二重付与はしません。"""
    assert api_endpoint("http://127.0.0.1:8080/", "audio/speech") == (
        "http://127.0.0.1:8080/v1/audio/speech"
    )
    assert api_endpoint("https://api.openai.com/v1", "audio/transcriptions") == (
        "https://api.openai.com/v1/audio/transcriptions"
    )


def test_speech_request_leaves_out_unset_members() -> None:
    """未設定のvoiceやspeedを送ると拒否されるため、本文へ入れません。
    環境変数の設定に左右されないよう、未設定項目は明示的に無効化します。"""
    config = replace(
        settings,
        openai_tts_voice="none",
        openai_tts_model=None,
        openai_tts_speed=None,
        openai_tts_language=None,
    )

    payload = speech_payload("こんにちは。", config)

    assert payload == {"input": "こんにちは。", "response_format": "wav"}


def test_speech_request_sends_configured_members() -> None:
    """設定した声やモデルは、OpenAIの項目名のまま送ります。"""
    config = replace(
        settings,
        openai_tts_model="qwen3-tts-0.6b",
        openai_tts_voice="ono_anna",
        openai_tts_speed=1.2,
        openai_tts_language="ja",
    )

    payload = speech_payload("明日の東京は晴れです。", config)

    assert payload == {
        "input": "明日の東京は晴れです。",
        "response_format": "wav",
        "model": "qwen3-tts-0.6b",
        "voice": "ono_anna",
        "speed": 1.2,
        "language": "ja",
    }


@pytest.mark.asyncio
async def test_synthesize_saves_wav_from_openai_endpoint(tmp_path) -> None:
    """合成結果を既存の配信経路と同じ一時WAVへ保存し、鍵はヘッダーで送ります。"""
    client = _RecordingClient(httpx.Response(200, content=b"wav-data"))
    config = replace(
        settings,
        audio_dir=tmp_path,
        openai_tts_voice="ono_anna",
        openai_tts_api_key="local-key",
    )

    utterance_id, path = await openai_speech.synthesize("こんにちは。", config, client)

    assert client.calls[0]["url"] == "http://127.0.0.1:8080/v1/audio/speech"
    assert client.calls[0]["headers"] == {"Authorization": "Bearer local-key"}
    assert client.calls[0]["json"]["voice"] == "ono_anna"
    assert path == tmp_path / f"{utterance_id}.wav"
    assert path.read_bytes() == b"wav-data"


@pytest.mark.asyncio
async def test_synthesize_reports_server_error_message(tmp_path) -> None:
    """声やモデルの指定ミスを直せるよう、OpenAI形式のエラー本文を伝えます。"""
    client = _RecordingClient(httpx.Response(
        400,
        json={"error": {"message": "unknown voice", "param": "voice"}},
    ))
    config = replace(settings, audio_dir=tmp_path)

    with pytest.raises(TtsError, match="unknown voice"):
        await openai_speech.synthesize("こんにちは。", config, client)


def test_browser_recording_is_converted_to_mono_16k_wav() -> None:
    """WAVしか受け取らないサーバーへ渡せるよう、WebM録音を変換します。"""
    converted = to_wav(_webm_recording())

    assert is_wav(converted)
    with wave.open(BytesIO(converted)) as reader:
        assert reader.getnchannels() == 1
        assert reader.getframerate() == openai_speech.TRANSCRIBE_SAMPLE_RATE
        assert reader.getsampwidth() == 2
        assert reader.getnframes() > 0


@pytest.mark.asyncio
async def test_transcription_sends_wav_and_configured_fields() -> None:
    """録音をWAVの多部分形式で送り、設定した項目だけを添えます。"""
    client = _RecordingClient(httpx.Response(200, json={"text": "音声入力です。"}))
    config = replace(
        settings,
        openai_stt_model="reazonspeech-nemo-v2",
        openai_stt_language="ja",
        openai_stt_prompt="水瀬紬",
    )
    transcriber = OpenAiTranscriber(config, client_factory=lambda: client)

    result = await transcriber.transcribe(_webm_recording())

    call = client.calls[0]
    assert call["url"] == "http://127.0.0.1:8080/v1/audio/transcriptions"
    assert call["data"] == {
        "response_format": "json",
        "model": "reazonspeech-nemo-v2",
        "language": "ja",
        "prompt": "水瀬紬",
    }
    file_name, file_bytes, media_type = call["files"]["file"]
    assert (file_name, media_type) == ("speech.wav", "audio/wav")
    assert is_wav(file_bytes)
    assert result["text"] == "音声入力です。"
    assert result["language"] == "ja"
    assert result["duration"] == pytest.approx(0.3, abs=0.05)


@pytest.mark.asyncio
async def test_transcription_forwards_wav_recording_unchanged() -> None:
    """すでにWAVの録音は作り直さず、送信前の再エンコードを省きます。"""
    recording = _wav_recording()
    client = _RecordingClient(httpx.Response(200, json={"text": "そのまま送ります。"}))
    transcriber = OpenAiTranscriber(settings, client_factory=lambda: client)

    await transcriber.transcribe(recording)

    assert client.calls[0]["files"]["file"][1] == recording


@pytest.mark.asyncio
async def test_transcription_reads_verbose_json_metadata() -> None:
    """verbose_jsonを選んだ場合は、サーバーが返した言語と長さを優先します。"""
    client = _RecordingClient(httpx.Response(200, json={
        "task": "transcribe",
        "language": "ja,en",
        "duration": 12.5,
        "text": "詳細な応答です。",
    }))
    config = replace(settings, openai_stt_response_format="verbose_json")
    transcriber = OpenAiTranscriber(config, client_factory=lambda: client)

    result = await transcriber.transcribe(_wav_recording())

    assert client.calls[0]["data"]["response_format"] == "verbose_json"
    assert result == {"text": "詳細な応答です。", "language": "ja,en", "duration": 12.5}


@pytest.mark.asyncio
async def test_transcription_rejects_empty_result() -> None:
    """誰も話していない録音を、空のHermes入力として送信しません。"""
    client = _RecordingClient(httpx.Response(200, json={"text": "   "}))
    transcriber = OpenAiTranscriber(settings, client_factory=lambda: client)

    with pytest.raises(NoSpeechDetectedError, match="発話を認識できませんでした"):
        await transcriber.transcribe(_wav_recording())


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "expected"),
    (
        (404, TranscriptionUnavailableError),
        (503, TranscriptionUnavailableError),
        (400, TranscriptionError),
    ),
)
async def test_transcription_separates_setup_failures_from_bad_audio(
    status: int,
    expected: type[Exception],
) -> None:
    """モデル未読み込みと録音の問題を、利用者が区別できる例外へ分けます。"""
    client = _RecordingClient(httpx.Response(
        status,
        json={"error": {"message": "no recognition model"}},
    ))
    transcriber = OpenAiTranscriber(settings, client_factory=lambda: client)

    with pytest.raises(expected, match="no recognition model"):
        await transcriber.transcribe(_wav_recording())


@pytest.mark.asyncio
async def test_transcription_reports_unreachable_server() -> None:
    """接続できないサーバーを録音の失敗と混同せず、準備不足として伝えます。"""
    class _FailingClient(_RecordingClient):
        async def post(self, url, **options):
            raise httpx.ConnectError("connection refused")

    transcriber = OpenAiTranscriber(
        settings,
        client_factory=lambda: _FailingClient(httpx.Response(200)),
    )

    with pytest.raises(TranscriptionUnavailableError, match="音声認識サーバーへ接続できません"):
        await transcriber.transcribe(_wav_recording())


@pytest.mark.asyncio
async def test_provider_setting_selects_openai_synthesis(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """呼び出し側を変えずに、設定だけで合成の提供元を切り替えます。"""
    requested: list[str] = []

    async def fake_openai_synthesize(text, _config, _client):
        requested.append(text)
        return "utterance", tmp_path / "utterance.wav"

    async def fake_stylebertvits2_synthesize(*_args, **_kwargs):
        raise AssertionError("OpenAI互換を選んだ場合はStyle-Bert-VITS2を呼びません")

    monkeypatch.setattr(speech_backends.openai_speech, "synthesize", fake_openai_synthesize)
    monkeypatch.setattr(
        speech_backends.stylebertvits2,
        "synthesize",
        fake_stylebertvits2_synthesize,
    )

    await speech_backends.synthesize("こんにちは。", replace(settings, tts_provider="openai"))

    assert requested == ["こんにちは。"]


def test_provider_setting_selects_openai_transcriber() -> None:
    """音声入力も設定だけで、ローカル推論とOpenAI互換APIを切り替えます。"""
    openai_transcriber = speech_backends.create_transcriber(
        replace(settings, stt_provider="openai"),
    )
    local_transcriber = speech_backends.create_transcriber(
        replace(settings, stt_provider="faster_whisper"),
    )

    assert isinstance(openai_transcriber, OpenAiTranscriber)
    assert not isinstance(local_transcriber, OpenAiTranscriber)


def test_openai_transcription_status_needs_no_local_model() -> None:
    """OpenAI互換APIではモデル導入案内を出さず、有効ならマイクを使えると伝えます。"""
    status = speech_backends.transcription_status(replace(
        settings,
        stt_enabled=True,
        stt_provider="openai",
        openai_stt_model="reazonspeech-nemo-v2",
    ))

    assert status == {
        "enabled": True,
        "provider": "openai",
        "available": True,
        "model": "reazonspeech-nemo-v2",
        "device": "",
        "compute_type": "",
        "message": None,
    }


class _ByteResponse:
    """httpxのストリーム応答のうち、テストが使う部分だけを再現します。"""

    def __init__(self, status_code: int, headers: dict[str, str], chunks: list[bytes], body: bytes = b"") -> None:
        self.status_code = status_code
        self.headers = httpx.Headers(headers)
        self._chunks = chunks
        self._body = body

    async def __aenter__(self) -> "_ByteResponse":
        return self

    async def __aexit__(self, _exc_type, _exc, _traceback) -> None:
        return None

    async def aiter_bytes(self, chunk_size: int | None = None):
        del chunk_size
        for chunk in self._chunks:
            yield chunk

    async def aread(self) -> bytes:
        return self._body


class _StreamClient:
    """stream()だけを記録し、接続は開きません。"""

    def __init__(self, response: _ByteResponse) -> None:
        self.response = response
        self.calls: list[dict] = []

    def stream(self, method: str, url: str, **options):
        self.calls.append({"method": method, "url": url, **options})
        return self.response


@pytest.mark.asyncio
async def test_sse_pcm_is_yielded_before_the_event_line_closes() -> None:
    """speech.cppが長い1行で送っても、閉じ引用符の前にPCMを返します。"""
    tone = _pcm_tone(0.2, 16_000, 1)
    encoded = base64.b64encode(tone).decode("ascii")
    split = len(encoded) // 2
    first = ('data: {"type":"speech.audio.delta","audio":"' + encoded[:split]).encode()
    second = (
        encoded[split:]
        + '"}\n\ndata: {"type":"speech.audio.done","samples":1,"stop":"complete"}\n\n'
    ).encode()
    client = _StreamClient(_ByteResponse(200, {"x-sample-rate": "16000"}, [first, second]))

    received: list[tuple[str, object]] = []
    async for item in iter_speech_pcm("はい。", settings, client):
        received.append(item)
        if item[0] == "pcm":
            break

    assert received[0] == ("rate", 16_000)
    assert received[1][0] == "pcm"
    assert client.calls[0]["json"]["response_format"] == "pcm"
    assert client.calls[0]["json"]["stream_format"] == "sse"


@pytest.mark.asyncio
async def test_sse_refusal_falls_back_instead_of_a_voice_error() -> None:
    """SSE非対応だけをWAVへ戻し、声の指定ミスはそのまま伝えます。"""
    unsupported = _StreamClient(_ByteResponse(
        400,
        {},
        [],
        b'{"error":{"message":"unsupported stream_format","param":"stream_format"}}',
    ))
    with pytest.raises(SpeechStreamUnsupported):
        async for _item in iter_speech_pcm("はい。", settings, unsupported):
            pass

    voice_error = _StreamClient(_ByteResponse(
        400,
        {},
        [],
        b'{"error":{"message":"unknown voice","param":"voice"}}',
    ))
    with pytest.raises(TtsError, match="unknown voice"):
        async for _item in iter_speech_pcm("はい。", settings, voice_error):
            pass
