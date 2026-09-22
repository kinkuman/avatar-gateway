"""LLM生成と文単位TTSが並行し、音声通知の順序を維持することを検証します。"""

import asyncio
import json
import re
from dataclasses import replace

import pytest

from app import main as main_module
from app.models import HermesConversationRequest
from app.services.motion_tags import MotionCatalog, MotionDefinition
from app.services.hermes_diagnostics import EMPTY_RESPONSE_NOTICE


class _DummyTtsClient:
    """ネットワーク接続を作らず、TTSクライアントのライフサイクルだけを再現します。"""

    async def __aenter__(self):
        return self

    async def __aexit__(self, _exc_type, _exc, _traceback):
        return None


@pytest.mark.asyncio
async def test_hermes_empty_response_is_shown_in_japanese_without_tts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """空応答の英語診断を読み上げず、正式履歴も日本語表示へ統一します。"""
    diagnostic = (
        "⚠️ No reply: the model returned empty content after retries and any fallback providers. "
        "Try `continue`, switch model/provider, or inspect the tool output above."
    )
    synthesized: list[str] = []

    async def fake_stream_agent_run(_request, _motion_prompt):
        yield "assistant.completed", {"output": diagnostic}
        yield "session.messages", {
            "data": [
                {"role": "user", "content": "[touch:head]"},
                {"role": "assistant", "content": "(empty)"},
            ],
        }

    async def fake_synthesize(text, _settings, _client):
        synthesized.append(text)
        raise AssertionError("診断文をTTSへ送ってはいけません")

    monkeypatch.setattr(main_module, "_stream_agent_run", fake_stream_agent_run)
    monkeypatch.setattr(main_module, "synthesize", fake_synthesize)
    monkeypatch.setattr(main_module, "create_tts_client", _DummyTtsClient)
    monkeypatch.setattr(main_module, "_load_motion_catalog", lambda: MotionCatalog((), None))
    monkeypatch.setattr(main_module, "settings", replace(main_module.settings, tts_enabled=True))

    response = await main_module.stream_hermes_conversation(
        HermesConversationRequest(input="[touch:head]"),
    )
    body = "".join([
        chunk.decode() if isinstance(chunk, bytes) else chunk
        async for chunk in response.body_iterator
    ])

    assert synthesized == []
    assert diagnostic not in body
    assert EMPTY_RESPONSE_NOTICE in body
    assert "event: speech.requested" not in body
    assert '"content": "(empty)"' not in body


@pytest.mark.asyncio
async def test_sequence_cancel_finishes_stream_without_waiting_for_tts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """開始直後のTTSを停止しても、Hermes本文のSSEが終了待ちで固まらないことを確認します。"""
    synthesis_wait = asyncio.Event()

    async def fake_stream_agent_run(_request, _motion_prompt):
        yield "assistant.delta", {"delta": "[speech]停止対象の音声です。[/speech]"}
        yield "assistant.completed", {"output": "[speech]停止対象の音声です。[/speech]"}

    async def fake_synthesize(_text, _settings, _client):
        await synthesis_wait.wait()
        raise AssertionError("読み上げ停止後に合成を完了してはいけません")

    monkeypatch.setattr(main_module, "_stream_agent_run", fake_stream_agent_run)
    monkeypatch.setattr(main_module, "synthesize", fake_synthesize)
    monkeypatch.setattr(main_module, "create_tts_client", _DummyTtsClient)
    monkeypatch.setattr(main_module, "_load_motion_catalog", lambda: MotionCatalog((), None))
    monkeypatch.setattr(main_module, "settings", replace(main_module.settings, tts_enabled=True))

    response = await main_module.stream_hermes_conversation(
        HermesConversationRequest(input="停止して"),
    )
    iterator = response.body_iterator
    body_parts: list[str] = []
    sequence_id = ""
    while not sequence_id:
        chunk = await asyncio.wait_for(iterator.__anext__(), timeout=1)
        text = chunk.decode() if isinstance(chunk, bytes) else chunk
        body_parts.append(text)
        match = re.search(r'"sequence_id": "([0-9a-f]{32})"', text)
        if match:
            sequence_id = match.group(1)

    await main_module.cancel_speech_sequence(sequence_id)
    body_parts.extend([
        chunk.decode() if isinstance(chunk, bytes) else chunk
        async for chunk in iterator
    ])

    assert "event: done" in "".join(body_parts)
    assert sequence_id not in main_module.speech_sequence_workers


