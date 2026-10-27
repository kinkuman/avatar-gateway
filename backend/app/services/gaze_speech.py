"""Hermes cronのlocal出力から、視線発話だけを待ち行列へ集めます。"""

import json
import re
import threading
from dataclasses import dataclass
from pathlib import Path

from .motion_tags import AVATAR_EXPRESSIONS


_TOKEN_PATTERN = re.compile(
    r"\[avatar\](.*?)\[/avatar\]|\[speech\](.*?)\[/speech\]",
    re.IGNORECASE | re.DOTALL,
)
_INLINE_AVATAR_PATTERN = re.compile(r"\[avatar\].*?\[/avatar\]", re.IGNORECASE | re.DOTALL)
_JOB_ID_PATTERN = re.compile(r"^[0-9a-fA-F]{8,64}$")
_OUTPUT_NAME_PATTERN = re.compile(r"^[0-9A-Za-z._-]{1,80}\.md$")
_VALID_MOTION = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
_SILENT_MARKER = "[gaze:silent]"
_RESPONSE_HEADING = "## Response"
_PLACEHOLDER_TEXTS = frozenset({"ここに日本語の一文", "日本語の一文"})
_MAX_UTTERANCE_CHARS = 300
_MAX_BEATS = 3
_MAX_QUEUE = 20
_MAX_SEEN = 400
_MAX_OUTPUT_BYTES = 256 * 1024
_LOOSE_TAG_PATTERN = re.compile(r"\[(/?)(avatar|speech)\]", re.IGNORECASE)


def _close_loose_tags(body: str) -> str:
    """開きっぱなしの制御タグを、次のタグか本文の末尾で閉じます。"""
    open_kind: str | None = None
    pieces: list[str] = []
    cursor = 0
    for match in _LOOSE_TAG_PATTERN.finditer(body):
        closing = bool(match.group(1))
        kind = match.group(2).lower()
        if open_kind is not None and not (closing and kind == open_kind):
            pieces.append(body[cursor:match.start()])
            pieces.append(f"[/{open_kind}]")
            cursor = match.start()
            open_kind = None
        if closing and open_kind == kind:
            open_kind = None
        elif not closing:
            open_kind = kind
    pieces.append(body[cursor:])
    if open_kind is not None:
        pieces.append(f"[/{open_kind}]")
    return "".join(pieces)


@dataclass(frozen=True)
class GazeBeat:
    """一度の視線で続けて表す、動きと表情の付いた一文です。"""

    text: str
    motion: str | None = None
    expression: str = "neutral"


@dataclass(frozen=True)
class GazePerformance:
    """カメラを見た一回でまとめて再生する反応です。"""

    beats: tuple[GazeBeat, ...]

    def to_stored(self) -> dict:
        """再起動後も動きと表情を失わない形で返します。"""
        return {
            "beats": [
                {"text": beat.text, "motion": beat.motion, "expression": beat.expression}
                for beat in self.beats
            ],
        }


def extract_gaze_performance(text: str) -> GazePerformance | None:
    """応答本文の演技だけを返し、無言指定や指示の見本は空にします。"""
    motion: str | None = None
    expression = "neutral"
    beats: list[GazeBeat] = []
    for match in _TOKEN_PATTERN.finditer(_close_loose_tags(_response_body(text))):
        avatar_raw, speech_raw = match.group(1), match.group(2)
        if avatar_raw is not None:
            motion, expression = _parse_avatar(avatar_raw)
            continue
        spoken = _speech_text(speech_raw or "")
        if not spoken:
            continue
        beats.append(GazeBeat(spoken, motion, expression))
        if len(beats) >= _MAX_BEATS:
            break
    if not beats:
        return None
    return GazePerformance(tuple(beats))


def _response_body(text: str) -> str:
    """cronの記録に含まれる指示文の見本を読み上げず、末尾の応答だけを使います。"""
    index = text.rfind(_RESPONSE_HEADING)
    if index < 0:
        return text
    return text[index + len(_RESPONSE_HEADING):]


