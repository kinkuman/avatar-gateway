"""ブラウザ音声をCPU版faster-whisperへ渡し、会話入力用の日本語テキストへ変換します。"""

import asyncio
from collections.abc import Callable
from io import BytesIO
import threading
from typing import Any

from ..config import Settings


_REQUIRED_MODEL_FILES = frozenset({"config.json", "model.bin", "tokenizer.json"})


def is_model_installed(config: Settings) -> bool:
    """通常起動で外部取得を試さずに済むよう、明示導入済みモデルの必須ファイルを確認します。"""
    model_directory = config.stt_model_dir
    return model_directory.is_dir() and all(
        (model_directory / file_name).is_file()
        for file_name in _REQUIRED_MODEL_FILES
    )


class TranscriptionError(RuntimeError):
    """音声デコードや推論の失敗を、内部情報を含まないAPIエラーへまとめます。"""


class TranscriptionUnavailableError(TranscriptionError):
    """依存関係やモデルを準備できず、音声認識を開始できない場合に使います。"""


class NoSpeechDetectedError(TranscriptionError):
    """正常に処理できたものの、送信できる発話本文が得られない場合に使います。"""


class FasterWhisperTranscriber:
    """モデルを一度だけロードし、CPU推論を直列化してWebサーバーの応答性を保ちます。"""

    def __init__(
        self,
        config: Settings,
        model_factory: Callable[..., Any] | None = None,
    ) -> None:
        self._config = config
        self._model_factory = model_factory
        self._model: Any | None = None
        self._model_lock = threading.Lock()
        self._inference_lock = asyncio.Lock()

    def _create_model(self) -> Any:
        """通常実行時だけ外部依存を読み込み、音声OFFのテストや運用を壊しません。"""
        if self._config.stt_local_files_only and not is_model_installed(self._config):
            raise TranscriptionUnavailableError(
                "Whisperモデルがインストールされていません。READMEの音声認識モデル導入手順を実行してください",
            )
        factory = self._model_factory
        if factory is None:
            try:
                from faster_whisper import WhisperModel
            except ImportError as exc:
                raise TranscriptionUnavailableError(
                    "faster-whisperがインストールされていません",
                ) from exc
            factory = WhisperModel

        try:
            self._config.stt_model_dir.mkdir(parents=True, exist_ok=True)
            return factory(
                self._config.stt_model,
                device=self._config.stt_device,
                compute_type=self._config.stt_compute_type,
                cpu_threads=self._config.stt_cpu_threads,
                download_root=str(self._config.stt_model_dir),
                local_files_only=self._config.stt_local_files_only,
            )
        except TranscriptionUnavailableError:
            raise
        except Exception as exc:
            raise TranscriptionUnavailableError(
                "faster-whisperモデルを読み込めません",
            ) from exc

    def _get_model(self) -> Any:
        """同時リクエストでも大きなモデルを重複ロードしないよう初期化を保護します。"""
        if self._model is not None:
            return self._model
        with self._model_lock:
            if self._model is None:
                self._model = self._create_model()
        return self._model

    def _transcribe_sync(self, audio: bytes) -> dict[str, Any]:
        """短い会話音声を一括認識し、空白を整えた本文と診断用メタデータを返します。"""
        model = self._get_model()
        try:
            segments, info = model.transcribe(
                BytesIO(audio),
                language=self._config.stt_language,
                task="transcribe",
                beam_size=self._config.stt_beam_size,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 300},
                condition_on_previous_text=False,
            )
            text = "".join(str(segment.text) for segment in segments).strip()
        except TranscriptionUnavailableError:
            raise
        except Exception as exc:
            raise TranscriptionError("音声を文字起こしできません") from exc

        if not text:
            raise NoSpeechDetectedError("発話を認識できませんでした")
        duration = getattr(info, "duration", None)
        language = getattr(info, "language", None)
        return {
            "text": text,
            "language": language if isinstance(language, str) else self._config.stt_language,
            "duration": float(duration) if isinstance(duration, (int, float)) else None,
        }

    async def transcribe(self, audio: bytes) -> dict[str, Any]:
        """CPU処理をイベントループ外で一件ずつ実行し、Hermesや画面APIを塞ぎません。"""
        async with self._inference_lock:
            return await asyncio.to_thread(self._transcribe_sync, audio)
