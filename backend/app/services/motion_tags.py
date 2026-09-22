"""モーション設定とHermesの構造化アバター制御を、安全な表示命令へ変換します。"""

from collections.abc import Mapping
from dataclasses import dataclass
import json
from pathlib import Path
import re
from typing import Literal
from urllib.parse import quote


class MotionCatalogError(RuntimeError):
    """設定不備を会話機能全体の停止ではなく、利用者向け警告へ変換可能にします。"""


@dataclass(frozen=True)
class MotionDefinition:
    """1件の設定値とVRMAの利用可否・公開先を保持します。"""

    name: str
    label: str
    file_name: str
    prompt: str
    enabled: bool
    available: bool
    public_base_url: str = "/local-assets/motions"
    playback: Literal["auto", "pose", "animation"] = "auto"
    exit_duration_seconds: float = 0.6

    @property
    def url(self) -> str:
        """検証済みの資産種別とファイル名から、同一オリジンURLを作ります。"""
        return f"{self.public_base_url}/{quote(self.file_name, safe='')}"

    def to_public_dict(self) -> dict:
        """ファイルシステムの絶対パスを隠し、UIに必要な情報だけを返します。"""
        return {
            "name": self.name,
            "label": self.label,
            "file": self.file_name,
            "enabled": self.enabled,
            "available": self.available,
            "url": self.url if self.available else None,
            "playback": self.playback,
            "exit_duration_seconds": self.exit_duration_seconds,
        }


@dataclass(frozen=True)
class MotionCatalog:
    """設定済みモーション、生成中モーション、読込エラーを一つにまとめます。"""

    motions: tuple[MotionDefinition, ...]
    generating_motion_name: str | None
    error: str | None = None

    @classmethod
    def unavailable(cls, error: str) -> "MotionCatalog":
        """設定に問題があってもテキスト会話を継続できる空カタログを返します。"""
        return cls(motions=(), generating_motion_name=None, error=error)

    @property
    def selectable_motions(self) -> dict[str, MotionDefinition]:
        """有効かつ配置済みの項目だけをLLMタグから選択できるようにします。"""
        return {
            motion.name: motion
            for motion in self.motions
            if motion.enabled and motion.available
        }

    @property
    def generating_motion(self) -> MotionDefinition | None:
        """生成中モーションが無効または未配置なら、安全に待機動作へ戻します。"""
        if not self.generating_motion_name:
            return None
        return self.selectable_motions.get(self.generating_motion_name)

    def selection_prompt(self) -> str:
        """利用可能なモーションと固定表情から、Hermes向けJSON制御指示を作ります。"""
        motions = self.selectable_motions.values()
        choices = [f"- `{motion.name}`: {motion.prompt}" for motion in motions]
        choices.append("- `none`: 上記に当てはまらない通常の返答")
        return "\n".join([
            "# アバター制御規則",
            "",
            "回答を1つ以上の演技ブロックで構成し、各ブロックの先頭に次の形式を1つ付けてください。",
            '`[avatar]{"v":1,"motion":"none","expression":"neutral"}[/avatar]`',
            "読み上げる会話が1文だけの場合は1ブロックにしてください。",
            "読み上げる会話が2文以上ある場合は、原則2〜3ブロックに分けてください。",
            "各ブロックではその文章に合うmotionとexpressionを選び、利用可能なモーションを積極的に使ってください。",
            "複数ブロックでは、可能なら前のブロックとは異なる演技を選んでください。",
            "avatarタグは必ず対応するspeechタグの直前に置き、本文やspeechタグの途中へ入れないでください。",
            "JSONの前後や中にMarkdownコードフェンスを付けないでください。",
            "",
            "## motionの選択肢",
            *choices,
            "",
            "## expressionの選択肢",
            "- `neutral`: 通常、または感情表現を解除する",
            "- `happy`: 嬉しい、楽しい、成功を喜ぶ",
            "- `relaxed`: 安心、穏やか、親しみのある会話",
            "- `sad`: 悲しい、残念、申し訳ない",
            "- `angry`: 怒り、不満、強い否定",
            "- `surprised`: 驚き、意外な結果",
            "- `shy`: 照れ、恥ずかしさ、はにかみ",
            "",
            "`v`、`motion`、`expression`以外の項目は追加しないでください。",
            "制御JSON自体を説明せず、閉じタグの直後から通常の返答を書いてください。",
        ])


