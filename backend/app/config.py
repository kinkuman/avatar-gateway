"""秘密情報をブラウザへ渡さず、環境変数から接続設定を組み立てます。"""

from dataclasses import dataclass
from pathlib import Path
import os
import re

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


def _as_optional_float(value: str | None) -> float | None:
    """OpenAI互換サーバーへ余分な項目を送らないよう、空設定を「指定なし」とします。"""
    if value is None or not value.strip():
        return None
    return float(value)


def _env(*names: str) -> str | None:
    """提供元を選べる新しい設定名を優先しつつ、既存の.envもそのまま使えるようにします。"""
    for name in names:
        value = os.getenv(name)
        if value is not None:
            return value
    return None


@dataclass(frozen=True)
class Settings:
    """アプリ全体で共有する接続先と製品・ローカル資産の設定を保持します。"""

    hermes_base_url: str = os.getenv("HERMES_BASE_URL", "http://127.0.0.1:8642/v1").rstrip("/")
    hermes_api_key: str = os.getenv("HERMES_API_KEY", "")
    hermes_model: str = os.getenv("HERMES_MODEL", "hermes-agent")
    hermes_model_file: Path = PROJECT_ROOT / "runtime" / "hermes_model.json"
    daily_timezone: str = os.getenv("AVATAR_GATEWAY_TIMEZONE", "Asia/Tokyo").strip()
    hermes_image_cache_dir: Path = Path(os.getenv(
        "HERMES_IMAGE_CACHE_DIR",
        "~/.hermes/cache/images",
    )).expanduser()
    hermes_cron_dir: Path = Path(os.getenv("HERMES_CRON_DIR", "~/.hermes/cron")).expanduser()
    gaze_cron_job_name: str = os.getenv("AVATAR_GATEWAY_GAZE_CRON_JOB", "avatar-gateway-gaze").strip()
    gaze_state_file: Path = PROJECT_ROOT / "runtime" / "gaze_speech.json"
    tts_enabled: bool = _as_bool(_env("AVATAR_GATEWAY_TTS_ENABLED", "STYLEBERTVITS2_ENABLED"), True)
    tts_provider: str = os.getenv("AVATAR_GATEWAY_TTS_PROVIDER", "stylebertvits2").strip().lower()
    tts_server_url: str = os.getenv("STYLEBERTVITS2_SERVER_URL", "http://127.0.0.1:5000").rstrip("/")
    tts_api_key: str = os.getenv("STYLEBERTVITS2_API_KEY", "")
    tts_model_id: int = int(os.getenv("STYLEBERTVITS2_MODEL_ID", "0"))
    tts_style: str = os.getenv("STYLEBERTVITS2_STYLE", "Neutral")
    tts_sdp_ratio: float = float(os.getenv("STYLEBERTVITS2_SDP_RATIO", "0.2"))
    tts_length: float = float(os.getenv("STYLEBERTVITS2_LENGTH", "1.0"))
    tts_chunk_min_chars: int = int(os.getenv("STYLEBERTVITS2_CHUNK_MIN_CHARS", "6"))
    tts_chunk_max_chars: int = int(os.getenv("STYLEBERTVITS2_CHUNK_MAX_CHARS", "100"))
    openai_tts_base_url: str = os.getenv("OPENAI_TTS_BASE_URL", "http://127.0.0.1:8080/").strip()
    openai_tts_api_key: str = os.getenv("OPENAI_TTS_API_KEY", "")
    openai_tts_model: str = os.getenv("OPENAI_TTS_MODEL", "").strip()
    openai_tts_voice: str = os.getenv("OPENAI_TTS_VOICE", "none").strip()
    # speech.cppはQwen3-TTSなど受け付けないモデルへの指定を拒否するため、既定では送りません。
    openai_tts_speed: float | None = _as_optional_float(os.getenv("OPENAI_TTS_SPEED"))
    openai_tts_instructions: str = os.getenv("OPENAI_TTS_INSTRUCTIONS", "").strip()
    openai_tts_language: str = os.getenv("OPENAI_TTS_LANGUAGE", "").strip()
    stt_enabled: bool = _as_bool(_env("AVATAR_GATEWAY_STT_ENABLED", "FASTER_WHISPER_ENABLED"), True)
    stt_provider: str = os.getenv("AVATAR_GATEWAY_STT_PROVIDER", "faster_whisper").strip().lower()
    openai_stt_base_url: str = os.getenv("OPENAI_STT_BASE_URL", "http://127.0.0.1:8080/").strip()
    openai_stt_api_key: str = os.getenv("OPENAI_STT_API_KEY", "")
    openai_stt_model: str = os.getenv("OPENAI_STT_MODEL", "").strip()
    openai_stt_language: str = os.getenv("OPENAI_STT_LANGUAGE", "ja").strip()
    openai_stt_prompt: str = os.getenv("OPENAI_STT_PROMPT", "").strip()
    openai_stt_response_format: str = os.getenv("OPENAI_STT_RESPONSE_FORMAT", "json").strip().lower()
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
    # 表情ブレンドと瞬きモーフが重なると崩れるVRM向けに、表情が残っているあいだまばたきを止めます。
    suppress_blink_during_expression: bool = _as_bool(
        os.getenv("AVATAR_SUPPRESS_BLINK_DURING_EXPRESSION"),
        False,
    )
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