@pytest.mark.asyncio
async def test_first_sentence_is_synthesized_before_llm_finishes(monkeypatch: pytest.MonkeyPatch) -> None:
    """LLMが次文を生成中でも、完成した最初の文のWAV通知が先に届きます。"""
    first_synthesis_started = asyncio.Event()
    synthesized: list[str] = []

    async def fake_stream_agent_run(_request, _motion_prompt):
        yield "assistant.delta", {"delta": "[speech]最初の説明が完成しました。"}
        yield "assistant.delta", {"delta": "次"}
        await asyncio.wait_for(first_synthesis_started.wait(), timeout=1)
        yield "assistant.delta", {"delta": "の説明も完成しました。[/speech]"}
        yield "assistant.completed", {
            "output": "[speech]最初の説明が完成しました。次の説明も完成しました。[/speech]",
        }
        yield "session.messages", {
            "data": [
                {"role": "user", "content": "説明して"},
                {
                    "role": "assistant",
                    "content": "[speech]最初の説明が完成しました。次の説明も完成しました。[/speech]",
                },
            ],
        }

    async def fake_synthesize(text, _settings, _client):
        synthesized.append(text)
        if len(synthesized) == 1:
            first_synthesis_started.set()
        utterance_id = f"utterance-{len(synthesized)}"
        return utterance_id, main_module.settings.audio_dir / f"{utterance_id}.wav"

    monkeypatch.setattr(main_module, "_stream_agent_run", fake_stream_agent_run)
    monkeypatch.setattr(main_module, "synthesize", fake_synthesize)
    monkeypatch.setattr(main_module, "create_tts_client", _DummyTtsClient)
    monkeypatch.setattr(main_module, "_load_motion_catalog", lambda: MotionCatalog((), None))
    monkeypatch.setattr(main_module, "settings", replace(main_module.settings, tts_enabled=True))

    response = await main_module.stream_hermes_conversation(
        HermesConversationRequest(input="説明して"),
    )
    body_parts: list[str] = []
    async for chunk in response.body_iterator:
        body_parts.append(chunk.decode() if isinstance(chunk, bytes) else chunk)
    body = "".join(body_parts)

    assert synthesized == ["最初の説明が完成しました。", "次の説明も完成しました。"]
    assert body.index('"segment_index": 0') < body.index("event: text.completed")
    assert body.index('"segment_index": 0') < body.index('"segment_index": 1')
    assert body.index("event: session.messages") < body.index("event: text.completed")
    assert '"segments": 2' in body
    assert body.rstrip().endswith("data: {}")


@pytest.mark.asyncio
async def test_multiple_avatar_scenes_switch_motion_and_expression_at_audio_boundary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """回答途中の後続タグを、直前の音声へ混ぜず次の再生タスクへ適用します。"""
    synthesized: list[str] = []
    cute = MotionDefinition(
        "cute_standing",
        "かわいく立つ",
        "cute_standing.vrma",
        "かわいらしい反応",
        True,
        True,
    )
    motion_catalog = MotionCatalog((cute,), None)
    output = (
        '[avatar]{"v":1,"motion":"cute_standing","expression":"happy"}[/avatar]\n'
        "[speech]実装してくれたの！？[/speech]\n"
        '[avatar]{"v":1,"motion":"none","expression":"shy"}[/avatar]\n'
        "[speech]えへへ、ちょっと照れるね……。[/speech]"
    )

    async def fake_stream_agent_run(_request, _motion_prompt):
        """実際に観測した、二つ目のavatarタグが途中で分割される応答を再現します。"""
        split = output.index("[avatar]", 1) + 4
        yield "assistant.delta", {"delta": output[:split]}
        yield "assistant.delta", {"delta": output[split:]}
        yield "assistant.completed", {"output": output}

    async def fake_synthesize(text, _settings, _client):
        synthesized.append(text)
        utterance_id = f"scene-{len(synthesized)}"
        return utterance_id, main_module.settings.audio_dir / f"{utterance_id}.wav"

    monkeypatch.setattr(main_module, "_stream_agent_run", fake_stream_agent_run)
    monkeypatch.setattr(main_module, "synthesize", fake_synthesize)
    monkeypatch.setattr(main_module, "create_tts_client", _DummyTtsClient)
    monkeypatch.setattr(main_module, "_load_motion_catalog", lambda: motion_catalog)
    monkeypatch.setattr(main_module, "settings", replace(main_module.settings, tts_enabled=True))

    response = await main_module.stream_hermes_conversation(
        HermesConversationRequest(input="途中で照れて"),
    )
    body = "".join([
        chunk.decode() if isinstance(chunk, bytes) else chunk
        async for chunk in response.body_iterator
    ])
    requested = [
        json.loads(block.split("data: ", 1)[1])
        for block in body.split("\n\n")
        if block.startswith("event: speech.requested")
    ]

    assert synthesized == ["実装してくれたの！？", "えへへ、ちょっと照れるね……。"]
    assert requested[0]["motion"]["name"] == "cute_standing"
    assert requested[0]["expression"] == "happy"
    assert requested[1]["motion"] is None
    assert requested[1]["expression"] == "shy"
    assert "[avatar]" not in body
    assert "[speech]" not in body
    assert '"segments": 2' in body