AVATAR_EXPRESSIONS = frozenset({"neutral", "happy", "relaxed", "sad", "angry", "surprised", "shy"})


@dataclass(frozen=True)
class ParsedAvatarChunk:
    """構造化制御を除いた本文と、検証済みのモーション・表情を返します。"""

    text: str
    motion: MotionDefinition | None = None
    expression: str | None = None


_AVATAR_OPEN_TAG = "[avatar]"
_AVATAR_CLOSE_TAG = "[/avatar]"
_LEGACY_MOTION_PREFIX = "[motion:"
_VALID_NAME = re.compile(r"^[a-z][a-z0-9_-]{0,31}$", re.IGNORECASE)
_VALID_PARTIAL_NAME = re.compile(r"^[a-z0-9_-]*$", re.IGNORECASE)
_MAX_DIRECTIVE_LENGTH = 512
_DISPLAY_MOTION_TAG_PATTERN = re.compile(
    r"^[ \t]*\[motion:[a-z][a-z0-9_-]{0,31}\][ \t]*",
    re.IGNORECASE | re.MULTILINE,
)
_DISPLAY_AVATAR_TAG_PATTERN = re.compile(
    r"^[ \t]*\[avatar\][^\r\n]{0,512}\[/avatar\][ \t]*",
    re.IGNORECASE | re.MULTILINE,
)


def strip_motion_tags(text: str) -> str:
    """旧形式で保存済みの履歴から、行頭のモーションタグを表示時だけ除きます。"""
    return _DISPLAY_MOTION_TAG_PATTERN.sub("", text)


def strip_avatar_directives(text: str) -> str:
    """正式履歴に保存された構造化制御を、複数assistant発話からすべて除きます。"""
    return _DISPLAY_AVATAR_TAG_PATTERN.sub("", text)


def _read_required_text(item: dict, key: str, location: str, max_length: int) -> str:
    """JSONの文字列項目を空文字と過大入力から守り、場所付きのエラーにします。"""
    value = item.get(key)
    if not isinstance(value, str) or not value.strip():
        raise MotionCatalogError(f"{location}.{key} は空でない文字列にしてください")
    value = value.strip()
    if len(value) > max_length:
        raise MotionCatalogError(f"{location}.{key} は{max_length}文字以内にしてください")
    return value


def _resolve_motion_asset(
    file_name: str,
    local_assets_dir: Path,
    bundled_assets_dir: Path | None,
) -> tuple[bool, str]:
    """利用者の差し替えを優先し、なければ製品同梱VRMAへ解決します。"""
    if (local_assets_dir / "motions" / file_name).is_file():
        return True, "/local-assets/motions"
    if bundled_assets_dir is not None and (bundled_assets_dir / "motions" / file_name).is_file():
        return True, "/assets/motions"
    return False, "/assets/motions" if bundled_assets_dir is not None else "/local-assets/motions"


