"""音声合成と音声認識の各提供元が共有する、例外と一時音声の保存を定義します。"""

import asyncio
import sys
import wave
from array import array
from io import BytesIO
from pathlib import Path
from uuid import uuid4

import httpx

from ..config import Settings

# 10ms窓のピークがこれ未満なら無音とみなします。16bitのおよそ-38dBFSです。
_SILENCE_PEAK = 400
_WINDOW_MS = 10
# これより短い無音は息継ぎとして残し、Style-Bert-VITS2に元からある間は変えません。
_LEAD_LIMIT_MS = 150
_LEAD_KEEP_MS = 40
_TAIL_LIMIT_MS = 250
_TAIL_KEEP_MS = 80
_GAP_LIMIT_MS = 400
_GAP_KEEP_MS = 180


class TtsError(RuntimeError):
    """TTS接続の失敗を会話自体の失敗と区別するための例外です。"""


class TranscriptionError(RuntimeError):
    """音声デコードや推論の失敗を、内部情報を含まないAPIエラーへまとめます。"""


class TranscriptionUnavailableError(TranscriptionError):
    """依存関係やモデルを準備できず、音声認識を開始できない場合に使います。"""


class NoSpeechDetectedError(TranscriptionError):
    """正常に処理できたものの、送信できる発話本文が得られない場合に使います。"""


def create_tts_client() -> httpx.AsyncClient:
    """提供元を問わず、文ごとの合成で接続を再利用できるクライアントを作ります。"""
    return httpx.AsyncClient(timeout=httpx.Timeout(180, connect=10))


def _ms_to_frames(duration_ms: int, rate: int) -> int:
    """無音判定のミリ秒を、保存するWAVのフレーム数へ変えます。"""
    return max(1, int(rate * duration_ms / 1000))


def _read_pcm16(audio: bytes) -> tuple[int, int, array] | None:
    """16bit PCMのWAVだけを解き、判定できない形式はそのまま保存させるためNoneを返します。"""
    if len(audio) < 12 or audio[:4] != b"RIFF" or audio[8:12] != b"WAVE":
        return None
    try:
        with wave.open(BytesIO(audio)) as reader:
            if reader.getcomptype() != "NONE" or reader.getsampwidth() != 2:
                return None
            channels = reader.getnchannels()
            rate = reader.getframerate()
            raw = reader.readframes(reader.getnframes())
    except (wave.Error, EOFError):
        return None
    if channels < 1 or rate <= 0 or len(raw) < 2 or len(raw) % 2:
        return None
    samples = array("h")
    samples.frombytes(raw)
    if sys.byteorder != "little":
        samples.byteswap()
    if len(samples) % channels:
        return None
    return channels, rate, samples


def _write_pcm16(channels: int, rate: int, samples: array) -> bytes:
    """詰めたサンプルを、ブラウザがそのまま再生できる16bit WAVへ戻します。"""
    if sys.byteorder != "little":
        samples = array("h", samples)
        samples.byteswap()
    destination = BytesIO()
    with wave.open(destination, "wb") as writer:
        writer.setnchannels(channels)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        writer.writeframes(samples.tobytes())
    return destination.getvalue()


def _silence_runs(samples: array, channels: int, rate: int) -> list[tuple[int, int, bool]] | None:
    """発話が無い録音は切らず、無音と音声の区間をフレーム位置で返します。"""
    frame_count = len(samples) // channels
    window = _ms_to_frames(_WINDOW_MS, rate)
    runs: list[tuple[int, int, bool]] = []
    has_speech = False
    frame = 0
    while frame < frame_count:
        count = min(window, frame_count - frame)
        offset = frame * channels
        peak = 0
        for value in samples[offset : offset + count * channels]:
            magnitude = abs(value)
            if magnitude > peak:
                peak = magnitude
        silent = peak < _SILENCE_PEAK
        has_speech = has_speech or not silent
        if runs and runs[-1][2] is silent:
            start, _end, _silent = runs[-1]
            runs[-1] = (start, frame + count, silent)
        else:
            runs.append((frame, frame + count, silent))
        frame += count
    if not has_speech:
        return None
    return runs


def _kept_ranges(
    runs: list[tuple[int, int, bool]],
    rate: int,
) -> list[tuple[int, int]] | None:
    """長い無音だけを短くし、切る必要がなければNoneを返して元のWAVを保ちます。"""
    lead_limit = _ms_to_frames(_LEAD_LIMIT_MS, rate)
    lead_keep = _ms_to_frames(_LEAD_KEEP_MS, rate)
    tail_limit = _ms_to_frames(_TAIL_LIMIT_MS, rate)
    tail_keep = _ms_to_frames(_TAIL_KEEP_MS, rate)
    gap_limit = _ms_to_frames(_GAP_LIMIT_MS, rate)
    gap_keep = _ms_to_frames(_GAP_KEEP_MS, rate)
    ranges: list[tuple[int, int]] = []
    changed = False
    last = len(runs) - 1
    for index, (start, end, silent) in enumerate(runs):
        if not silent:
            ranges.append((start, end))
            continue
        length = end - start
        if index == 0 and length > lead_limit:
            ranges.append((end - lead_keep, end))
            changed = True
        elif index == last and length > tail_limit:
            ranges.append((start, start + tail_keep))
            changed = True
        elif 0 < index < last and length > gap_limit:
            # 前の語の余韻と次の語の立ち上がりを残し、間の真ん中だけを落とします。
            head = gap_keep // 2
            ranges.append((start, start + head))
            ranges.append((end - (gap_keep - head), end))
            changed = True
        else:
            ranges.append((start, end))
    if not changed:
        return None
    return ranges


