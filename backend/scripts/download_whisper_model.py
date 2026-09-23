"""通常起動中の通信と分離し、faster-whisperモデルを明示操作で取得します。"""

from collections.abc import Callable
from pathlib import Path

from faster_whisper.utils import _MODELS
from huggingface_hub import snapshot_download

from app.config import Settings
from app.services.faster_whisper import is_model_installed


ModelDownloader = Callable[..., str]
_MODEL_FILE_PATTERNS = (
    "config.json",
    "preprocessor_config.json",
    "model.bin",
    "tokenizer.json",
    "vocabulary.*",
)


def download_model_with_progress(
    size_or_id: str,
    output_dir: str,
    local_files_only: bool = False,
) -> str:
    """公式の転送表示を使い、音声認識に必要なモデルファイルだけを取得します。"""
    # faster-whisperと同じ別名解決を使い、対応モデル追加時の食い違いを避けます。
    repository_id = size_or_id if "/" in size_or_id else _MODELS.get(size_or_id)
    if repository_id is None:
        raise ValueError(
            f"未対応のWhisperモデルです: {size_or_id} "
            f"(選択肢: {', '.join(_MODELS)})",
        )
    return snapshot_download(
        repository_id,
        local_dir=output_dir,
        local_files_only=local_files_only,
        allow_patterns=list(_MODEL_FILE_PATTERNS),
    )


def install_whisper_model(
    config: Settings,
    downloader: ModelDownloader = download_model_with_progress,
) -> Path:
    """設定済みモデルを指定保存先へ取得し、通常起動がオフラインで使える状態にします。"""
    destination = config.stt_model_dir.resolve()
    destination.mkdir(parents=True, exist_ok=True)

    print(f"faster-whisper用の{config.stt_model}モデルをダウンロードします。")
    print(f"保存先: {destination}")
    print("この処理にはインターネット接続が必要です。")
    downloader(config.stt_model, output_dir=str(destination), local_files_only=False)

    if not is_model_installed(config):
        raise RuntimeError("モデルの取得が完了しませんでした。保存先を確認して再実行してください。")
    print("Whisperモデルのインストールが完了しました。")
    return destination


def main() -> None:
    """コマンドラインから現在の.env設定を使ってモデル取得を開始します。"""
    install_whisper_model(Settings())


if __name__ == "__main__":
    main()
