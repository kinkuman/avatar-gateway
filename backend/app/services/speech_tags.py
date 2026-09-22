"""Hermes応答から、画面へ出す全文と短い読み上げ部分をストリームのまま分離します。"""

from dataclasses import dataclass
import re


_OPEN_TAG = "[speech]"
_CLOSE_TAG = "[/speech]"
_DISPLAY_TAG_PATTERN = re.compile(r"\[/?speech\]", re.IGNORECASE)


@dataclass(frozen=True)
class ParsedSpeechChunk:
    """タグを除いた表示差分と、読み上げ対象として確定した差分を返します。"""

    display_text: str
    speech_text: str


class SpeechTagParser:
    """SSEの分割位置に依存せず、複数speechタグの内外を二つの本文へ分けます。"""

    def __init__(self) -> None:
        self._buffer = ""
        self._inside_speech = False
        self._saw_speech_tag = False

    @property
    def has_speech_tag(self) -> bool:
        """明示タグが一度でも開始されたかを、フォールバック判定用に返します。"""
        return self._saw_speech_tag

    def feed(self, delta: str) -> ParsedSpeechChunk:
        """生成差分を追加し、タグ候補でないと確定した文字だけを即時に返します。"""
        self._buffer += delta
        display_parts: list[str] = []
        speech_parts: list[str] = []

        while self._buffer:
            target = _CLOSE_TAG if self._inside_speech else _OPEN_TAG
            lowered = self._buffer.lower()
            tag_index = lowered.find(target)
            if tag_index >= 0:
                text = self._buffer[:tag_index]
                display_parts.append(text)
                if self._inside_speech:
                    speech_parts.append(text)
                self._buffer = self._buffer[tag_index + len(target):]
                if self._inside_speech:
                    self._inside_speech = False
                else:
                    self._inside_speech = True
                    self._saw_speech_tag = True
                continue

            # 末尾がタグの途中かもしれない場合だけ保留し、それ以前は表示へ即時解放します。
            retained = self._partial_tag_suffix_length(lowered, target)
            release_length = len(self._buffer) - retained
            if release_length <= 0:
                break
            text = self._buffer[:release_length]
            display_parts.append(text)
            if self._inside_speech:
                speech_parts.append(text)
            self._buffer = self._buffer[release_length:]

        return ParsedSpeechChunk("".join(display_parts), "".join(speech_parts))

    def finish(self) -> ParsedSpeechChunk:
        """未完のタグ文字列も本文として保持し、開始済みspeechの内容は読み上げ対象にします。"""
        text = self._buffer
        self._buffer = ""
        return ParsedSpeechChunk(text, text if self._inside_speech else "")

    @staticmethod
    def _partial_tag_suffix_length(text: str, target: str) -> int:
        """次のSSE差分で完成し得るタグ接頭辞だけを末尾に残します。"""
        maximum = min(len(text), len(target) - 1)
        for length in range(maximum, 0, -1):
            if target.startswith(text[-length:]):
                return length
        return 0


def strip_speech_tags(text: str) -> str:
    """複数発話が連結された正式履歴から、全speech制御タグだけを除きます。"""
    return _DISPLAY_TAG_PATTERN.sub("", text)


def fallback_speech_summary(text: str) -> str:
    """タグに非対応の応答でも全文を読まず、最初の空でない段落だけを読み上げます。"""
    normalized = text.replace("\r\n", "\n").strip()
    for paragraph in normalized.split("\n\n"):
        summary = paragraph.strip()
        if summary:
            return summary
    return ""