@pytest.mark.asyncio
async def test_approval_preamble_and_result_are_synthesized_in_conversation_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """承認操作とは独立して予告を読み、差分のない最終結果も後続音声として残します。"""
    preamble_synthesis_started = asyncio.Event()
    synthesized: list[str] = []
    think = MotionDefinition("think", "考える", "think.vrma", "作業前の確認", True, True)
    motion_catalog = MotionCatalog((think,), None)
    preamble = (
        '[avatar]{"v":1,"motion":"think","expression":"relaxed"}[/avatar]\n'
        "[speech]了解！コマンドを再実行するね。[/speech]"
    )

    async def fake_stream_agent_run(_request, _motion_prompt):
        yield "assistant.delta", {"delta": preamble, "sequence": 7}
        yield "approval.requested", {
            "run_id": "run_test",
            "command": "printf approval-test",
            "choices": ["once", "deny"],
        }
        # 承認結果を待つ間にも、予告文の合成が開始されることを再現します。
        await asyncio.wait_for(preamble_synthesis_started.wait(), timeout=1)
        yield "approval.responded", {"run_id": "run_test", "choice": "once"}
        yield "tool.started", {"tool": "terminal"}
        yield "tool.completed", {"tool": "terminal", "error": False}
        # 実Hermes同様、Run完了本文には承認前後の二発話が連結される場合があります。
        yield "assistant.completed", {
            "output": (
                f'{preamble}\n[avatar]{{"v":1,"motion":"none","expression":"happy"}}[/avatar] '
                "[speech]無事に実行できたよ！[/speech]"
            ),
        }

    async def fake_synthesize(text, _settings, _client):
        synthesized.append(text)
        if len(synthesized) == 1:
            preamble_synthesis_started.set()
        utterance_id = f"approval-utterance-{len(synthesized)}"
        return utterance_id, main_module.settings.audio_dir / f"{utterance_id}.wav"

    monkeypatch.setattr(main_module, "_stream_agent_run", fake_stream_agent_run)
    monkeypatch.setattr(main_module, "synthesize", fake_synthesize)
    monkeypatch.setattr(main_module, "create_tts_client", _DummyTtsClient)
    monkeypatch.setattr(main_module, "_load_motion_catalog", lambda: motion_catalog)
    monkeypatch.setattr(main_module, "settings", replace(main_module.settings, tts_enabled=True))

    response = await main_module.stream_hermes_conversation(
        HermesConversationRequest(input="実行して"),
    )
    body = "".join([
        chunk.decode() if isinstance(chunk, bytes) else chunk
        async for chunk in response.body_iterator
    ])

    assert synthesized == ["了解！コマンドを再実行するね。", "無事に実行できたよ！"]
    assert body.index('"segment_index": 0') < body.index('"segment_index": 1')
    assert body.rfind("event: text.delta") < body.index("event: assistant.completed")
    assert 'event: text.delta\ndata: {"delta": "了解！コマンドを再実行するね。", "sequence": 7}' in body
    assert '"motion": {"name": "think"' in body
    assert '"motion": null' in body
    assert '"expression": "relaxed"' in body
    assert '"expression": "happy"' in body
    assert "[avatar]" not in body
    assert "[motion:" not in body
    assert "[speech]" not in body
    assert '"segments": 2' in body


@pytest.mark.asyncio
async def test_tts_failure_does_not_stop_later_sentences(monkeypatch: pytest.MonkeyPatch) -> None:
    """一文の合成失敗を通知しつつ、後続文とテキスト応答を最後まで処理します。"""
    from app.services.stylebertvits2 import TtsError

    attempts = 0

    async def fake_stream_agent_run(_request, _motion_prompt):
        yield "assistant.delta", {"delta": "最初の文章は失敗します。次"}
        yield "assistant.delta", {"delta": "の文章は成功します。"}
        yield "assistant.completed", {"output": "最初の文章は失敗します。次の文章は成功します。"}

    async def fake_synthesize(_text, _settings, _client):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise TtsError("一時的な失敗")
        return "utterance-ok", main_module.settings.audio_dir / "utterance-ok.wav"

    monkeypatch.setattr(main_module, "_stream_agent_run", fake_stream_agent_run)
    monkeypatch.setattr(main_module, "synthesize", fake_synthesize)
    monkeypatch.setattr(main_module, "create_tts_client", _DummyTtsClient)
    monkeypatch.setattr(main_module, "_load_motion_catalog", lambda: MotionCatalog((), None))
    monkeypatch.setattr(main_module, "settings", replace(main_module.settings, tts_enabled=True))

    response = await main_module.stream_hermes_conversation(
        HermesConversationRequest(input="続けて"),
    )
    body = "".join([
        chunk.decode() if isinstance(chunk, bytes) else chunk
        async for chunk in response.body_iterator
    ])

    assert attempts == 2
    assert "event: speech.failed" in body
    assert '"segment_index": 1' in body
    assert "event: text.completed" in body
    assert "event: done" in body


