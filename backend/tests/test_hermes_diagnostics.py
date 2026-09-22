"""Hermesの運用診断だけが日本語表示へ変換されることを確認します。"""

import pytest

from app.services.hermes_diagnostics import EMPTY_RESPONSE_NOTICE, hermes_diagnostic_notice


@pytest.mark.parametrize("diagnostic", [
    "(empty)",
    "⚠️ No reply: the model returned empty content after retries and any fallback providers. Try `continue`.",
    "⚠️ No reply: all API retries were exhausted before a response was produced (provider errors).",
    "⚠️ No reply: streaming stopped early and only a partial response was recovered.",
])
def test_known_hermes_failures_become_japanese_notice(diagnostic: str) -> None:
    """実在する空応答と再試行失敗の表現を、同じ非発話表示へ統一します。"""
    assert hermes_diagnostic_notice(diagnostic) == EMPTY_RESPONSE_NOTICE


def test_normal_assistant_text_is_not_treated_as_diagnostic() -> None:
    """通常の英語回答や診断文の説明まで抑止しません。"""
    assert hermes_diagnostic_notice("No reply yet, but I am still checking.") is None
    assert hermes_diagnostic_notice("これは (empty) の説明です。") is None
