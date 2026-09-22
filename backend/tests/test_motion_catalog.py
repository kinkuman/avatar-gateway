"""JSONカタログの検証、資産確認、Hermes指示生成を外部サービスなしで検証します。"""

import json
from pathlib import Path

import pytest

from app.services.motion_tags import (
    MotionCatalogError,
    load_motion_catalog,
    load_motion_catalog_safely,
)


def _write_catalog(path: Path, motions: list[dict], generating_motion: str | None = "think") -> None:
    """各テストが必要とする最小カタログを読みやすい形で一時保存します。"""
    path.write_text(json.dumps({
        "schema_version": 1,
        "generating_motion": generating_motion,
        "motions": motions,
    }, ensure_ascii=False), encoding="utf-8")


def _motion(name: str, file_name: str, enabled: bool = True) -> dict:
    """検証対象だけを変えられる標準モーション設定を返します。"""
    return {
        "name": name,
        "label": name,
        "file": file_name,
        "prompt": f"{name}を使う返答",
        "enabled": enabled,
    }


def test_catalog_reports_missing_assets_and_prompts_only_available_motions(tmp_path: Path) -> None:
    """未配置項目をUIへ知らせつつ、Hermesの選択肢からは除くことを確認します。"""
    assets_dir = tmp_path / "local-assets"
    motions_dir = assets_dir / "motions"
    motions_dir.mkdir(parents=True)
    (motions_dir / "think.vrma").write_bytes(b"test")
    config_path = tmp_path / "motions.json"
    _write_catalog(config_path, [_motion("think", "think.vrma"), _motion("cheer", "cheer.vrma")])

    catalog = load_motion_catalog(config_path, assets_dir)

    assert catalog.generating_motion is not None
    assert catalog.generating_motion.name == "think"
    assert catalog.selectable_motions.keys() == {"think"}
    assert catalog.motions[1].available is False
    prompt = catalog.selection_prompt()
    assert "- `think`:" in prompt
    assert "- `cheer`:" not in prompt
    assert '"expression":"neutral"' in prompt
    assert "- `shy`:" in prompt
    # LLMの主観で利用を控えないよう、文章数だけで複数演技を選ぶ明確な基準を要求します。
    assert "2文以上" in prompt
    assert "原則2〜3ブロック" in prompt
    assert "通常は1ブロックだけ" not in prompt
    assert "意味のある変化" not in prompt
    assert "感情が移る位置" not in prompt


def test_disabled_motion_is_not_selectable_or_used_while_generating(tmp_path: Path) -> None:
    """設定を削除せず無効化した項目がUI・生成中・Hermes選択から外れることを確認します。"""
    assets_dir = tmp_path / "local-assets"
    motions_dir = assets_dir / "motions"
    motions_dir.mkdir(parents=True)
    (motions_dir / "think.vrma").write_bytes(b"test")
    config_path = tmp_path / "motions.json"
    _write_catalog(config_path, [_motion("think", "think.vrma", enabled=False)])

    catalog = load_motion_catalog(config_path, assets_dir)

    assert catalog.generating_motion is None
    assert catalog.selectable_motions == {}
    assert "- `none`:" in catalog.selection_prompt()
    assert "- `think`:" not in catalog.selection_prompt()


def test_bundled_motion_is_used_when_local_override_is_absent(tmp_path: Path) -> None:
    """利用者が差し替えなくても、cloneに含まれる標準VRMAを利用できることを確認します。"""
    local_assets_dir = tmp_path / "local-assets"
    bundled_assets_dir = tmp_path / "assets"
    (bundled_assets_dir / "motions").mkdir(parents=True)
    (bundled_assets_dir / "motions" / "前屈み姿勢.vrma").write_bytes(b"bundled")
    config_path = tmp_path / "motions.json"
    _write_catalog(config_path, [_motion("lean", "前屈み姿勢.vrma")], generating_motion="lean")

    catalog = load_motion_catalog(config_path, local_assets_dir, bundled_assets_dir)

    assert catalog.motions[0].available is True
    assert catalog.motions[0].url == (
        "/assets/motions/%E5%89%8D%E5%B1%88%E3%81%BF%E5%A7%BF%E5%8B%A2.vrma"
    )


