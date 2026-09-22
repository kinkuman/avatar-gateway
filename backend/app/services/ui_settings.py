"""ブラウザ表示設定を検証し、共有既定値JSONとして安全に読み書きします。"""

import json
from pathlib import Path
from typing import Literal
from urllib.parse import quote
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator


BACKGROUND_FILE_SUFFIXES = frozenset({".jpg", ".jpeg", ".png", ".webp"})


class UiSettingsError(RuntimeError):
    """設定ファイルの破損や保存失敗を、APIで扱える一つの例外へまとめます。"""


class UiVector3(BaseModel):
    """カメラ位置を異常値から守り、Three.jsへ渡せる三次元座標に限定します。"""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    x: float = Field(ge=-100, le=100)
    y: float = Field(ge=-100, le=100)
    z: float = Field(ge=-100, le=100)


class UiCameraSettings(BaseModel):
    """OrbitControlsの視点を再現するため、カメラ位置と注視点を一組で保持します。"""

    model_config = ConfigDict(extra="forbid")

    position: UiVector3
    target: UiVector3

    @model_validator(mode="after")
    def validate_distance(self) -> "UiCameraSettings":
        """視点と注視点の一致や極端な距離を拒否し、操作不能なカメラを保存しません。"""
        dx = self.position.x - self.target.x
        dy = self.position.y - self.target.y
        dz = self.position.z - self.target.z
        distance_squared = dx * dx + dy * dy + dz * dz
        if not 0.05 ** 2 <= distance_squared <= 50 ** 2:
            raise ValueError("camera distance must be between 0.05 and 50")
        return self


class UiBackgroundSettings(BaseModel):
    """ローカル壁紙の選択と、画面へ収める方法だけを公開設定として保持します。"""

    model_config = ConfigDict(extra="forbid")

    file: str | None = None
    fit: Literal["cover", "contain"] = "cover"

    @field_validator("file")
    @classmethod
    def validate_file(cls, value: str | None) -> str | None:
        """静的公開範囲を背景ディレクトリ直下の対応画像だけに限定します。"""
        if value is None:
            return None
        if not value or len(value) > 255 or "/" in value or "\\" in value:
            raise ValueError("background file must be a filename")
        if Path(value).suffix.lower() not in BACKGROUND_FILE_SUFFIXES:
            raise ValueError("background file must be PNG, JPEG, or WebP")
        return value


class UiTouchRegions(BaseModel):
    """標準7部位とモデル固有の耳を、個別に無効化できる設定として保持します。"""

    model_config = ConfigDict(extra="forbid")

    head: bool = True
    ear: bool = False
    tail: bool = False
    chest: bool = True
    hips: bool = True
    groin: bool = True
    thigh: bool = True
    hand: bool = True
    foot: bool = True


class UiTouchHitboxOffset(BaseModel):
    """判定がモデルから大きく離れない範囲の、ボーンローカル座標を保持します。"""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    x: float = Field(ge=-2, le=2)
    y: float = Field(ge=-2, le=2)
    z: float = Field(ge=-2, le=2)


class UiTouchHitboxScale(BaseModel):
    """操作不能な反転や極端な巨大化を避けた、判定メッシュの倍率を保持します。"""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    x: float = Field(ge=0.1, le=5)
    y: float = Field(ge=0.1, le=5)
    z: float = Field(ge=0.1, le=5)


class UiTouchHitboxTransform(BaseModel):
    """一つの判定メッシュについて、既定値から置き換える位置と寸法を保持します。"""

    model_config = ConfigDict(extra="forbid")

    offset: UiTouchHitboxOffset
    scale: UiTouchHitboxScale


UiTouchHitboxProfile = dict[
    Literal[
        "head",
        "leftEar",
        "rightEar",
        "tail",
        "chest",
        "hips",
        "groin",
        "leftThigh",
        "rightThigh",
        "leftHand",
        "rightHand",
        "leftFoot",
        "rightFoot",
    ],
    UiTouchHitboxTransform,
]


