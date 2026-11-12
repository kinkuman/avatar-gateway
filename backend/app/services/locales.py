"""同梱と利用者追加の翻訳を統合し、UIへ公開する言語一覧を作ります。"""

import json
import logging
import re
from pathlib import Path

logger = logging.getLogger(__name__)
LANGUAGE_PATTERN = r"^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$"


def list_locales(bundled: Path, local: Path) -> list[dict]:
    """壊れた追加ファイルで画面全体を止めず、同名言語はローカルの項目を優先します。"""
    languages: dict[str, dict] = {}
    for directory in (bundled, local):
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob("*.json")):
            if (path.is_symlink() or not path.is_file() or len(path.stem) > 64
                    or not re.fullmatch(LANGUAGE_PATTERN, path.stem)):
                continue
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(raw, dict):
                    raise ValueError("language resource must be an object")
                metadata = raw.get("_meta", {})
                name = metadata.get("name") if isinstance(metadata, dict) else None
                messages = {
                    key: value for key, value in raw.items()
                    if key != "_meta" and isinstance(value, str) and value.strip()
                    and re.fullmatch(r"[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+", key)
                }
                if not messages:
                    raise ValueError("language resource has no UI messages")
                current = languages.setdefault(path.stem, {
                    "code": path.stem, "name": path.stem, "messages": {},
                })
                if isinstance(name, str) and name.strip():
                    current["name"] = name.strip()
                current["messages"].update(messages)
            except (OSError, UnicodeError, ValueError) as exc:
                logger.warning("Skipping invalid locale %s: %s", path, exc)
    return [languages[code] for code in sorted(languages)]