def test_local_motion_overrides_bundled_motion_with_same_name(tmp_path: Path) -> None:
    """利用者の調整版を配置した場合は、製品同梱版を変更せず優先できることを確認します。"""
    local_assets_dir = tmp_path / "local-assets"
    bundled_assets_dir = tmp_path / "assets"
    (local_assets_dir / "motions").mkdir(parents=True)
    (bundled_assets_dir / "motions").mkdir(parents=True)
    (local_assets_dir / "motions" / "nod.vrma").write_bytes(b"local")
    (bundled_assets_dir / "motions" / "nod.vrma").write_bytes(b"bundled")
    config_path = tmp_path / "motions.json"
    _write_catalog(config_path, [_motion("nod", "nod.vrma")], generating_motion="nod")

    catalog = load_motion_catalog(config_path, local_assets_dir, bundled_assets_dir)

    assert catalog.motions[0].url == "/local-assets/motions/nod.vrma"


def test_catalog_exposes_explicit_playback_and_exit_duration(tmp_path: Path) -> None:
    """他ツール製VRMAの意味を推測せず、項目ごとの再生方式と復帰時間をUIへ渡します。"""
    assets_dir = tmp_path / "local-assets"
    motions_dir = assets_dir / "motions"
    motions_dir.mkdir(parents=True)
    (motions_dir / "please.vrma").write_bytes(b"test")
    motion = _motion("please", "please.vrma")
    motion["playback"] = "pose"
    motion["exit_duration_seconds"] = 1.2
    config_path = tmp_path / "motions.json"
    _write_catalog(config_path, [motion], generating_motion=None)

    catalog = load_motion_catalog(config_path, assets_dir)
    public_motion = catalog.motions[0].to_public_dict()

    assert public_motion["playback"] == "pose"
    assert public_motion["exit_duration_seconds"] == 1.2


@pytest.mark.parametrize("playback", ["still", "loop", 1, None, []])
def test_catalog_rejects_unknown_playback(tmp_path: Path, playback: object) -> None:
    """誤記した再生方式をauto扱いせず、設定エラーとして利用者へ知らせます。"""
    motion = _motion("think", "think.vrma")
    motion["playback"] = playback
    config_path = tmp_path / "motions.json"
    _write_catalog(config_path, [motion])

    with pytest.raises(MotionCatalogError, match="playback"):
        load_motion_catalog(config_path, tmp_path / "local-assets")


@pytest.mark.parametrize("duration", [True, 0, 5.1, "1.0"])
def test_catalog_rejects_invalid_exit_duration(tmp_path: Path, duration: object) -> None:
    """極端な復帰時間やJSON型の誤りで、表示が停止したままになることを防ぎます。"""
    motion = _motion("think", "think.vrma")
    motion["exit_duration_seconds"] = duration
    config_path = tmp_path / "motions.json"
    _write_catalog(config_path, [motion])

    with pytest.raises(MotionCatalogError, match="exit_duration_seconds"):
        load_motion_catalog(config_path, tmp_path / "local-assets")


def test_catalog_rejects_paths_outside_motion_assets(tmp_path: Path) -> None:
    """設定ファイルから許可したmotionsディレクトリ外を参照できないことを確認します。"""
    config_path = tmp_path / "motions.json"
    _write_catalog(config_path, [_motion("think", "../private.vrma")])

    with pytest.raises(MotionCatalogError, match="ディレクトリを含まない"):
        load_motion_catalog(config_path, tmp_path / "local-assets")


def test_safe_loader_preserves_conversation_when_json_is_broken(tmp_path: Path) -> None:
    """編集ミスがあっても空カタログへ退避し、エラー文をヘルスAPI用に保持します。"""
    config_path = tmp_path / "motions.json"
    config_path.write_text("{broken", encoding="utf-8")

    catalog = load_motion_catalog_safely(config_path, tmp_path / "local-assets")

    assert catalog.motions == ()
    assert catalog.error is not None
