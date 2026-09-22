"""Style-Bert-VITS2の中断時にも、一時音声ファイルを残さないことを検証します。"""

import asyncio
from dataclasses import replace
from pathlib import Path
from threading import Event

import pytest

from app.config import settings
from app.services import stylebertvits2 as tts_module


class _SuccessfulTtsClient:
    """外部TTSを起動せず、正常なWAV応答だけを返します。"""

    async def post(self, _endpoint, *, params, headers):
        del params, headers
        return type("Response", (), {"status_code": 200, "content": b"wav-data", "text": ""})()


@pytest.mark.asyncio
async def test_cancel_during_file_write_cleans_up_after_thread_finishes(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """スレッド書き込み中に取り消しても、遅れて作られたWAVを完了後に削除します。"""
    write_started = Event()
    allow_write = Event()
    write_finished = Event()
    original_write_bytes = Path.write_bytes

    def delayed_write_bytes(path: Path, data: bytes) -> int:
        write_started.set()
        allow_write.wait(timeout=1)
        result = original_write_bytes(path, data)
        write_finished.set()
        return result

    monkeypatch.setattr(Path, "write_bytes", delayed_write_bytes)
    config = replace(settings, audio_dir=tmp_path)
    task = asyncio.create_task(tts_module.synthesize("中断テスト", config, _SuccessfulTtsClient()))

    for _ in range(100):
        if write_started.is_set():
            break
        await asyncio.sleep(0.01)
    assert write_started.is_set()
    task.cancel()
    await asyncio.sleep(0)
    allow_write.set()

    with pytest.raises(asyncio.CancelledError):
        await task

    for _ in range(100):
        if write_finished.is_set() and not list(tmp_path.glob("*.wav")):
            break
        await asyncio.sleep(0.01)
    assert write_finished.is_set()
    assert list(tmp_path.glob("*.wav")) == []
