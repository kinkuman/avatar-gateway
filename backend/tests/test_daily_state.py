"""日周期の境界と、保存済み会話から復元する前回日時の扱いを確認します。"""

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import pytest

from app.services.daily_state import build_daily_input, build_daily_instructions, present_daily_input
from app.services.hermes import HermesSessionMessage


TOKYO = ZoneInfo("Asia/Tokyo")


@pytest.mark.parametrize("user_input", ["こんばんは", "\n空白も保持\n", "[avatar_touch]ふれあい", "[/avatar_gateway_time]"])
def test_time_context_is_retained_only_in_raw_history(user_input: str) -> None:
    """日時は再送用の履歴に残し、表示用変換では元の本文を一文字も変えません。"""
    raw = build_daily_input(user_input, (), TOKYO)
    message = HermesSessionMessage.from_response({"role": "user", "content": raw})
    assert message.data["content"] == raw
    assert message.to_public_dict()["content"] == user_input
    assert present_daily_input(user_input) == user_input
    assert "現在日時:" in raw


def test_display_preserves_legacy_and_incomplete_time_blocks() -> None:
    """既存履歴や未完の区切りを含む発言を、誤って切り捨てないことを確認します。"""
    for content in ("以前の発言", "[avatar_gateway_time]\n未完の発言"):
        assert present_daily_input(content) == content
    raw = build_daily_input("こんばんは", (), TOKYO)
    assert HermesSessionMessage({"role": "assistant", "content": raw}).to_public_dict()["content"] == raw


@pytest.mark.parametrize(("clock", "phase"), [
    ("00:00", "night"), ("04:59", "night"), ("05:00", "morning"),
    ("11:59", "morning"), ("12:00", "daytime"), ("17:59", "daytime"),
    ("18:00", "evening"), ("21:00", "evening"), ("22:59", "evening"),
    ("23:00", "night"), ("23:59", "night"),
])
def test_phase_boundaries(clock: str, phase: str) -> None:
    """挨拶が変わる境界の直前・直後を、ホストの時刻に依存せず検証します。"""
    now = datetime.fromisoformat(f"2026-09-07T{clock}:00+09:00")
    result = build_daily_instructions((), TOKYO, now)
    assert f"現在日時: 2026-09-07 {clock}" in result
    assert f"現在の時間帯: {phase}" in result
    assert "前回会話日時: なし（初回の会話）" in result


def test_history_restores_previous_user_time_across_midnight() -> None:
    """日付変更やプロセス再起動後も、回答時刻ではなく履歴のユーザー日時を使います。"""
    previous = datetime(2026, 9, 7, 23, 58, tzinfo=TOKYO)
    messages = (
        HermesSessionMessage({"role": "user", "timestamp": previous.timestamp()}),
        HermesSessionMessage({"role": "assistant", "timestamp": previous.timestamp() + 60}),
        HermesSessionMessage({"role": "tool", "timestamp": previous.timestamp() + 90}),
    )
    now = datetime(2026, 9, 7, 15, 1, tzinfo=timezone.utc)
    result = build_daily_instructions(messages, TOKYO, now)
    assert "現在日時: 2026-09-08 00:01" in result
    assert "現在の時間帯: night" in result
    assert "前回会話日時: 2026-09-07 23:58" in result
    assert "タイムゾーン: Asia/Tokyo" in result
    assert "現在日時: 2026-09-07 15:01" in build_daily_instructions(messages, ZoneInfo("UTC"), now)


@pytest.mark.parametrize("timestamp", [None, True, "bad", float("nan"), float("inf"), 1e100])
def test_missing_timestamp_does_not_fall_back_to_older_user(timestamp: object) -> None:
    """不正な最新日時を古い発言やアシスタント日時で補って誤認させないことを確認します。"""
    messages = (
        HermesSessionMessage({"role": "user", "timestamp": 100}),
        HermesSessionMessage({"role": "user", "timestamp": timestamp}),
    )
    assert "前回会話日時: 不明" in build_daily_instructions(messages, TOKYO)