def _parse_avatar(raw: str) -> tuple[str | None, str]:
    """制御JSONから使える動きと表情だけを残し、崩れたら無動作へ戻します。"""
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return None, "neutral"
    if not isinstance(payload, dict):
        return None, "neutral"
    motion_name = None
    motion = payload.get("motion")
    if isinstance(motion, str):
        candidate = motion.strip().lower()
        if candidate != "none" and _VALID_MOTION.fullmatch(candidate):
            motion_name = candidate
    expression = "neutral"
    raw_expression = payload.get("expression")
    if isinstance(raw_expression, str) and raw_expression.strip().lower() in AVATAR_EXPRESSIONS:
        expression = raw_expression.strip().lower()
    return motion_name, expression


def _speech_text(raw: str) -> str:
    """読み上げる一文だけを残し、無言指定と穴埋め文言は捨てます。"""
    collapsed = " ".join(_INLINE_AVATAR_PATTERN.sub("", raw).split())
    if not collapsed or collapsed in _PLACEHOLDER_TEXTS or _SILENT_MARKER in collapsed.lower():
        return ""
    return _limit_utterance(collapsed)


def _limit_utterance(text: str) -> str:
    """読み上げが長くなりすぎないよう、文の区切りを優先して短くします。"""
    if len(text) <= _MAX_UTTERANCE_CHARS:
        return text
    clipped = text[:_MAX_UTTERANCE_CHARS]
    for mark in ("。", "！", "？", "!", "?"):
        index = clipped.rfind(mark)
        if index >= 20:
            return clipped[:index + 1]
    return clipped


def _performance_from_stored(value: object) -> GazePerformance | None:
    """旧い一文の保存形式も、動きなしの一ブロックとして読みます。"""
    if isinstance(value, str):
        beat = _beat_from_mapping({"text": value})
        return GazePerformance((beat,)) if beat else None
    if not isinstance(value, dict):
        return None
    raw_beats = value.get("beats")
    if not isinstance(raw_beats, list):
        beat = _beat_from_mapping(value)
        return GazePerformance((beat,)) if beat else None
    beats: list[GazeBeat] = []
    for item in raw_beats:
        beat = _beat_from_mapping(item)
        if beat is not None:
            beats.append(beat)
    if not beats:
        return None
    return GazePerformance(tuple(beats[:_MAX_BEATS]))


def _beat_from_mapping(value: object) -> GazeBeat | None:
    """保存済みの一ブロックから、読み上げできる文と検証済みの演技だけを残します。"""
    if not isinstance(value, dict):
        return None
    raw_text = value.get("text")
    if not isinstance(raw_text, str):
        return None
    text = _speech_text(raw_text)
    if not text:
        return None
    motion = value.get("motion")
    motion_name = None
    if isinstance(motion, str):
        candidate = motion.strip().lower()
        if candidate != "none" and _VALID_MOTION.fullmatch(candidate):
            motion_name = candidate
    expression = "neutral"
    raw_expression = value.get("expression")
    if isinstance(raw_expression, str) and raw_expression.strip().lower() in AVATAR_EXPRESSIONS:
        expression = raw_expression.strip().lower()
    return GazeBeat(text, motion_name, expression)


