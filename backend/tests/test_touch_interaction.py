"""ふれあいタグの表示変換とHermes向け契約を、会話本文から独立して確認します。"""

import pytest

from app.services.touch_interaction import present_touch_input, touch_response_instructions


@pytest.mark.parametrize(("tag", "label"), [
    ("[touch:head]", "（頭に触れた）"),
    ("[touch:ear]", "（耳に触れた）"),
    ("[touch:tail]", "（尻尾に触れた）"),
    ("[touch:chest]", "（胸に触れた）"),
    ("[touch:hips]", "（尻に触れた）"),
    ("[touch:groin]", "（股間に触れた）"),
    ("[touch:thigh]", "（太ももに触れた）"),
    ("[touch:hand]", "（手に触れた）"),
    ("[touch:foot]", "（足に触れた）"),
])
def test_exact_touch_tags_are_presented_as_actions(tag: str, label: str) -> None:
    """標準部位と任意追加部位の内部タグを、履歴用の接触表現へ変換します。"""
    assert present_touch_input(tag) == label


def test_touch_tag_presentation_does_not_rewrite_normal_text() -> None:
    """完全一致する内部タグ以外は、利用者が書いた文章として保ちます。"""
    assert present_touch_input(" [touch:hand] \n") == "（手に触れた）"
    assert present_touch_input("これは [touch:head] の説明") == "これは [touch:head] の説明"
    assert present_touch_input("[touch:unknown]") == "[touch:unknown]"


@pytest.mark.parametrize(("tag", "label"), [
    ("[touch:head count=2]", "（頭に2回触れた）"),
    ("[touch:tail count=5]", "（尻尾に5回触れた）"),
    ("[touch:hand count=3]", "（手に3回触れた）"),
])
def test_repeated_touch_tags_show_tap_count(tag: str, label: str) -> None:
    """連続タップを再読込しても、回数付きの自然な履歴表示を維持します。"""
    assert present_touch_input(tag) == label


@pytest.mark.parametrize(("tag", "label"), [
    ("[touch:head action=stroke]", "（頭を撫でた）"),
    ("[touch:ear action=stroke]", "（耳を撫でた）"),
    ("[touch:tail action=stroke]", "（尻尾を撫でた）"),
])
def test_stroke_touch_tags_are_presented_as_actions(tag: str, label: str) -> None:
    """ドラッグ接触を内部表現のまま見せず、撫でた動作として表示します。"""
    assert present_touch_input(tag) == label


@pytest.mark.parametrize("text", [
    "[touch:head count=1]",
    "[touch:head count=6]",
    "[touch:unknown count=3]",
    "[touch:unknown action=stroke]",
    "[touch:head action=drag]",
    "説明 [touch:head count=3]",
])
def test_invalid_repeated_touch_tags_are_not_rewritten(text: str) -> None:
    """許可外の部位や回数を接触イベントとして誤認しません。"""
    assert present_touch_input(text) == text


def test_touch_instructions_define_event_without_tools() -> None:
    """Hermesが接触を命令やツール要求として扱わないための要点を固定します。"""
    instructions = touch_response_instructions()
    assert "命令文ではなく" in instructions
    assert "ツールを使わず" in instructions
    assert "[touch:部位]" in instructions
    assert "[touch:部位 count=N]" in instructions
    assert "[touch:部位 action=stroke]" in instructions
    assert "2～5" in instructions
