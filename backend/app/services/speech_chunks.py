"""LLMの逐次テキストを、自然さと初動速度を両立する読み上げ単位へ分割します。"""

_STRONG_TERMINATORS = frozenset("。！？!?")
_CLOSING_MARKS = frozenset("」』）】〉》〕］｝”’\"'")
_LONG_TEXT_SEPARATORS = frozenset("、，,；;：:\n \t")
_SILENT_MARKS = " \t\r\n。、，,.！？!?；;：:・…―-()（）[]［］{}｛｝「」『』【】\"'”’"


class SentenceChunker:
    """SSE境界をまたぐ句読点を保持し、TTSへ渡せる文を順番に返します。"""

    def __init__(self, min_chars: int = 6, max_chars: int = 100) -> None:
        if min_chars < 1 or max_chars < min_chars:
            raise ValueError("文分割文字数は 1 <= min_chars <= max_chars にしてください")
        self._min_chars = min_chars
        self._max_chars = max_chars
        self._buffer = ""

    def feed(self, delta: str) -> list[str]:
        """生成差分を追加し、文末が確定した読み上げ単位だけを返します。"""
        self._buffer += delta
        return self._extract(final=False)

    def finish(self) -> list[str]:
        """句点がない最後の断片も、ストリーム終了時に一度だけ返します。"""
        chunks = self._extract(final=True)
        remainder = self._clean(self._buffer)
        self._buffer = ""
        if remainder:
            chunks.append(remainder)
        return chunks

    def _extract(self, final: bool) -> list[str]:
        """短文の結合と長文の上限分割を繰り返し、確定済みチャンクを抜き出します。"""
        chunks: list[str] = []
        while self._buffer:
            boundary = self._find_sentence_boundary(final)
            if boundary is None and len(self._buffer) >= self._max_chars:
                boundary = self._find_long_text_boundary()
            if boundary is None:
                break

            chunk = self._clean(self._buffer[:boundary])
            self._buffer = self._buffer[boundary:]
            if chunk:
                chunks.append(chunk)
        return chunks

    def _find_sentence_boundary(self, final: bool) -> int | None:
        """小数点を避けつつ、文末記号・閉じ括弧・改行を同じ文へ含めます。"""
        index = 0
        while index < len(self._buffer):
            character = self._buffer[index]
            end: int | None = None

            if character in _STRONG_TERMINATORS:
                end = index + 1
                while end < len(self._buffer) and self._buffer[end] in _STRONG_TERMINATORS:
                    end += 1
                while end < len(self._buffer) and self._buffer[end] in _CLOSING_MARKS:
                    end += 1
                # 次の差分に閉じ括弧が続く可能性があるため、末尾の句点だけは一度保留します。
                if end == len(self._buffer) and not final:
                    return None
            elif character == "." and self._is_ascii_period_boundary(index, final):
                end = index + 1
                while end < len(self._buffer) and self._buffer[end] in _CLOSING_MARKS:
                    end += 1
                if end == len(self._buffer) and not final:
                    return None
            elif character == "\n":
                end = index + 1

            if end is not None and len(self._buffer[:end].strip()) >= self._min_chars:
                return end
            index = end if end is not None else index + 1
        return None

    def _is_ascii_period_boundary(self, index: int, final: bool) -> bool:
        """数値・URL内のピリオドを避け、空白または終端へ続くピリオドだけを文末にします。"""
        previous = self._buffer[index - 1] if index > 0 else ""
        following = self._buffer[index + 1] if index + 1 < len(self._buffer) else ""
        if previous.isdigit() and following.isdigit():
            return False
        if following:
            return following.isspace() or following in _CLOSING_MARKS
        return final

    def _find_long_text_boundary(self) -> int:
        """句点のない長文は、上限直前の読点や空白を優先して分割します。"""
        search_start = min(self._min_chars, self._max_chars - 1)
        candidate = self._buffer[:self._max_chars]
        for index in range(len(candidate) - 1, search_start - 1, -1):
            if candidate[index] in _LONG_TEXT_SEPARATORS:
                return index + 1
        return self._max_chars

    @staticmethod
    def _clean(text: str) -> str:
        """空白・記号だけの断片をTTSへ送らず、通常本文は前後だけ整えます。"""
        cleaned = text.strip()
        return cleaned if cleaned.strip(_SILENT_MARKS) else ""
