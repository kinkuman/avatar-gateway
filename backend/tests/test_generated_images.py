"""生成画像のコピー、Markdown変換、HTTP公開境界、90日削除を検証します。"""

import os
from pathlib import Path

import pytest
from fastapi import HTTPException

from app import main as main_module
from app.services.generated_images import GeneratedImageStore
from app.services.motion_tags import MotionCatalog


_DAY_SECONDS = 24 * 60 * 60


def _image_messages(source: Path) -> list[dict]:
    """Hermes SessionDBに保存される画像生成ツールと最終回答を最小構成で再現します。"""
    return [
        {
            "role": "tool",
            "tool_name": "image_generate",
            "content": f'{{"success": true, "image": "{source}"}}',
        },
        {
            "role": "assistant",
            "content": f"![生成画像]({source})\n\nできたよ！",
        },
    ]


def _media_image_messages(source: Path) -> list[dict]:
    """Hermes Run APIで未変換のMEDIA指示が保存された履歴を再現します。"""
    return [
        {
            "role": "tool",
            "tool_name": "image_generate",
            "content": f'{{"success": true, "image": "{source}"}}',
        },
        {
            "role": "assistant",
            "content": f"できたよ！\nMEDIA:{source}\n見てみてね。",
        },
    ]


def test_publish_rewrites_once_and_removes_after_90_days(tmp_path: Path) -> None:
    """同じ履歴を再読込しても複製を増やさず、生成時刻から90日後に削除します。"""
    now = 1_800_000_000.0
    source_dir = tmp_path / "hermes-images"
    public_dir = tmp_path / "gateway-images"
    source_dir.mkdir()
    source = source_dir / "cat.png"
    source.write_bytes(b"generated-image")
    os.utime(source, (now - 60, now - 60))
    store = GeneratedImageStore(source_dir, public_dir, retention_days=90)
    messages = _image_messages(source)

    first = store.publish_from_messages(messages, now=now)
    second = store.publish_from_messages(messages, now=now + 10)

    assert first == second
    assert len(list(public_dir.glob("*.png"))) == 1
    public_url = first[str(source)]
    assert public_url.startswith("/api/images/")
    assert store.rewrite_markdown_images(messages[1]["content"], first) == (
        f"![生成画像]({public_url})\n\nできたよ！"
    )
    assert store.cleanup_expired(now=now + 90 * _DAY_SECONDS - 61) == 0
    assert store.cleanup_expired(now=now + 90 * _DAY_SECONDS) == 1
    assert not list(public_dir.glob("*.png"))


def test_publish_ignores_expired_or_outside_images(tmp_path: Path) -> None:
    """履歴閲覧で期限切れ画像を復活させず、Hermesキャッシュ外のパスも複製しません。"""
    now = 1_800_000_000.0
    source_dir = tmp_path / "hermes-images"
    source_dir.mkdir()
    expired = source_dir / "expired.png"
    expired.write_bytes(b"old")
    os.utime(expired, (now - 90 * _DAY_SECONDS - 1, now - 90 * _DAY_SECONDS - 1))
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"outside")
    store = GeneratedImageStore(source_dir, tmp_path / "public", retention_days=90)

    assert store.publish_from_messages(_image_messages(expired), now=now) == {}
    assert store.publish_from_messages(_image_messages(outside), now=now) == {}


@pytest.mark.asyncio
async def test_session_presentation_copies_and_serves_generated_image(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """会話と履歴が同じコピーを参照し、公開名以外をHTTP配信しないことを確認します。"""
    source_dir = tmp_path / "hermes-images"
    source_dir.mkdir()
    source = source_dir / "cat.png"
    source.write_bytes(b"png")
    public_dir = tmp_path / "gateway-images"
    store = GeneratedImageStore(source_dir, public_dir, retention_days=90)
    monkeypatch.setattr(main_module, "generated_image_store", store)

    presented = await main_module._prepare_session_messages(
        _image_messages(source),
        MotionCatalog((), None),
    )

    assistant_content = presented[-1]["content"]
    assert str(source) not in assistant_content
    public_url = assistant_content.split("(", 1)[1].split(")", 1)[0]
    filename = public_url.rsplit("/", 1)[1]
    response = await main_module.generated_image(filename)
    assert Path(response.path) == public_dir / filename

    with pytest.raises(HTTPException) as captured:
        await main_module.generated_image("../cat.png")
    assert captured.value.status_code == 404


@pytest.mark.asyncio
async def test_session_presentation_renders_tool_image_without_markdown(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """最終回答がMEDIA形式でも、生パスを隠して正式な画像ツール結果を画面へ追加します。"""
    source_dir = tmp_path / "hermes-images"
    source_dir.mkdir()
    source = source_dir / "ivy.png"
    source.write_bytes(b"png")
    store = GeneratedImageStore(source_dir, tmp_path / "gateway-images", retention_days=90)
    monkeypatch.setattr(main_module, "generated_image_store", store)

    presented = await main_module._prepare_session_messages(
        _media_image_messages(source),
        MotionCatalog((), None),
    )

    assistant_content = presented[-1]["content"]
    assert "できたよ！\n\n見てみてね。" in assistant_content
    assert "MEDIA:" not in assistant_content
    assert str(source) not in assistant_content
    assert assistant_content.count("![生成画像](/api/images/") == 1


@pytest.mark.asyncio
async def test_session_presentation_does_not_duplicate_existing_markdown_image(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Hermesが既にMarkdown画像を返した場合は、URL置換だけを行って画像を重複させません。"""
    source_dir = tmp_path / "hermes-images"
    source_dir.mkdir()
    source = source_dir / "ivy.png"
    source.write_bytes(b"png")
    store = GeneratedImageStore(source_dir, tmp_path / "gateway-images", retention_days=90)
    monkeypatch.setattr(main_module, "generated_image_store", store)

    presented = await main_module._prepare_session_messages(
        _image_messages(source),
        MotionCatalog((), None),
    )

    assistant_content = presented[-1]["content"]
    assert str(source) not in assistant_content
    assert assistant_content.count("![生成画像](/api/images/") == 1


@pytest.mark.asyncio
async def test_session_presentation_does_not_carry_image_into_next_user_turn(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """画像生成後に回答が欠けた場合も、次ターンのassistant回答へ古い画像を付けません。"""
    source_dir = tmp_path / "hermes-images"
    source_dir.mkdir()
    source = source_dir / "interrupted.png"
    source.write_bytes(b"png")
    store = GeneratedImageStore(source_dir, tmp_path / "gateway-images", retention_days=90)
    monkeypatch.setattr(main_module, "generated_image_store", store)
    messages = _media_image_messages(source)[:1] + [
        {"role": "user", "content": "別の質問"},
        {"role": "assistant", "content": "別の回答"},
    ]

    presented = await main_module._prepare_session_messages(messages, MotionCatalog((), None))

    assert presented[-1]["content"] == "別の回答"
