"""Style-Bert-VITS2の音声を生成し、ブラウザが再生できる一時資産へ保存します。"""

import asyncio
from pathlib import Path
from uuid import uuid4

import httpx

from ..config import Settings


class TtsError(RuntimeError):
    """TTS接続の失敗を会話自体の失敗と区別するための例外です。"""


def create_tts_client() -> httpx.AsyncClient:
    """文ごとの合成で接続を再利用できるStyle-Bert-VITS2用クライアントを作ります。"""
    return httpx.AsyncClient(timeout=httpx.Timeout(180, connect=10))


async def synthesize(
    text: str,
    config: Settings,
    client: httpx.AsyncClient | None = None,
) -> tuple[str, Path]:
    """前実装と互換性のあるパラメーターで音声を作り、文単位の一時WAVとして保存します。"""
    if client is None:
        # 単体利用時も従来どおり呼べるよう、必要な場合だけ一時クライアントを所有します。
        async with create_tts_client() as owned_client:
            return await synthesize(text, config, owned_client)

    endpoint = config.tts_server_url
    if not endpoint.endswith("/voice"):
        endpoint = f"{endpoint}/voice"

    params = {
        "text": text,
        "model_id": config.tts_model_id,
        "style": config.tts_style,
        "sdp_ratio": config.tts_sdp_ratio,
        "length": config.tts_length,
        "language": "JP",
    }
    headers = {"Content-Type": "audio/wav"}
    if config.tts_api_key:
        headers["Authorization"] = f"Bearer {config.tts_api_key}"

    try:
        response = await client.post(endpoint, params=params, headers=headers)
        if response.status_code >= 400:
            raise TtsError(f"Style-Bert-VITS2 APIエラー ({response.status_code}): {response.text[:500]}")
    except httpx.HTTPError as exc:
        raise TtsError(f"Style-Bert-VITS2へ接続できません: {exc}") from exc

    utterance_id = uuid4().hex
    output = config.audio_dir / f"{utterance_id}.wav"
    write_task: asyncio.Task[int] | None = None
    try:
        config.audio_dir.mkdir(parents=True, exist_ok=True)
        # スレッド書き込みをshieldし、取消後も子タスク側で安全に完了できるようにします。
        write_task = asyncio.create_task(asyncio.to_thread(output.write_bytes, response.content))
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