def load_motion_catalog(
    config_path: Path,
    local_assets_dir: Path,
    bundled_assets_dir: Path | None = None,
) -> MotionCatalog:
    """JSONを検証し、利用者資産と製品同梱資産を反映したカタログを返します。"""
    try:
        raw = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise MotionCatalogError(f"モーション設定を読み込めません: {exc}") from exc

    if not isinstance(raw, dict):
        raise MotionCatalogError("モーション設定の最上位はオブジェクトにしてください")
    if raw.get("schema_version") != 1:
        raise MotionCatalogError("schema_version は 1 にしてください")

    generating_name = raw.get("generating_motion")
    if generating_name is not None and not isinstance(generating_name, str):
        raise MotionCatalogError("generating_motion はタグ名または null にしてください")
    if isinstance(generating_name, str):
        generating_name = generating_name.strip().lower() or None

    items = raw.get("motions")
    if not isinstance(items, list):
        raise MotionCatalogError("motions は配列にしてください")

    motions: list[MotionDefinition] = []
    names: set[str] = set()
    for index, item in enumerate(items):
        location = f"motions[{index}]"
        if not isinstance(item, dict):
            raise MotionCatalogError(f"{location} はオブジェクトにしてください")

        name = _read_required_text(item, "name", location, 32).lower()
        if not _VALID_NAME.fullmatch(name) or name == "none":
            raise MotionCatalogError(f"{location}.name は英小文字で始まるタグ名にしてください（noneは予約済み）")
        if name in names:
            raise MotionCatalogError(f"モーション名 {name} が重複しています")

        label = _read_required_text(item, "label", location, 50)
        file_name = _read_required_text(item, "file", location, 200)
        if "/" in file_name or "\\" in file_name or Path(file_name).suffix.lower() != ".vrma":
            raise MotionCatalogError(f"{location}.file はディレクトリを含まない.vrmaファイル名にしてください")
        prompt = _read_required_text(item, "prompt", location, 200)
        enabled = item.get("enabled", True)
        if not isinstance(enabled, bool):
            raise MotionCatalogError(f"{location}.enabled は true または false にしてください")
        playback = item.get("playback", "auto")
        if not isinstance(playback, str) or playback not in {"auto", "pose", "animation"}:
            raise MotionCatalogError(
                f"{location}.playback は auto、pose、animation のいずれかにしてください"
            )
        exit_duration_seconds = item.get("exit_duration_seconds", 0.6)
        if (
            isinstance(exit_duration_seconds, bool)
            or not isinstance(exit_duration_seconds, (int, float))
            or not 0.1 <= exit_duration_seconds <= 5.0
        ):
            raise MotionCatalogError(
                f"{location}.exit_duration_seconds は0.1以上5.0以下の数値にしてください"
            )

        available, public_base_url = _resolve_motion_asset(
            file_name,
            local_assets_dir,
            bundled_assets_dir,
        )
        names.add(name)
        motions.append(MotionDefinition(
            name=name,
            label=label,
            file_name=file_name,
            prompt=prompt,
            enabled=enabled,
            available=available,
            public_base_url=public_base_url,
            playback=playback,
            exit_duration_seconds=float(exit_duration_seconds),
        ))

    if generating_name and generating_name not in names:
        raise MotionCatalogError(f"generating_motion の {generating_name} は motions に登録されていません")
    return MotionCatalog(tuple(motions), generating_name)


def load_motion_catalog_safely(
    config_path: Path,
    local_assets_dir: Path,
    bundled_assets_dir: Path | None = None,
) -> MotionCatalog:
    """設定エラーを空カタログへ変換し、会話と音声を引き続き利用可能にします。"""
    try:
        return load_motion_catalog(config_path, local_assets_dir, bundled_assets_dir)
    except MotionCatalogError as exc:
        return MotionCatalog.unavailable(str(exc))


