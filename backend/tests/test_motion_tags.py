"""構造化アバター制御がSSE分割に左右されず安全に分離されることを検証します。"""

from dataclasses import replace

import pytest

from app import main as main_module
from app.models import HermesConversationRequest
from app.services.motion_tags import (
    AvatarDirectiveParser,
    MotionCatalog,
    MotionDefinition,
    strip_avatar_directives,
    strip_motion_tags,
)


TEST_MOTIONS = {
    "think": MotionDefinition("think", "考える", "think.vrma", "分析する返答", True, True),
    "cheer": MotionDefinition("cheer", "喜ぶ", "cheer.vrma", "喜びの返答", True, True),
}
TEST_CATALOG = MotionCatalog(tuple(TEST_MOTIONS.values()), "think")


def _parse_stream(*chunks: str) -> tuple[str, str | None, str | None]:
    """テスト用の分割応答を実際のストリームと同じ順序で解析します。"""
    parser = AvatarDirectiveParser(TEST_MOTIONS)
    text = ""
    selected: str | None = None
    expression: str | None = None
    for chunk in chunks:
        for parsed in parser.feed(chunk):
            text += parsed.text
            if parsed.motion:
                selected = parsed.motion.name
            if parsed.expression is not None:
                expression = parsed.expression
    text += "".join(part.text for part in parser.finish())
    return text, selected, expression


def test_recognized_directive_is_hidden_across_chunks() -> None:
    """JSONが細かく分割されても表示・読み上げ本文へ混入しないことを確認します。"""
    text, selected, expression = _parse_stream(
        '\n[ava', 'tar]{"v":1,"motion":"che', 'er","expression":"happy"}[/avatar]\n', "成功しました。",
    )
    assert text == "成功しました。"
    assert selected == "cheer"
    assert expression == "happy"


def test_unknown_motion_is_removed_without_selecting_asset() -> None:
    """未登録名から任意パスを作らず、本文だけを継続できることを確認します。"""
    text, selected, expression = _parse_stream(
        '[avatar]{"v":1,"motion":"wave","expression":"relaxed"}[/avatar] こんにちは',
    )
    assert text == "こんにちは"
    assert selected is None
    assert expression == "relaxed"


def test_none_motion_keeps_avatar_in_default_motion() -> None:
    """通常応答用タグは本文から除き、VRMAを選択しないことを確認します。"""
    text, selected, expression = _parse_stream(
        '[avatar]{"v":1,"motion":"none","expression":"neutral"}[/avatar]\n通常の返答です。',
    )
    assert text == "通常の返答です。"
    assert selected is None
    assert expression == "neutral"


def test_shy_expression_is_selected_without_motion() -> None:
    """赤面用のshy表情を本文から分離し、発話単位の制御として保持します。"""
    text, selected, expression = _parse_stream(
        '[avatar]{"v":1,"motion":"none","expression":"shy"}[/avatar] 少し照れるね。',
    )
    assert text == "少し照れるね。"
    assert selected is None
    assert expression == "shy"


def test_multiple_avatar_directives_are_returned_in_order_across_chunks() -> None:
    """回答途中の表情切替も、分割位置に左右されず本文から順番どおり分離します。"""
    parser = AvatarDirectiveParser(TEST_MOTIONS)
    parts = []
    for chunk in (
        '[avatar]{"v":1,"motion":"cheer","expression":"happy"}[/avatar][speech]嬉しい！[/speech][ava',
        'tar]{"v":1,"motion":"none","expression":"shy"}[/avatar][speech]照れるね。[/speech]',
    ):
        parts.extend(parser.feed(chunk))
    parts.extend(parser.finish())

    controls = [(part.motion.name if part.motion else None, part.expression) for part in parts if part.expression]
    assert controls == [("cheer", "happy"), (None, "shy")]
    assert "".join(part.text for part in parts) == "[speech]嬉しい！[/speech][speech]照れるね。[/speech]"


def test_directive_is_hidden_when_long_text_arrives_in_one_chunk() -> None:
    """タグと長い本文が同じ差分でも、長さ制限より先にタグを解析します。"""
    response = "長い返答です。" * 30
    text, selected, expression = _parse_stream(
        f'[avatar]{{"v":1,"motion":"think","expression":"surprised"}}[/avatar]{response}',
    )
    assert text == response
    assert selected == "think"
    assert expression == "surprised"


