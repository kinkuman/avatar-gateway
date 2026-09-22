"""秘密情報をブラウザへ渡さず、環境変数から接続設定を組み立てます。"""

from dataclasses import dataclass
from pathlib import Path
import os

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(PROJECT_ROOT / ".env")


def _as_bool(value: str | None, default: bool) -> bool:
    """表記揺れのある環境変数を安全な真偽値へ変換します。"""
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _as_csv(value: str | None, default: tuple[str, ...]) -> tuple[str, ...]:
    """許可ホスト等のカンマ区切り設定から、空要素を除いた値を作ります。"""
    if value is None:
        return default
    return tuple(item.strip() for item in value.split(",") if item.strip())


@dataclass(frozen=True)
class Settings:
    """アプリ全体で共有する接続先と製品・ローカル資産の設定を保持します。"""

    hermes_base_url: str = os.getenv("HERMES_BASE_URL", "http://127.0.0.1:8642/v1").rstrip("/")
    hermes_api_key: str = os.getenv("HERMES_API_KEY", "")
    hermes_model: str = os.getenv("HERMES_MODEL", "hermes-agent")
    daily_timezone: str = os.getenv("AVATAR_GATEWAY_TIMEZONE", "Asia/Tokyo").strip()
    hermes_image_cache_dir: Path = Path(os.getenv(
        "HERMES_IMAGE_CACHE_DIR",
        "~/.hermes/cache/images",
    )).expanduser()
    tts_enabled: bool = _as_bool(os.getenv("STYLEBERTVITS2_ENABLED"), True)
    tts_server_url: str = os.getenv("STYLEBERTVITS2_SERVER_URL", "http://127.0.0.1:5000").rstrip("/")
    tts_api_key: str = os.getenv("STYLEBERTVITS2_API_KEY", "")
    tts_model_id: int = int(os.getenv("STYLEBERTVITS2_MODEL_ID", "0"))
    tts_style: str = os.getenv("STYLEBERTVITS2_STYLE", "Neutral")
    tts_sdp_ratio: float = float(os.getenv("STYLEBERTVITS2_SDP_RATIO", "0.2"))
    tts_length: float = float(os.getenv("STYLEBERTVITS2_LENGTH", "1.0"))
    tts_chunk_min_chars: int = int(os.getenv("STYLEBERTVITS2_CHUNK_MIN_CHARS", "6"))
    tts_chunk_max_chars: int = int(os.getenv("STYLEBERTVITS2_CHUNK_MAX_CHARS", "100"))
    stt_enabled: bool = _as_bool(os.getenv("FASTER_WHISPER_ENABLED"), True)
    stt_model: str = os.getenv("FASTER_WHISPER_MODEL", "small").strip()
    stt_device: str = os.getenv("FASTER_WHISPER_DEVICE", "cpu").strip().lower()
    stt_compute_type: str = os.getenv("FASTER_WHISPER_COMPUTE_TYPE", "int8").strip().lower()
    stt_language: str = os.getenv("FASTER_WHISPER_LANGUAGE", "ja").strip().lower()
    stt_cpu_threads: int = int(os.getenv("FASTER_WHISPER_CPU_THREADS", "8"))
    stt_beam_size: int = int(os.getenv("FASTER_WHISPER_BEAM_SIZE", "3"))
    stt_model_dir: Path = Path(os.getenv(
        "FASTER_WHISPER_MODEL_DIR",
        str(PROJECT_ROOT / "local-assets" / "whisper"),
    )).expanduser()
    stt_local_files_only: bool = _as_bool(os.getenv("FASTER_WHISPER_LOCAL_FILES_ONLY"), True)
    stt_max_audio_bytes: int = int(os.getenv("FASTER_WHISPER_MAX_AUDIO_BYTES", str(16 * 1024 * 1024)))
    vrm_file: str = os.getenv("AVATAR_VRM_FILE", "はむ子.vrm")
    bundled_assets_dir: Path = PROJECT_ROOT / "assets"
    local_assets_dir: Path = PROJECT_ROOT / "local-assets"
    motion_catalog_file: Path = PROJECT_ROOT / "config" / "motions.json"
    ui_settings_file: Path = PROJECT_ROOT / "config" / "ui.json"
    audio_dir: Path = PROJECT_ROOT / "runtime" / "audio"
    image_dir: Path = PROJECT_ROOT / "runtime" / "images"
    image_retention_days: int = int(os.getenv("AVATAR_GATEWAY_IMAGE_RETENTION_DAYS", "90"))
    gateway_host: str = os.getenv("AVATAR_GATEWAY_HOST", "127.0.0.1").strip()
    gateway_port: int = int(os.getenv("AVATAR_GATEWAY_PORT", "8000"))
    gateway_lan_mode: bool = _as_bool(os.getenv("AVATAR_GATEWAY_LAN_MODE"), False)
    gateway_auth_username: str = os.getenv("AVATAR_GATEWAY_AUTH_USERNAME", "avatar").strip()
    gateway_auth_password: str = os.getenv("AVATAR_GATEWAY_AUTH_PASSWORD", "")
    gateway_allowed_hosts: tuple[str, ...] = _as_csv(
        os.getenv("AVATAR_GATEWAY_ALLOWED_HOSTS"),
        ("127.0.0.1", "localhost", "[::1]"),
    )