class UiTouchInteractionSettings(BaseModel):
    """ふれあい入力の提供範囲と、送信しない調整機能を設定します。"""

    model_config = ConfigDict(extra="forbid")

    extended_regions_enabled: bool = False
    enabled: bool = True
    debug_hitboxes: bool = False
    edit_hitboxes: bool = False
    recoil_test_enabled: bool = False
    hitbox_profiles: dict[str, UiTouchHitboxProfile] = Field(default_factory=dict)
    regions: UiTouchRegions = Field(default_factory=UiTouchRegions)

    @field_validator("hitbox_profiles")
    @classmethod
    def validate_hitbox_profile_names(
        cls,
        value: dict[str, UiTouchHitboxProfile],
    ) -> dict[str, UiTouchHitboxProfile]:
        """任意パスを設定キーへ持ち込まず、VRMファイル名だけをモデル識別子にします。"""
        if any(not name or len(name) > 255 or "/" in name or "\\" in name for name in value):
            raise ValueError("hitbox profile keys must be VRM filenames")
        return value


class UiVoiceInputSettings(BaseModel):
    """ブラウザVADの発話終了時間と、環境音に合わせる音量しきい値を保持します。"""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    silence_ms: int = Field(default=800, ge=600, le=2_000)
    speech_threshold: float = Field(default=0.02, ge=0.005, le=0.1)


class UiSettings(BaseModel):
    """サーバー既定値とブラウザ上書きで共有する、公開可能なUI設定だけを定義します。"""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    schema_version: Literal[1] = 1
    cast_off_enabled: bool = False
    show_motion_controls: bool = False
    show_camera_help: bool = True
    speech_volume: float = Field(default=1, ge=0, le=1)
    camera: UiCameraSettings | None = None
    background: UiBackgroundSettings = Field(default_factory=UiBackgroundSettings)
    touch_interaction: UiTouchInteractionSettings = Field(default_factory=UiTouchInteractionSettings)
    voice_input: UiVoiceInputSettings = Field(default_factory=UiVoiceInputSettings)


def _background_files(directory: Path, url_prefix: str) -> dict[str, dict[str, str]]:
    """一つの資産ディレクトリを検査し、ファイル名をキーにした公開情報へ変換します。"""
    try:
        if not directory.is_dir():
            return {}
        files = (
            path for path in directory.iterdir()
            if path.is_file()
            and not path.name.startswith(".")
            and path.suffix.lower() in BACKGROUND_FILE_SUFFIXES
        )
    except OSError as exc:
        raise UiSettingsError(f"壁紙一覧を読み込めません: {exc}") from exc
    return {
        path.name: {"file": path.name, "url": f"{url_prefix}/{quote(path.name, safe='')}"}
        for path in files
    }


def list_backgrounds(bundled_directory: Path, local_directory: Path) -> list[dict[str, str]]:
    """同梱壁紙へローカル版を重ね、同名差し替えを一つの選択肢として返します。"""
    backgrounds = _background_files(bundled_directory, "/assets/backgrounds")
    backgrounds.update(_background_files(local_directory, "/local-assets/backgrounds"))
    return sorted(backgrounds.values(), key=lambda item: item["file"].casefold())


class UiSettingsStore:
    """一つのui.jsonを正本として読み込み、破損しない原子的置換で更新します。"""

    def __init__(self, path: Path) -> None:
        self.path = path

    def load(self) -> UiSettings:
        """初期値の欠落を黙って補わず、管理者が直せる場所付きエラーへ変換します。"""
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            return UiSettings.model_validate(raw)
        except (OSError, json.JSONDecodeError, ValidationError) as exc:
            raise UiSettingsError(f"UI設定を読み込めません: {exc}") from exc

    def save(self, value: UiSettings) -> UiSettings:
        """検証済み設定を一時ファイルへ完成させてから置換し、途中書き込みを残しません。"""
        temporary_path = self.path.with_name(f".{self.path.name}.{uuid4().hex}.tmp")
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary_path.write_text(
                json.dumps(value.model_dump(mode="json"), ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            temporary_path.replace(self.path)
        except OSError as exc:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass
            raise UiSettingsError(f"UI設定を保存できません: {exc}") from exc
        return value