def test_plain_or_incomplete_prefix_is_not_lost() -> None:
    """予約語でない角括弧は保持し、未完の制御情報は本文へ漏らさないことを確認します。"""
    plain_text, plain_selected, plain_expression = _parse_stream("[注意] ", "本文です。")
    incomplete_text, incomplete_selected, incomplete_expression = _parse_stream('[avatar]{"v":1')
    assert plain_text == "[注意] 本文です。"
    assert plain_selected is None
    assert plain_expression is None
    assert incomplete_text == ""
    assert incomplete_selected is None
    assert incomplete_expression is None


def test_invalid_json_falls_back_to_neutral_without_leaking_control() -> None:
    """余分な項目や未知表情を含むJSONは実行せず、neutralとして本文だけを返します。"""
    text, selected, expression = _parse_stream(
        '[avatar]{"v":1,"motion":"cheer","expression":"smile","weight":1}[/avatar]本文',
    )
    assert text == "本文"
    assert selected is None
    assert expression == "neutral"


def test_oversized_unclosed_directive_discards_later_chunks() -> None:
    """長さ上限を超えた未完制御は、後続断片も含めて表示や読み上げへ漏らしません。"""
    text, selected, expression = _parse_stream("[avatar]" + "x" * 600, "still-control-data")
    assert text == ""
    assert selected is None
    assert expression == "neutral"


def test_display_strips_avatar_directives_and_legacy_motion_tags() -> None:
    """新しい制御JSONと既存セッションの旧タグを、どちらも履歴表示から除きます。"""
    text = (
        '[avatar]{"v":1,"motion":"think","expression":"relaxed"}[/avatar] 実行するね。\n'
        "[motion:none] 完了したよ。"
    )
    assert strip_motion_tags(strip_avatar_directives(text)) == "実行するね。\n完了したよ。"


def test_legacy_motion_response_is_hidden_during_session_migration() -> None:
    """旧履歴を模倣した応答でもタグを表示せず、表情だけneutralへ安全に戻します。"""
    text, selected, expression = _parse_stream("[mo", "tion:think] 旧形式の応答")
    assert text == "旧形式の応答"
    assert selected == "think"
    assert expression == "neutral"


@pytest.mark.asyncio
async def test_conversation_sends_only_clean_text_to_browser_and_tts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """会話API全体でもタグを通知へ分離し、読み上げ本文へ残さないことを確認します。"""
    synthesized: list[str] = []

    async def fake_stream_agent_run(_request, _motion_prompt):
        """モーション・音声・Markdown詳細が同居するHermes応答を再現します。"""
        output = (
            '[avatar]{"v":1,"motion":"cheer","expression":"happy"}[/avatar]\n'
            "[speech]うまくいきました！[/speech]\n\n- **状態**: 成功"
        )
        for delta in (
            '[avatar]{"v":1,"mot', 'ion":"cheer","expression":"happy"}[/avatar]\n[spe',
            "ech]うまくいきました！[/speech]", "\n\n- **状態**: 成功",
        ):
            yield "assistant.delta", {"delta": delta}
        yield "assistant.completed", {"output": output}

    async def fake_synthesize(text, _settings, _client):
        """外部TTSを呼ばず、渡された本文だけを検査可能にします。"""
        synthesized.append(text)
        return "test-utterance", main_module.settings.audio_dir / "test-utterance.wav"

    monkeypatch.setattr(main_module, "_stream_agent_run", fake_stream_agent_run)
    monkeypatch.setattr(main_module, "synthesize", fake_synthesize)
    monkeypatch.setattr(main_module, "_load_motion_catalog", lambda: TEST_CATALOG)
    monkeypatch.setattr(main_module, "settings", replace(main_module.settings, tts_enabled=True))

    response = await main_module.stream_hermes_conversation(
        HermesConversationRequest(input="結果は？"),
    )
    chunks: list[str] = []
    async for chunk in response.body_iterator:
        chunks.append(chunk.decode() if isinstance(chunk, bytes) else chunk)
    body = "".join(chunks)

    assert "event: avatar.selected" in body
    assert '"expression": "happy"' in body
    assert '"name": "cheer"' in body
    assert '"expression": "happy"' in body
    assert "[avatar]" not in body
    assert "[motion:" not in body
    assert "[speech]" not in body
    assert "**状態**" in body
    assert synthesized == ["うまくいきました！"]