@pytest.mark.asyncio
async def test_disabled_tts_finishes_without_starting_worker_client(monkeypatch: pytest.MonkeyPatch) -> None:
    """音声OFFでもキュー終端を処理し、従来どおりテキスト会話を完了します。"""
    async def fake_stream_agent_run(_request, _motion_prompt):
        yield "assistant.delta", {"delta": "テキストだけの回答です。"}
        yield "assistant.completed", {"output": "テキストだけの回答です。"}

    def unexpected_client():
        raise AssertionError("音声OFFではTTSクライアントを作りません")

    monkeypatch.setattr(main_module, "_stream_agent_run", fake_stream_agent_run)
    monkeypatch.setattr(main_module, "create_tts_client", unexpected_client)
    monkeypatch.setattr(main_module, "_load_motion_catalog", lambda: MotionCatalog((), None))
    monkeypatch.setattr(main_module, "settings", replace(main_module.settings, tts_enabled=False))

    response = await main_module.stream_hermes_conversation(
        HermesConversationRequest(input="文字だけで"),
    )
    body = "".join([
        chunk.decode() if isinstance(chunk, bytes) else chunk
        async for chunk in response.body_iterator
    ])

    assert "テキストだけの回答です。" in body
    assert "event: speech.requested" not in body
    assert "event: done" in body


@pytest.mark.asyncio
async def test_hermes_error_terminates_both_producers(monkeypatch: pytest.MonkeyPatch) -> None:
    """LLM接続失敗時にTTS待機タスクを残さず、エラーイベントで終了します。"""
    from app.services.hermes import HermesError

    async def fake_stream_agent_run(_request, _motion_prompt):
        if False:
            yield "assistant.delta", {"delta": ""}
        raise HermesError("Hermesテストエラー")

    monkeypatch.setattr(main_module, "_stream_agent_run", fake_stream_agent_run)
    monkeypatch.setattr(main_module, "create_tts_client", _DummyTtsClient)
    monkeypatch.setattr(main_module, "_load_motion_catalog", lambda: MotionCatalog((), None))
    monkeypatch.setattr(main_module, "settings", replace(main_module.settings, tts_enabled=True))

    response = await main_module.stream_hermes_conversation(
        HermesConversationRequest(input="失敗確認"),
    )
    body = "".join([
        chunk.decode() if isinstance(chunk, bytes) else chunk
        async for chunk in response.body_iterator
    ])

    assert "Hermesテストエラー" in body
    assert "event: error" in body
    assert "event: done" not in body


@pytest.mark.asyncio
async def test_client_disconnect_cancels_stream_and_removes_audio(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ブラウザがSSEを中断した場合、待機中のHermes処理と生成済みWAVを残しません。"""
    stream_cancelled = asyncio.Event()
    wait_forever = asyncio.Event()
    audio_path = tmp_path / "utterance-cancel.wav"

    async def fake_stream_agent_run(_request, _motion_prompt):
        try:
            yield "assistant.delta", {"delta": "[speech]中断前に完成した最初の文章です。"}
            # 次の文字で句点直後の保留を解き、最初の文だけをTTSへ渡します。
            yield "assistant.delta", {"delta": "次"}
            await wait_forever.wait()
        finally:
            stream_cancelled.set()

    async def fake_synthesize(_text, _settings, _client):
        audio_path.write_bytes(b"wav")
        return "utterance-cancel", audio_path

    monkeypatch.setattr(main_module, "_stream_agent_run", fake_stream_agent_run)
    monkeypatch.setattr(main_module, "synthesize", fake_synthesize)
    monkeypatch.setattr(main_module, "create_tts_client", _DummyTtsClient)
    monkeypatch.setattr(main_module, "_load_motion_catalog", lambda: MotionCatalog((), None))
    monkeypatch.setattr(
        main_module,
        "settings",
        replace(main_module.settings, tts_enabled=True, audio_dir=tmp_path),
    )

    response = await main_module.stream_hermes_conversation(
        HermesConversationRequest(input="途中で止める"),
    )
    iterator = response.body_iterator
    while True:
        chunk = await iterator.__anext__()
        text = chunk.decode() if isinstance(chunk, bytes) else chunk
        if "event: speech.requested" in text:
            break

    await asyncio.wait_for(iterator.aclose(), timeout=1)

    await asyncio.wait_for(stream_cancelled.wait(), timeout=1)
    assert not audio_path.exists()
