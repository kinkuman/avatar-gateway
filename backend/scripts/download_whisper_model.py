"""通常起動中の通信と分離し、faster-whisperモデルを明示操作で取得します。"""

from collections.abc import Callable
from pathlib import Path

from faster_whisper.utils import download_model

from app.config import Settings
from app.services.faster_whisper import is_model_installed


ModelDownloader = Callable[..., str]


def install_whisper_model(
    config: Settings,
    downloader: ModelDownloader = download_model,
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