class AvatarDirectiveParser:
    """SSE分割に依存せず、回答内の構造化JSONを順番どおり本文から分離します。"""

    def __init__(self, motions: Mapping[str, MotionDefinition] | None = None) -> None:
        self._motions = dict(motions or {})
        self._buffer = ""
        self._discarding = False
        self._at_start = True

    def feed(self, delta: str) -> tuple[ParsedAvatarChunk, ...]:
        """生成差分を追加し、本文と複数の制御を出現順の部品として返します。"""
        if self._discarding:
            return ()

        self._buffer += delta
        if self._at_start:
            # 従来どおり、最初の制御タグより前にある改行や空白は画面へ出しません。
            self._buffer = self._buffer.lstrip()
        parts: list[ParsedAvatarChunk] = []
        while self._buffer:
            lowered = self._buffer.lower()
            starts = [
                index
                for index in (
                    lowered.find(_AVATAR_OPEN_TAG),
                    lowered.find(_LEGACY_MOTION_PREFIX),
                )
                if index >= 0
            ]
            if not starts:
                retained = self._partial_control_suffix_length(lowered)
                release_length = len(self._buffer) - retained
                if release_length > 0:
                    parts.append(ParsedAvatarChunk(self._buffer[:release_length]))
                    self._buffer = self._buffer[release_length:]
                    self._at_start = False
                break

            start = min(starts)
            if start > 0:
                parts.append(ParsedAvatarChunk(self._buffer[:start]))
                self._buffer = self._buffer[start:]
                self._at_start = False
                continue

            if lowered.startswith(_AVATAR_OPEN_TAG):
                closing_index = lowered.find(_AVATAR_CLOSE_TAG, len(_AVATAR_OPEN_TAG))
                if closing_index < 0:
                    if len(self._buffer) > _MAX_DIRECTIVE_LENGTH:
                        parts.append(self._discard_directive())
                    break
                raw_json = self._buffer[len(_AVATAR_OPEN_TAG):closing_index]
                motion, expression = self._parse_directive(raw_json)
                # 不正JSONや未知名も制御文字列として隠し、安全なneutralへフォールバックします。
                self._buffer = self._buffer[closing_index + len(_AVATAR_CLOSE_TAG):].lstrip()
                parts.append(ParsedAvatarChunk("", motion, expression))
                self._at_start = False
                continue

            closing_index = self._buffer.find("]", len(_LEGACY_MOTION_PREFIX))
            raw_name = (
                self._buffer[len(_LEGACY_MOTION_PREFIX):]
                if closing_index < 0
                else self._buffer[len(_LEGACY_MOTION_PREFIX):closing_index]
            )
            if not _VALID_PARTIAL_NAME.fullmatch(raw_name):
                parts.append(ParsedAvatarChunk(self._buffer[0]))
                self._buffer = self._buffer[1:]
                continue
            if closing_index < 0:
                if len(self._buffer) > _MAX_DIRECTIVE_LENGTH:
                    parts.append(self._discard_directive())
                break
            motion_name = raw_name.lower()
            motion = None if motion_name == "none" else self._motions.get(motion_name)
            self._buffer = self._buffer[closing_index + 1:].lstrip()
            parts.append(ParsedAvatarChunk("", motion, "neutral"))
            self._at_start = False

        return tuple(parts)

    def finish(self) -> tuple[ParsedAvatarChunk, ...]:
        """ストリーム末尾に残った未完成の制御候補を本文へ漏らさず破棄します。"""
        if self._discarding:
            return ()
        if not self._buffer:
            return ()
        lowered = self._buffer.lower()
        incomplete_control = (
            lowered.startswith(_AVATAR_OPEN_TAG)
            or lowered.startswith(_LEGACY_MOTION_PREFIX)
            or self._partial_control_suffix_length(lowered) > 0
        )
        text = "" if incomplete_control else self._buffer
        self._buffer = ""
        return (ParsedAvatarChunk(text),) if text else ()

    def _parse_directive(self, raw_json: str) -> tuple[MotionDefinition | None, str]:
        """LLM出力を厳密な3項目だけに制限し、不正値をneutralへ閉じ込めます。"""
        try:
            value = json.loads(raw_json)
        except json.JSONDecodeError:
            return None, "neutral"
        if not isinstance(value, dict) or set(value) != {"v", "motion", "expression"}:
            return None, "neutral"
        if value.get("v") != 1:
            return None, "neutral"
        motion_name = value.get("motion")
        expression = value.get("expression")
        if not isinstance(motion_name, str) or not _VALID_NAME.fullmatch(motion_name):
            return None, "neutral"
        if not isinstance(expression, str) or expression not in AVATAR_EXPRESSIONS:
            return None, "neutral"
        motion = None if motion_name.lower() == "none" else self._motions.get(motion_name.lower())
        return motion, expression

    def _discard_directive(self) -> ParsedAvatarChunk:
        """過大な未完制御を本文へ漏らさず、以降の差分もこの発話では読み捨てます。"""
        self._buffer = ""
        self._discarding = True
        return ParsedAvatarChunk("", None, "neutral")

    @staticmethod
    def _partial_control_suffix_length(text: str) -> int:
        """次のSSE差分で制御タグになり得る末尾だけを解析用に保持します。"""
        retained = 0
        for prefix in (_AVATAR_OPEN_TAG, _LEGACY_MOTION_PREFIX):
            maximum = min(len(text), len(prefix) - 1)
            for length in range(maximum, 0, -1):
                if prefix.startswith(text[-length:]):
                    retained = max(retained, length)
                    break
        return retained