def validate_gateway_security(config: Settings) -> None:
    """外部待受の明示設定と、任意で有効にする認証設定の不整合を拒否します。"""
    local_hosts = {"127.0.0.1", "localhost", "::1"}
    if config.gateway_host not in local_hosts and not config.gateway_lan_mode:
        raise RuntimeError(
            "ローカル以外で待ち受けるにはAVATAR_GATEWAY_LAN_MODE=trueが必要です",
        )
    if not 1 <= config.gateway_port <= 65_535:
        raise RuntimeError("AVATAR_GATEWAY_PORTは1から65535の範囲で指定してください")
    if not 1 <= config.image_retention_days <= 3_650:
        raise RuntimeError("AVATAR_GATEWAY_IMAGE_RETENTION_DAYSは1から3650の範囲で指定してください")
    if config.stt_enabled:
        if not config.stt_model:
            raise RuntimeError("FASTER_WHISPER_MODELを指定してください")
        if config.stt_device not in {"cpu", "cuda"}:
            raise RuntimeError("FASTER_WHISPER_DEVICEはcpuまたはcudaにしてください")
        if not 1 <= config.stt_cpu_threads <= 64:
            raise RuntimeError("FASTER_WHISPER_CPU_THREADSは1から64の範囲で指定してください")
        if not 1 <= config.stt_beam_size <= 10:
            raise RuntimeError("FASTER_WHISPER_BEAM_SIZEは1から10の範囲で指定してください")
        if not 1_024 <= config.stt_max_audio_bytes <= 100 * 1024 * 1024:
            raise RuntimeError("FASTER_WHISPER_MAX_AUDIO_BYTESは1024から104857600の範囲で指定してください")
    if config.gateway_auth_password and (
        not config.gateway_auth_username or ":" in config.gateway_auth_username
    ):
        raise RuntimeError("認証ユーザー名は空にできず、コロンを含められません")
    if config.gateway_auth_password and len(config.gateway_auth_password) < 16:
        raise RuntimeError("Basic認証を使う場合は16文字以上のAVATAR_GATEWAY_AUTH_PASSWORDが必要です")
    if not config.gateway_lan_mode:
        return
    if not config.gateway_allowed_hosts or "*" in config.gateway_allowed_hosts:
        raise RuntimeError("LANモードではAVATAR_GATEWAY_ALLOWED_HOSTSを明示してください")


settings = Settings()
validate_gateway_security(settings)
