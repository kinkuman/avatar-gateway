"""画面から選んだHermesモデルを、次の会話でも使えるように保存します。"""

import json
import re
from pathlib import Path
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, field_validator
from pydantic import ValidationError


_MODEL_ID = re.compile(r"^[A-Za-z0-9_./:+@=-]{1,200}$")
_PROVIDER_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,80}$")
_MAX_MODELS_PER_PROVIDER = 800


class ModelSelectionError(RuntimeError):
    """モデル選択の読み書き失敗を、秘密情報を含まない説明へ統一します。"""


class SelectedHermesModel(BaseModel):
    """次のRunへ渡すプロバイダとモデルの組み合わせです。"""

    model_config = ConfigDict(extra="forbid")

    model: str
    provider: str

    @field_validator("model")
    @classmethod
    def validate_model(cls, value: str) -> str:
        """Hermesへそのまま渡せる識別子だけを許可します。"""
        if not _MODEL_ID.fullmatch(value):
            raise ValueError("model id is invalid")
        return value

    @field_validator("provider")
    @classmethod
    def validate_provider(cls, value: str) -> str:
        """プロバイダ名も同じく、任意の文字列を上流へ送りません。"""
        if not _PROVIDER_ID.fullmatch(value):
            raise ValueError("provider id is invalid")
        return value


class ModelSelectionStore:
    """選択中モデルを一つのJSONへ原子的に保存します。"""

    def __init__(self, path: Path) -> None:
        self.path = path

    def load(self) -> SelectedHermesModel | None:
        """未選択はNone、壊れた保存は再起動後も気付けられるエラーにします。"""
        if not self.path.is_file():
            return None
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            return SelectedHermesModel.model_validate(raw)
        except (OSError, json.JSONDecodeError, ValidationError) as exc:
            raise ModelSelectionError("保存済みのモデル選択を読み込めません") from exc

    def save(self, value: SelectedHermesModel) -> SelectedHermesModel:
        """完成したJSONを置換し、途中までの書き込みを正本に残しません。"""
        temporary = self.path.with_name(f".{self.path.name}.{uuid4().hex}.tmp")
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary.write_text(
                json.dumps(value.model_dump(), ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            temporary.replace(self.path)
        except OSError as exc:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
            raise ModelSelectionError("モデル選択を保存できません") from exc
        return value

    def clear(self) -> None:
        """既定のHERMES_MODELへ戻すため、上書きファイルを消します。"""
        try:
            self.path.unlink(missing_ok=True)
        except OSError as exc:
            raise ModelSelectionError("モデル選択を解除できません") from exc


def public_model_catalog(payload: object) -> dict:
    """Hermesのモデル一覧から、画面に必要な名前だけを残します。"""
    if not isinstance(payload, dict):
        raise ModelSelectionError("Hermesモデル一覧の応答形式が正しくありません")
    providers = payload.get("providers")
    if not isinstance(providers, list):
        raise ModelSelectionError("Hermesモデル一覧の応答形式が正しくありません")

    public_providers: list[dict] = []
    for row in providers:
        if not isinstance(row, dict):
            continue
        slug = row.get("slug")
        if not isinstance(slug, str) or not _PROVIDER_ID.fullmatch(slug):
            continue
        name = row.get("name")
        if not isinstance(name, str) or not name.strip():
            name = slug
        models = row.get("models")
        if not isinstance(models, list):
            continue
        valid_ids = [
            item for item in models
            if isinstance(item, str) and _MODEL_ID.fullmatch(item)
        ]
        cleaned: list[str] = []
        for item in valid_ids:
            if item not in cleaned:
                cleaned.append(item)
            if len(cleaned) >= _MAX_MODELS_PER_PROVIDER:
                break
        if not cleaned:
            continue
        public_providers.append({
            "slug": slug,
            "name": " ".join(name.split())[:120],
            "models": cleaned,
            "truncated": len(valid_ids) > len(cleaned),
        })

    raw_model = payload.get("model")
    raw_provider = payload.get("provider")
    current_model = raw_model if isinstance(raw_model, str) and _MODEL_ID.fullmatch(raw_model) else ""
    current_provider = raw_provider if isinstance(raw_provider, str) and _PROVIDER_ID.fullmatch(raw_provider) else ""
    return {
        "current_model": current_model,
        "current_provider": current_provider,
        "providers": public_providers,
    }


def selection_is_listed(catalog: dict, model: str, provider: str) -> bool:
    """選択値が、今取得したHermes一覧の中にあることを確認します。"""
    return any(
        row["slug"] == provider and model in row["models"]
        for row in catalog["providers"]
    )
