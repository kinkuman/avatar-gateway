"""文単位TTSが句読点、SSE分割、短文、長文を自然な順序で扱うことを検証します。"""

from app.services.speech_chunks import SentenceChunker


def test_first_sentence_is_released_before_stream_finishes() -> None:
    """次文の先頭が届いた時点で、最初の完成文を先行合成へ渡します。"""
    chunker = SentenceChunker()
    assert chunker.feed("最初の説明ができました。") == []
    assert chunker.feed("次の") == ["最初の説明ができました。"]
    assert chunker.finish() == ["次の"]


def test_sentence_keeps_closing_marks_across_sse_chunks() -> None:
    """句点と閉じ括弧が別差分でも、閉じ括弧を次文へ取り残しません。"""
    chunker = SentenceChunker()
    assert chunker.feed("彼女は『完了しました！") == []
    assert chunker.feed("』続きです") == ["彼女は『完了しました！』"]
    assert chunker.finish() == ["続きです"]


def test_short_sentences_are_combined_until_minimum_length() -> None:
    """極端に短い相づちは次文とまとめ、TTS呼び出し回数を増やしすぎません。"""
    chunker = SentenceChunker(min_chars=8)
    assert chunker.feed("はい。次へ。続けます。本文") == ["はい。次へ。続けます。"]
    assert chunker.finish() == ["本文"]


def test_decimal_and_url_periods_do_not_split_sentence() -> None:
    """小数とURL内のピリオドを英語文末として誤認しないことを確認します。"""
    chunker = SentenceChunker()
    text = "値は1.25です。URLはexample.com/pathです。次"
    assert chunker.feed(text) == ["値は1.25です。", "URLはexample.com/pathです。"]
    assert chunker.finish() == ["次"]


def test_long_text_uses_separator_and_final_fragment_is_flushed() -> None:
    """句点のない長文を上限以下へ分け、最後の断片も失わず返します。"""
    chunker = SentenceChunker(min_chars=5, max_chars=20)
    chunks = chunker.feed("これは句点のない長い文章なので、途中の読点を使って安全に分割します")
    chunks.extend(chunker.finish())
    assert "".join(chunks) == "これは句点のない長い文章なので、途中の読点を使って安全に分割します"
    assert all(len(chunk) <= 20 for chunk in chunks)


def test_symbol_only_fragment_is_not_synthesized() -> None:
    """改行や記号だけの応答断片で空のTTSリクエストを作りません。"""
    chunker = SentenceChunker()
    chunker.feed("……。\n")
    assert chunker.finish() == []
