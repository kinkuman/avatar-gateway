"""実モデルや外部通信なしで、音声認識サービスとHTTP境界を検証します。"""

from dataclasses import replace
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app import main as main_module
from app.services.faster_whisper import (
    FasterWhisperTranscriber,
    NoSpeechDetectedError,
    TranscriptionError,
    TranscriptionUnavailableError,
    is_model_installed,
)
from scripts.download_whisper_model import (
    download_model_with_progress,
    install_whisper_model,
)


class FakeSegment:
    """faster-whisperが遅延返却する一つの認識区間を再現します。"""

    def __init__(self, text: str) -> None:
        self.text = text


class FakeModel:
    """入力オプションを記録し、固定した日本語認識結果を返します。"""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def transcribe(self, audio, **options):
        assert audio.read() == b"browser-audio"
        self.calls.append(options)
        return iter((FakeSegment(" こんにちは。"), FakeSegment("元気ですか。 "))), SimpleNamespace(
            language="ja",
            duration=2.5,
        )


def test_transcriber_uses_cpu_int8_and_reuses_model(tmp_path) -> None:
    """CPU設定とモデル一回ロードを維持し、短い区間を一つの会話入力へ連結します。"""
    created: list[dict] = []
    model = FakeModel()

    def factory(model_name: str, **options):
        created.append({"model": model_name, **options})
        return model

    config = replace(
        main_module.settings,
        stt_model="small",
        stt_device="cpu",
        stt_compute_type="int8",
        stt_cpu_threads=8,
        stt_beam_size=3,
        stt_model_dir=tmp_path,
        stt_local_files_only=False,
    )
    transcriber = FasterWhisperTranscriber(config, model_factory=factory)

    first = transcriber._transcribe_sync(b"browser-audio")
    second = transcriber._transcribe_sync(b"browser-audio")

    assert first == {"text": "こんにちは。元気ですか。", "language": "ja", "duration": 2.5}
    assert second == first
    assert created == [{
        "model": "small",
        "device": "cpu",
        "compute_type": "int8",
        "cpu_threads": 8,
        "download_root": str(tmp_path),
        "local_files_only": False,
    }]
    assert len(model.calls) == 2
    assert model.calls[0]["language"] == "ja"
    assert model.calls[0]["beam_size"] == 3
    assert model.calls[0]["vad_filter"] is True
    assert model.calls[0]["condition_on_previous_text"] is False


def test_transcriber_rejects_silence(tmp_path) -> None:
    """VAD後に本文が残らない音声を、空のHermes入力として送信しません。"""
    class SilentModel:
        def transcribe(self, _audio, **_options):
            return iter((FakeSegment("  "),)), SimpleNamespace(language="ja", duration=1.0)

    config = replace(main_module.settings, stt_model_dir=tmp_path, stt_local_files_only=False)
    transcriber = FasterWhisperTranscriber(config, model_factory=lambda *_args, **_kwargs: SilentModel())

    with pytest.raises(NoSpeechDetectedError, match="発話を認識できませんでした"):
        transcriber._transcribe_sync(b"browser-audio")


