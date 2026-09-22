"""Hermesの生成画像をAvatar Gateway管理下へ移し、期限付きでWeb公開します。"""

import hashlib
import json
import os
import re
import shutil
import time
from pathlib import Path
from typing import Any
from uuid import uuid4


_IMAGE_TOOL_NAMES = {"image_generate"}
_SUPPORTED_SUFFIXES = {".gif", ".jpeg", ".jpg", ".png", ".webp"}
_PUBLIC_FILENAME_PATTERN = re.compile(r"^[0-9a-f]{32}\.(?:gif|jpeg|jpg|png|webp)$")
_MARKDOWN_IMAGE_PATTERN = r"!\[[^\]]*\]\((?:{target}|<{target}>)\)"


class GeneratedImageStore:
    """Hermesキャッシュの画像だけを複製し、公開名と90日保持を管理します。"""

    def __init__(self, source_dir: Path, public_dir: Path, retention_days: int) -> None:
        self.source_dir = source_dir.expanduser()
        self.public_dir = public_dir
        self.retention_seconds = retention_days * 24 * 60 * 60

    def publish_from_messages(
        self,
        messages: list[dict[str, Any]],
        *,
        now: float | None = None,
    ) -> dict[str, str]:
        """画像生成ツールの正式履歴から、有効期限内の画像を一度だけ公開領域へ複製します。"""
        current_time = time.time() if now is None else now
        published: dict[str, str] = {}
        for source_text in self.generated_image_paths(messages):
            public_url = self._publish_one(source_text, current_time)
            if public_url is not None:
                published[source_text] = public_url
        return published

    def rewrite_markdown_images(self, text: str, published: dict[str, str]) -> str:
        """assistant本文のMarkdown画像だけを、Avatar Gatewayの配信URLへ置き換えます。"""
        rewritten = text
        for source_path, public_url in published.items():
            # 通常表記と、空白を含むURL向けの山括弧表記の両方を扱います。
            rewritten = rewritten.replace(f"]({source_path})", f"]({public_url})")
            rewritten = rewritten.replace(f"](<{source_path}>)", f"]({public_url})")
        return rewritten

    def present_assistant_images(self, text: str, published: dict[str, str]) -> str:
        """ツール結果を正本として画像を表示し、同じ画像のHermes配信指示は本文から除きます。"""
        rewritten = self.rewrite_markdown_images(text, published)
        image_markdown: list[str] = []
        for source_path, public_url in published.items():
            # MEDIAはSlack等の添付指示なので、ブラウザでは公開済み画像へ置き換えて生パスを隠します。
            rewritten = rewritten.replace(f"MEDIA:{source_path}", "")
            target_pattern = _MARKDOWN_IMAGE_PATTERN.format(target=re.escape(public_url))
            if re.search(target_pattern, rewritten) is None:
                image_markdown.append(f"![生成画像]({public_url})")

        # MEDIAだけの行を消した後も、本文と画像の間隔はMarkdownとして読みやすく保ちます。
        rewritten = re.sub(r"\n[ \t]*\n(?:[ \t]*\n)+", "\n\n", rewritten).strip()
        if not image_markdown:
            return rewritten
        images = "\n\n".join(image_markdown)
        return f"{rewritten}\n\n{images}" if rewritten else images

    def resolve_public_file(self, filename: str) -> Path | None:
        """公開用に発行したファイル名だけを、HTTP配信可能な実ファイルへ解決します。"""
        if not _PUBLIC_FILENAME_PATTERN.fullmatch(filename):
            return None
        path = self.public_dir / filename
        return path if path.is_file() else None

    def cleanup_expired(self, *, now: float | None = None) -> int:
        """作成時刻から保持期間を過ぎた管理画像を削除し、削除件数を返します。"""
        if not self.public_dir.is_dir():
            return 0
        cutoff = (time.time() if now is None else now) - self.retention_seconds
        removed = 0
        for path in self.public_dir.iterdir():
            if not path.is_file() or not _PUBLIC_FILENAME_PATTERN.fullmatch(path.name):
                continue
            try:
                if path.stat().st_mtime < cutoff:
                    path.unlink()
                    removed += 1
            except FileNotFoundError:
                # 会話処理と定期削除が重なった場合は、既に削除済みとして扱います。
                continue
        return removed

    @staticmethod
    def generated_image_paths(messages: list[dict[str, Any]]) -> list[str]:
        """他ツールの任意パスを拾わず、画像生成ツールが成功時に返したパスだけを抽出します。"""
        paths: list[str] = []
        for message in messages:
            if message.get("role") != "tool" or message.get("tool_name") not in _IMAGE_TOOL_NAMES:
                continue
            content = message.get("content")
            if not isinstance(content, str):
                continue
            try:
                payload = json.loads(content)
            except json.JSONDecodeError:
                continue
            if not isinstance(payload, dict):
                continue
            image = payload.get("image")
            if payload.get("success") is True and isinstance(image, str) and image:
                paths.append(image)
        return paths

    def _publish_one(self, source_text: str, now: float) -> str | None:
        """生成元配下と画像形式を確認し、安定した公開名で原子的にコピーします。"""
        try:
            source_root = self.source_dir.resolve(strict=True)
            source = Path(source_text).expanduser().resolve(strict=True)
            source.relative_to(source_root)
            source_stat = source.stat()
        except (FileNotFoundError, OSError, RuntimeError, ValueError):
            return None

        suffix = source.suffix.lower()
        if not source.is_file() or suffix not in _SUPPORTED_SUFFIXES:
            return None
        # 古いHermesキャッシュを履歴閲覧のたびに復活させず、生成時刻から90日を守ります。
        if source_stat.st_mtime < now - self.retention_seconds:
            return None

        digest = hashlib.sha256(str(source).encode("utf-8")).hexdigest()[:32]
        filename = f"{digest}{suffix}"
        destination = self.public_dir / filename
        self.public_dir.mkdir(parents=True, exist_ok=True)

        try:
            destination_stat = destination.stat()
        except FileNotFoundError:
            destination_stat = None
        if (
            destination_stat is None
            or destination_stat.st_size != source_stat.st_size
            or destination_stat.st_mtime_ns != source_stat.st_mtime_ns
        ):
            temporary = self.public_dir / f".{filename}.{uuid4().hex}.tmp"
            try:
                # 書きかけをブラウザへ返さないよう、一時名へコピーしてから同一FS内で置換します。
                shutil.copy2(source, temporary)
                os.replace(temporary, destination)
            finally:
                temporary.unlink(missing_ok=True)
        return f"/api/images/{filename}"
