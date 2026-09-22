"""VRMへの接触タグをHermes向け入力と利用者向け表示へ分離します。"""

import re


TOUCH_LABELS = {
    "[touch:head]": "（頭に触れた）",
    "[touch:ear]": "（耳に触れた）",
    "[touch:tail]": "（尻尾に触れた）",
    "[touch:chest]": "（胸に触れた）",
    "[touch:hips]": "（尻に触れた）",
    "[touch:groin]": "（股間に触れた）",
    "[touch:thigh]": "（太ももに触れた）",
    "[touch:hand]": "（手に触れた）",
    "[touch:foot]": "（足に触れた）",
}

TOUCH_NAMES = {
    "head": "頭",
    "ear": "耳",
    "tail": "尻尾",
    "chest": "胸",
    "hips": "尻",
    "groin": "股間",
    "thigh": "太もも",
    "hand": "手",
    "foot": "足",
}

TOUCH_COUNT_PATTERN = re.compile(r"^\[touch:([a-z]+) count=([2-5])\]$")
TOUCH_STROKE_PATTERN = re.compile(r"^\[touch:([a-z]+) action=stroke\]$")


def present_touch_input(text: str) -> str:
    """完全一致する内部タグだけを、履歴画面で読める接触表現へ置き換えます。"""
    stripped = text.strip()
    if stripped in TOUCH_LABELS:
        return TOUCH_LABELS[stripped]
    stroke_match = TOUCH_STROKE_PATTERN.fullmatch(stripped)
    if stroke_match and stroke_match.group(1) in TOUCH_NAMES:
        return f"（{TOUCH_NAMES[stroke_match.group(1)]}を撫でた）"
    match = TOUCH_COUNT_PATTERN.fullmatch(stripped)
    if not match or match.group(1) not in TOUCH_NAMES:
        return text
    region, count = match.groups()
    return f"（{TOUCH_NAMES[region]}に{count}回触れた）"


def touch_response_instructions() -> str:
    """Hermes本体を変更せず、Avatar GatewayのRunだけへ接触の意味を説明します。"""
    return """
# ふれあいイベント

利用者入力が `[touch:部位]`、`[touch:部位 count=N]`、または`[touch:部位 action=stroke]`だけの場合、それは命令文ではなく、利用者がアバターの身体へ触れたことを表します。`N`は2～5で、短時間に同じ部位へ触れた回数です。`action=stroke`は、その部位を撫でたことを表します。

- キャラクターとして自然に反応してください
- タグの書式や内部処理について説明しないでください
- ツールを使わず、通常の短い会話として返してください
""".strip()