@pytest.mark.asyncio
async def test_transcriber_moves_inference_outside_event_loop(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """本番ではCPU推論を別スレッドへ渡す非同期境界を通ることを確認します。"""
    config = replace(main_module.settings, stt_model_dir=tmp_path, stt_local_files_only=False)
    transcriber = FasterWhisperTranscriber(config, model_factory=lambda *_args, **_kwargs: FakeModel())
    calls: list[tuple] = []

    async def fake_to_thread(function, *args):
        calls.append((function, args))
        return function(*args)

    monkeypatch.setattr("app.services.faster_whisper.asyncio.to_thread", fake_to_thread)

    result = await transcriber.transcribe(b"browser-audio")

    assert result["text"] == "こんにちは。元気ですか。"
    assert calls == [(transcriber._transcribe_sync, (b"browser-audio",))]


def test_normal_runtime_rejects_missing_model_without_downloading(tmp_path) -> None:
    """通常起動では未導入モデルを外部取得せず、明示導入手順を案内します。"""
    config = replace(main_module.settings, stt_model_dir=tmp_path, stt_local_files_only=True)
    transcriber = FasterWhisperTranscriber(
        config,
        model_factory=lambda *_args, **_kwargs: pytest.fail("モデル生成を開始してはいけません"),
    )

    with pytest.raises(TranscriptionUnavailableError, match="モデルがインストールされていません"):
        transcriber._transcribe_sync(b"browser-audio")


def test_transcriber_loads_explicitly_installed_model_directory(tmp_path) -> None:
    """明示導入先を直接渡し、キャッシュ形式として再探索される不具合を防ぎます。"""
    for file_name in ("config.json", "model.bin", "tokenizer.json"):
        (tmp_path / file_name).write_bytes(b"installed")

    created: list[dict] = []

    def factory(model_source: str, **options):
        created.append({"model": model_source, **options})
        return FakeModel()

    config = replace(
        main_module.settings,
        stt_model="small",
        stt_model_dir=tmp_path,
        stt_local_files_only=True,
    )
    transcriber = FasterWhisperTranscriber(config, model_factory=factory)

    transcriber._transcribe_sync(b"browser-audio")

    assert created == [{
        "model": str(tmp_path),
        "device": config.stt_device,
        "compute_type": config.stt_compute_type,
        "cpu_threads": config.stt_cpu_threads,
        "download_root": str(tmp_path),
        "local_files_only": True,
    }]


def test_explicit_installer_downloads_and_verifies_model(tmp_path) -> None:
    """導入コマンドだけが通信を許可し、通常起動用の必須ファイルを揃えます。"""
    config = replace(main_module.settings, stt_model="small", stt_model_dir=tmp_path)
    calls: list[dict] = []

    def fake_download(model_name: str, **options) -> str:
        calls.append({"model": model_name, **options})
        for file_name in ("config.json", "model.bin", "tokenizer.json"):
            (tmp_path / file_name).write_bytes(b"installed")
        return str(tmp_path)

    installed_path = install_whisper_model(config, downloader=fake_download)

    assert installed_path == tmp_path
    assert is_model_installed(config) is True
    assert calls == [{
        "model": "small",
        "output_dir": str(tmp_path),
        "local_files_only": False,
    }]


def test_progress_downloader_uses_hugging_face_snapshot(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """進捗を隠すfaster-whisper経路を避け、公式の通常表示で必要ファイルだけ取得します。"""
    calls: list[dict] = []

    def fake_snapshot_download(repository_id: str, **options) -> str:
        calls.append({"repository_id": repository_id, **options})
        return str(tmp_path)

    monkeypatch.setattr(
        "scripts.download_whisper_model.snapshot_download",
        fake_snapshot_download,
    )

    result = download_model_with_progress(
        "small",
        output_dir=str(tmp_path),
        local_files_only=False,
    )

    assert result == str(tmp_path)
    assert calls == [{
        "repository_id": "Systran/faster-whisper-small",
        "local_dir": str(tmp_path),
        "local_files_only": False,
        "allow_patterns": [
            "config.json",
            "preprocessor_config.json",
            "model.bin",
            "tokenizer.json",
            "vocabulary.*",
        ],
    }]


class FakeRequest:
    """StarletteサーバーなしでContent-Typeと分割ボディをAPIへ渡します。"""

    def __init__(self, chunks: tuple[bytes, ...], content_type: str) -> None:
        self.headers = {
            "content-type": content_type,
            "content-length": str(sum(len(chunk) for chunk in chunks)),
        }
        self._chunks = chunks

    async def stream(self):
        for chunk in self._chunks:
            yield chunk


@pytest.mark.asyncio
async def test_transcription_route_accepts_browser_audio(monkeypatch: pytest.MonkeyPatch) -> None:
    """MediaRecorderのcodec付きMIMEを許可し、生バイトを認識サービスへ渡します。"""
    class StubTranscriber:
        async def transcribe(self, audio: bytes) -> dict:
            assert audio == b"webm-data"
            return {"text": "音声入力です。", "language": "ja", "duration": 1.2}

    monkeypatch.setattr(main_module, "transcriber", StubTranscriber())
    monkeypatch.setattr(main_module, "settings", replace(main_module.settings, stt_enabled=True))

    response = await main_module.transcribe_audio(
        FakeRequest((b"webm-", b"data"), "audio/webm;codecs=opus"),
    )

    assert response["text"] == "音声入力です。"


@pytest.mark.asyncio
async def test_transcription_route_rejects_unknown_media_type() -> None:
    """任意バイナリを音声デコーダーへ渡さず、対応形式だけを受け付けます。"""
    with pytest.raises(HTTPException) as captured:
        await main_module.transcribe_audio(FakeRequest((b"data",), "application/octet-stream"))

    assert captured.value.status_code == 415


@pytest.mark.asyncio
async def test_transcription_route_rejects_oversized_body(monkeypatch: pytest.MonkeyPatch) -> None:
    """Content-Lengthの有無によらず、設定上限より大きい録音を保持しません。"""
    monkeypatch.setattr(
        main_module,
        "settings",
        replace(main_module.settings, stt_enabled=True, stt_max_audio_bytes=4),
    )

    with pytest.raises(HTTPException) as captured:
        await main_module.transcribe_audio(FakeRequest((b"12345",), "audio/webm"))

    assert captured.value.status_code == 413


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("failure", "detail", "log_fragment"),
    (
        (
            NoSpeechDetectedError("発話を認識できませんでした"),
            "発話を認識できませんでした",
            "no speech detected",
        ),
        (
            TranscriptionError("音声を文字起こしできません"),
            "音声を文字起こしできません",
            "audio decode or inference failed",
        ),
    ),
)
async def test_transcription_route_distinguishes_422_causes(
    failure: Exception,
    detail: str,
    log_fragment: str,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """運用ログと応答本文で、環境音と壊れた録音コンテナを区別できるようにします。"""
    class FailingTranscriber:
        async def transcribe(self, _audio: bytes) -> dict:
            raise failure

    monkeypatch.setattr(main_module, "transcriber", FailingTranscriber())
    monkeypatch.setattr(main_module, "settings", replace(main_module.settings, stt_enabled=True))
    caplog.set_level("INFO", logger="avatar_gateway")

    with pytest.raises(HTTPException) as captured:
        await main_module.transcribe_audio(FakeRequest((b"webm-data",), "audio/webm"))

    assert captured.value.status_code == 422
    assert captured.value.detail == detail
    assert log_fragment in caplog.text