class GazeSpeechStore:
    """名前が一致するcronジョブの新しい出力だけを、再起動後も話す順で保持します。"""

    def __init__(self, cron_dir: Path, state_path: Path, job_name: str) -> None:
        self._cron_dir = cron_dir
        self._state_path = state_path
        self._job_name = job_name
        self._lock = threading.Lock()
        self._loaded = False
        self._seeded = False
        self._job_found = False
        self._seen: set[str] = set()
        self._queue: list[dict] = []

    def scan(self) -> int:
        """未処理の出力を確認し、新しく積んだ反応の件数を返します。"""
        with self._lock:
            self._load_locked()
            job_ids = self._matching_job_ids()
            self._job_found = bool(job_ids)
            added = 0
            for job_id in job_ids:
                directory = self._output_dir(job_id)
                if directory is None or not directory.is_dir():
                    continue
                for path in sorted(directory.glob("*.md")):
                    if not _OUTPUT_NAME_PATTERN.fullmatch(path.name):
                        continue
                    key = f"{job_id}/{path.name}"
                    if key in self._seen:
                        continue
                    if not self._seeded:
                        self._seen.add(key)
                        continue
                    try:
                        if path.stat().st_size > _MAX_OUTPUT_BYTES:
                            self._seen.add(key)
                            continue
                        text = path.read_text(encoding="utf-8", errors="replace")
                    except OSError:
                        continue
                    self._seen.add(key)
                    performance = extract_gaze_performance(text)
                    if performance is None:
                        continue
                    stored = performance.to_stored()
                    if stored in self._queue:
                        continue
                    if len(self._queue) >= _MAX_QUEUE:
                        self._queue.pop(0)
                    self._queue.append(stored)
                    added += 1
            self._seeded = True
            if len(self._seen) > _MAX_SEEN:
                self._seen = set(list(self._seen)[-_MAX_SEEN:])
            self._save_locked()
            return added

    def status(self) -> dict[str, object]:
        """待ち件数と、対象ジョブを見つけたかだけを返します。"""
        with self._lock:
            self._load_locked()
            return {
                "pending": len(self._queue),
                "job_found": self._job_found,
                "job_name": self._job_name,
            }

    def claim(self) -> GazePerformance | None:
        """次の反応全体を待ち行列から外します。"""
        with self._lock:
            self._load_locked()
            if not self._queue:
                return None
            performance = _performance_from_stored(self._queue.pop(0))
            self._save_locked()
            return performance

    def put_back(self, performance: GazePerformance) -> None:
        """音声化に失敗した反応を、同じ順序の先頭へ戻します。"""
        if not performance.beats:
            return
        stored = performance.to_stored()
        with self._lock:
            self._load_locked()
            if stored not in self._queue:
                self._queue.insert(0, stored)
            self._save_locked()

    def _matching_job_ids(self) -> tuple[str, ...]:
        """jobs.jsonから、視線発話に指定した名前のIDだけを集めます。"""
        try:
            payload = json.loads((self._cron_dir / "jobs.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, UnicodeError):
            return ()
        jobs = payload.get("jobs") if isinstance(payload, dict) else payload
        if not isinstance(jobs, list):
            return ()
        ids: list[str] = []
        for job in jobs:
            if not isinstance(job, dict) or job.get("name") != self._job_name:
                continue
            job_id = job.get("id")
            if isinstance(job_id, str) and self._output_dir(job_id) is not None:
                ids.append(job_id)
        return tuple(ids)

    def _output_dir(self, job_id: str) -> Path | None:
        """ジョブIDをcron出力ディレクトリの直下だけに解決します。"""
        if not _JOB_ID_PATTERN.fullmatch(job_id):
            return None
        root = (self._cron_dir / "output").resolve()
        path = (root / job_id).resolve()
        if path == root or root not in path.parents:
            return None
        return path

    def _load_locked(self) -> None:
        """プロセス内では最初の一回だけ状態ファイルを読みます。"""
        if self._loaded:
            return
        self._loaded = True
        try:
            payload = json.loads(self._state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, UnicodeError):
            return
        if not isinstance(payload, dict):
            return
        self._seeded = payload.get("seeded") is True
        seen = payload.get("seen")
        if isinstance(seen, list):
            self._seen = {item for item in seen if isinstance(item, str)}
        queue = payload.get("queue")
        if isinstance(queue, list):
            restored: list[dict] = []
            for item in queue:
                performance = _performance_from_stored(item)
                if performance is not None:
                    restored.append(performance.to_stored())
            self._queue = restored

    def _save_locked(self) -> None:
        """待ち行列の消失を避けるため、一時ファイル経由で状態を置き換えます。"""
        self._state_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._state_path.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(
                {
                    "seeded": self._seeded,
                    "seen": sorted(self._seen),
                    "queue": self._queue,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        temporary.replace(self._state_path)
