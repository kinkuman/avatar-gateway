"""会話開始時の現実時刻と保存済み履歴から、Hermesへ渡す日周期の情報を作ります。"""

from dataclasses import dataclass
from datetime import date, datetime
from typing import Literal
from zoneinfo import ZoneInfo

from .hermes import HermesSessionMessage


@dataclass(frozen=True)
class DailyState:
    """各Runの暦日・時間帯・直前のユーザー発言日時を保持します。"""

    date: date
    phase: Literal["morning", "daytime", "evening", "night"]
    lastInteractionAt: datetime | None


def build_daily_instructions(
    messages: tuple[HermesSessionMessage, ...],
    timezone: ZoneInfo,
    now: datetime | None = None,
) -> str:
    """時計を一度だけ読み、同じセッションの前回日時と矛盾しない時間指示を作ります。"""
    current = datetime.now(timezone) if now is None else now.astimezone(timezone)
    if 5 <= current.hour < 12:
        phase = "morning"
    elif 12 <= current.hour < 18:
        phase = "daytime"
    elif 18 <= current.hour < 23:
        phase = "evening"
    else:
        phase = "night"

    previous = None
    previous_label = "なし（初回の会話）"
    # 回答やツールの実行時刻を、利用者が話しかけた時刻として扱わないためです。
    for message in reversed(messages):
        if message.data.get("role") != "user":
            continue
        previous_label = "不明"
        timestamp = message.data.get("timestamp")
        if isinstance(timestamp, (int, float)) and not isinstance(timestamp, bool):
            try:
                previous = datetime.fromtimestamp(timestamp, timezone)
                previous_label = previous.strftime("%Y-%m-%d %H:%M")
            except (ValueError, OverflowError, OSError):
                pass
        # 最新発言の日時が欠損していても、古い発言を「前回」として代用しません。
        break

    state = DailyState(current.date(), phase, previous)
    return (
        "[このRun開始時点の時間情報]\n"
        f"現在日時: {state.date.isoformat()} {current:%H:%M}\n"
        f"タイムゾーン: {timezone.key}\n"
        f"現在の時間帯: {state.phase}\n"
        f"前回会話日時: {previous_label}\n\n"
        "現在日時と時間帯を認識して会話すること。\n"
        "現在の時間帯と矛盾する挨拶や発言をしないこと。\n"
        "現在の時間帯には、アプリが指定した値を使うこと。\n"
        "過去の会話に登場する日時を現在日時として扱わないこと。"
    )
