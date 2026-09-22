"""speechタグの分割解析、表示保持、読み上げフォールバックを確認します。"""

from app.services.speech_tags import SpeechTagParser, fallback_speech_summary, strip_speech_tags


def test_speech_tag_splits_display_and_voice_across_chunks() -> None:
    """タグがSSEで分割されても、画面には全文、音声には概要だけを返します。"""
    parser = SpeechTagParser()
    display = ""
    speech = ""
    for chunk in ("[spe", "ech]冷房25度です。[/spe", "ech]\n\n- 室温: 27度"):
        parsed = parser.feed(chunk)
        display += parsed.display_text
        speech += parsed.speech_text
    remainder = parser.finish()

    assert display + remainder.display_text == "冷房25度です。\n\n- 室温: 27度"
    assert speech + remainder.speech_text == "冷房25度です。"
    assert parser.has_speech_tag is True


def test_plain_response_is_preserved_and_uses_first_paragraph_fallback() -> None:
    """旧形式の応答を消さず、詳細な箇条書きまでは読み上げないことを確認します。"""
    text = "エアコンは冷房25度で運転中です。\n\n- 電源: ON\n- 室温: 27度"
    parser = SpeechTagParser()
    parsed = parser.feed(text)
    remainder = parser.finish()

    assert parsed.display_text + remainder.display_text == text
    assert parsed.speech_text + remainder.speech_text == ""
    assert parser.has_speech_tag is False
    assert fallback_speech_summary(text) == "エアコンは冷房25度で運転中です。"


def test_multiple_speech_tags_are_all_read_in_order() -> None:
    """回答内に複数の演技ブロックがあっても、各speech本文を順番どおり読み上げます。"""
    parser = SpeechTagParser()
    parsed = parser.feed("[speech]嬉しい！[/speech] 間 [speech]照れるね。[/speech]")
    remainder = parser.finish()

    assert parsed.display_text + remainder.display_text == "嬉しい！ 間 照れるね。"
    assert parsed.speech_text + remainder.speech_text == "嬉しい！照れるね。"
    assert parser.has_speech_tag is True


def test_strip_speech_tags_keeps_summary_and_markdown_details() -> None:
    """履歴再読込でもspeech制御タグだけが画面に露出しないことを確認します。"""
    text = "[speech]運転中です。[/speech]\n\n- **電源**: ON"
    assert strip_speech_tags(text) == "運転中です。\n\n- **電源**: ON"


def test_strip_speech_tags_removes_all_tags_from_joined_agent_replies() -> None:
    """承認前後が一つの履歴へ連結されても、二組目のspeechタグを露出させません。"""
    text = "[speech]実行するね。[/speech]\n[speech]完了したよ。[/speech]"
    assert strip_speech_tags(text) == "実行するね。\n完了したよ。"
