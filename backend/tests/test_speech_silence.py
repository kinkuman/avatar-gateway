"""読み上げWAVに入った長い無音だけを短くすることを検証します。"""

import math
import struct
import wave
from array import array
from dataclasses import replace
from io import BytesIO

import pytest

from app.config import settings
from app.services.speech_base import StreamingSilenceTrimmer, store_utterance_audio, trim_wav_silence


def _pcm(seconds: float, rate: int, channels: int, amplitude: int) -> bytes:
    """無音か一定音量の試験信号を作ります。"""
    samples = array("h")
    for index in range(int(seconds * rate)):
        if amplitude:
            value = int(amplitude * math.sin(2 * math.pi * 440 * index / rate))
        else:
            value = 0
        samples.extend(value for _ in range(channels))
    return struct.pack(f"<{len(samples)}h", *samples)


def _wav(parts: list[tuple[float, int]], rate: int = 48_000, channels: int = 1) -> bytes:
    """無音と音声をつないだWAVを作ります。振幅が0なら無音です。"""
    destination = BytesIO()
    with wave.open(destination, "wb") as writer:
        writer.setnchannels(channels)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        for seconds, amplitude in parts:
            writer.writeframes(_pcm(seconds, rate, channels, amplitude))
    return destination.getvalue()


def _duration(audio: bytes) -> float:
    with wave.open(BytesIO(audio)) as reader:
        return reader.getnframes() / reader.getframerate()


def test_long_edge_and_gap_silence_is_shortened() -> None:
    """speech.cppが付ける前後と文の間の長い無音だけを短くします。"""
    original = _wav([(0.84, 0), (0.20, 12_000), (0.80, 0), (0.20, 12_000), (0.90, 0)])

    trimmed = trim_wav_silence(original)

    assert _duration(trimmed) == pytest.approx(0.04 + 0.20 + 0.18 + 0.20 + 0.08, abs=0.02)


def test_short_pauses_stay_untouched() -> None:
    """Style-Bert-VITS2に元からある短い間は、バイト列も含めて変えません。"""
    original = _wav([(0.08, 0), (0.30, 12_000), (0.16, 0), (0.30, 12_000), (0.12, 0)], rate=44_100)

    assert trim_wav_silence(original) == original


def test_non_wav_and_silence_only_pass_through() -> None:
    """WAVでない応答や、発話の無い録音は切らずに返します。"""
    assert trim_wav_silence(b"wav-data") == b"wav-data"
    silence = _wav([(1.0, 0)])
    assert trim_wav_silence(silence) == silence


def test_stereo_silence_is_trimmed_without_dropping_a_channel() -> None:
    """ステレオでも両チャンネルを残し、長い先頭無音だけを短くします。"""
    trimmed = trim_wav_silence(_wav([(0.80, 0), (0.20, 12_000)], channels=2))

    with wave.open(BytesIO(trimmed)) as reader:
        assert reader.getnchannels() == 2
        assert reader.getframerate() == 48_000
        assert reader.getnframes() / reader.getframerate() == pytest.approx(0.24, abs=0.02)


@pytest.mark.asyncio
async def test_saved_utterance_drops_long_silence(tmp_path) -> None:
    """保存する一時WAVが、再生前に長い無音を落としていることを確認します。"""
    original = _wav([(0.84, 0), (0.25, 12_000), (0.90, 0)])
    config = replace(settings, audio_dir=tmp_path)

    _utterance_id, path = await store_utterance_audio(original, config)

    assert _duration(path.read_bytes()) == pytest.approx(0.04 + 0.25 + 0.08, abs=0.02)


def test_streamed_silence_matches_the_saved_wav_trim() -> None:
    """分割して届いても、保存前に詰めたWAVと同じ長さまで短くします。"""
    parts = [(0.84, 0), (0.20, 12_000), (0.80, 0), (0.20, 12_000), (0.90, 0)]
    trimmer = StreamingSilenceTrimmer(48_000)
    streamed = bytearray()
    for seconds, amplitude in parts:
        pcm = _pcm(seconds, 48_000, 1, amplitude)
        for offset in range(0, len(pcm), 1000):
            streamed.extend(trimmer.push(pcm[offset:offset + 1000]))
    streamed.extend(trimmer.finish())

    assert len(streamed) / 2 / 48_000 == pytest.approx(0.04 + 0.20 + 0.18 + 0.20 + 0.08, abs=0.03)