class StreamingSilenceTrimmer:
    """届いたPCMを順に見て、長い無音だけを後から短くします。"""

    def __init__(self, rate: int) -> None:
        self._window = _ms_to_frames(_WINDOW_MS, rate)
        self._lead_limit = _ms_to_frames(_LEAD_LIMIT_MS, rate)
        self._lead_keep = _ms_to_frames(_LEAD_KEEP_MS, rate)
        self._tail_limit = _ms_to_frames(_TAIL_LIMIT_MS, rate)
        self._tail_keep = _ms_to_frames(_TAIL_KEEP_MS, rate)
        self._gap_limit = _ms_to_frames(_GAP_LIMIT_MS, rate)
        self._gap_keep = _ms_to_frames(_GAP_KEEP_MS, rate)
        self._pending = array("h")
        self._lead = array("h")
        self._gap = array("h")
        self._odd = b""
        self._in_lead = True
        self._lead_truncated = False

    def push(self, pcm: bytes) -> bytes:
        """完全な窓だけを判定し、今すぐ再生してよいサンプルを返します。"""
        if self._odd:
            pcm = self._odd + pcm
            self._odd = b""
        if len(pcm) % 2:
            self._odd = pcm[-1:]
            pcm = pcm[:-1]
        if not pcm:
            return b""
        incoming = array("h")
        incoming.frombytes(pcm)
        if sys.byteorder != "little":
            incoming.byteswap()
        self._pending.extend(incoming)
        outgoing = array("h")
        while len(self._pending) >= self._window:
            frame = self._pending[:self._window]
            del self._pending[:self._window]
            outgoing.extend(self._consume(frame))
        return _pcm16_bytes(outgoing)

    def finish(self) -> bytes:
        """残りを末尾とみなし、長すぎる無音は短い余韻だけ残します。"""
        outgoing = array("h")
        if self._pending:
            outgoing.extend(self._consume(self._pending))
            self._pending = array("h")
        if self._in_lead:
            return b""
        tail = self._gap
        self._gap = array("h")
        tail.extend(outgoing)
        if len(tail) > self._tail_limit:
            tail = tail[:self._tail_keep]
        return _pcm16_bytes(tail)

    def _consume(self, frame: array) -> array:
        """無音は次の音声か終了まで保持し、発話はすぐ通します。"""
        loud = max((abs(value) for value in frame), default=0) >= _SILENCE_PEAK
        if self._in_lead:
            if not loud:
                self._lead.extend(frame)
                if len(self._lead) > self._lead_limit:
                    self._lead = self._lead[-self._lead_keep:]
                    self._lead_truncated = True
                return array("h")
            self._in_lead = False
            if self._lead_truncated or len(self._lead) > self._lead_limit:
                prefix = self._lead[-self._lead_keep:]
            else:
                prefix = self._lead
            self._lead = array("h")
            prefix.extend(frame)
            return prefix
        if not loud:
            self._gap.extend(frame)
            return array("h")
        released = self._release_gap()
        released.extend(frame)
        return released

    def _release_gap(self) -> array:
        """途中の長い無音は、前後の短い間だけを残して中央を落とします。"""
        gap = self._gap
        self._gap = array("h")
        if len(gap) <= self._gap_limit:
            return gap
        head = self._gap_keep // 2
        return gap[:head] + gap[-(self._gap_keep - head):]


def _pcm16_bytes(samples: array) -> bytes:
    """再生側へ渡す、16bitリトルエンディアンのPCMを作ります。"""
    if not samples:
        return b""
    if sys.byteorder != "little":
        samples = array("h", samples)
        samples.byteswap()
    return samples.tobytes()


def trim_wav_silence(audio: bytes) -> bytes:
    """取得した読み上げの長い無音を短くし、短い間と判定できない音声はそのまま返します。"""
    parsed = _read_pcm16(audio)
    if parsed is None:
        return audio
    channels, rate, samples = parsed
    runs = _silence_runs(samples, channels, rate)
    if runs is None:
        return audio
    ranges = _kept_ranges(runs, rate)
    if not ranges:
        return audio
    kept = array("h")
    for start, end in ranges:
        kept.extend(samples[start * channels : end * channels])
    if not kept:
        return audio
    return _write_pcm16(channels, rate, kept)


async def store_utterance_audio(audio: bytes, config: Settings) -> tuple[str, Path]:
    """合成済み音声を文単位の一時WAVへ保存し、取消時は生成物を残しません。"""
    utterance_id = uuid4().hex
    output = config.audio_dir / f"{utterance_id}.wav"
    write_task: asyncio.Task[int] | None = None
    try:
        config.audio_dir.mkdir(parents=True, exist_ok=True)
        # 長い無音を落としてから保存し、次の文を待たせないようにします。
        audio = await asyncio.to_thread(trim_wav_silence, audio)
        # スレッド書き込みをshieldし、取消後も子タスク側で安全に完了できるようにします。
        write_task = asyncio.create_task(asyncio.to_thread(output.write_bytes, audio))
        await asyncio.shield(write_task)
    except asyncio.CancelledError:
        def cleanup_cancelled_audio(task: asyncio.Task[int] | None) -> None:
            """取消後も動く書き込みスレッドの完了時に、生成物だけを回収します。"""
            if task:
                try:
                    task.result()
                except (asyncio.CancelledError, Exception):
                    # 書き込み側の副次的な失敗は、元の中断理由を置き換えません。
                    pass
            try:
                output.unlink(missing_ok=True)
            except OSError:
                pass

        if write_task:
            # 中断応答を遅らせず、スレッドが後から書き終えてもコールバックで削除します。
            write_task.add_done_callback(cleanup_cancelled_audio)
        else:
            cleanup_cancelled_audio(None)
        raise
    except OSError as exc:
        raise TtsError(f"音声ファイルを保存できません: {exc}") from exc
    return utterance_id, output
