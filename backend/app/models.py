"""外部入力を検証し、会話APIの境界を明確にするデータモデルです。"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class HermesConversationRequest(BaseModel):
    """Hermes Session/Runへ送る一回分の会話入力を検証します。"""

    model_config = ConfigDict(extra="forbid")

    input: str = Field(min_length=1, max_length=50_000)
    session_id: str | None = Field(
        default=None,
        min_length=47,
        max_length=47,
        pattern=r"^avatar_gateway_[0-9a-f]{32}$",
    )

    @field_validator("input")
    @classmethod
    def normalize_input(cls, value: str) -> str:
        """空白だけのRunを作らないため、入力の前後を整えて検証します。"""
        normalized = value.strip()
        if not normalized:
            raise ValueError("input must not be blank")
        return normalized


class HermesSessionCreateRequest(BaseModel):
    """ブラウザから作成できるセッション情報を、表示用タイトルだけに制限します。"""

    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=200)

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str | None) -> str | None:
        """空白だけのタイトルを拒否し、画面とHermesで同じ値を扱えるよう整えます。"""
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("title must not be blank")
        return normalized


class HermesRunCreateRequest(BaseModel):
    """所有セッションで開始する一回のHermes作業入力を検証します。"""

    model_config = ConfigDict(extra="forbid")

    session_id: str = Field(
        min_length=47,
        max_length=47,
        pattern=r"^avatar_gateway_[0-9a-f]{32}$",
    )
    input: str = Field(min_length=1, max_length=50_000)

    @field_validator("input")
    @classmethod
    def normalize_input(cls, value: str) -> str:
        """空白だけの実行を防ぎつつ、利用者本文の内部改行は維持します。"""
        normalized = value.strip()
        if not normalized:
            raise ValueError("input must not be blank")
        return normalized


class HermesRunApprovalRequest(BaseModel):
    """Hermesが明示する4種類だけに承認回答を制限します。"""

    model_config = ConfigDict(extra="forbid")

    choice: Literal["once", "session", "always", "deny"]


class SpeechEvent(BaseModel):
    """音声の実再生結果を障害調査用に受け取ります。"""

    type: Literal["speech.started", "speech.completed", "speech.failed", "speech.cancelled"]
    utterance_id: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")
    sequence_id: str | None = Field(default=None, min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")
    segment_index: int | None = Field(default=None, ge=0)
    played_ms: int | None = Field(default=None, ge=0)
    reason: str | None = Field(default=None, max_length=500)