def _validate_http_url(value: str, name: str) -> None:
    """接続先の書き間違いを起動時に止め、発話や録音の最中に起きる失敗を防ぎます。"""
    if not value.startswith(("http://", "https://")):
        raise RuntimeError(f"{name}はhttp://またはhttps://で始まるURLにしてください")


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
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", config.gaze_cron_job_name):
        raise RuntimeError("AVATAR_GATEWAY_GAZE_CRON_JOBは英数字、ハイフン、アンダースコアだけにしてください")
    if config.tts_provider not in {"stylebertvits2", "openai"}:
        raise RuntimeError("AVATAR_GATEWAY_TTS_PROVIDERはstylebertvits2またはopenaiにしてください")
    if config.stt_provider not in {"faster_whisper", "openai"}:
        raise RuntimeError("AVATAR_GATEWAY_STT_PROVIDERはfaster_whisperまたはopenaiにしてください")
    if config.tts_enabled and config.tts_provider == "openai":
        _validate_http_url(config.openai_tts_base_url, "OPENAI_TTS_BASE_URL")
        if config.openai_tts_speed is not None and not 0.25 <= config.openai_tts_speed <= 4:
            raise RuntimeError("OPENAI_TTS_SPEEDは0.25から4.0の範囲で指定してください")
    if config.stt_enabled and config.stt_provider == "openai":
        _validate_http_url(config.openai_stt_base_url, "OPENAI_STT_BASE_URL")
        if config.openai_stt_response_format not in {"json", "text", "verbose_json"}:
            raise RuntimeError("OPENAI_STT_RESPONSE_FORMATはjson、text、verbose_jsonのいずれかにしてください")
    if config.stt_enabled and config.stt_provider == "faster_whisper":
        if not config.stt_model:
            raise RuntimeError("FASTER_WHISPER_MODELを指定してください")
        if config.stt_device not in {"cpu", "cuda"}:
            raise RuntimeError("FASTER_WHISPER_DEVICEはcpuまたはcudaにしてください")
        if not 1 <= config.stt_cpu_threads <= 64:
            raise RuntimeError("FASTER_WHISPER_CPU_THREADSは1から64の範囲で指定してください")
        if not 1 <= config.stt_beam_size <= 10:
            raise RuntimeError("FASTER_WHISPER_BEAM_SIZEは1から10の範囲で指定してください")
    if config.stt_enabled and not 1_024 <= config.stt_max_audio_bytes <= 100 * 1024 * 1024:
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
