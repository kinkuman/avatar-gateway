"""視線発話が、指定したcronジョブの新しい応答だけを一回の反応として積むことを確認します。"""

import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.services.gaze_speech import GazeBeat, GazePerformance, GazeSpeechStore, extract_gaze_performance


def _write_jobs(cron_dir: Path, jobs: list[dict]) -> None:
    """テスト用のHermes cron台帳を、実装が読む場所へ置きます。"""
    cron_dir.mkdir(parents=True, exist_ok=True)
    (cron_dir / "jobs.json").write_text(json.dumps(jobs), encoding="utf-8")


def _write_output(cron_dir: Path, job_id: str, name: str, text: str) -> None:
    """一件のcron出力を、ジョブIDの直下へ書きます。"""
    directory = cron_dir / "output" / job_id
    directory.mkdir(parents=True, exist_ok=True)
    (directory / name).write_text(text, encoding="utf-8")


def _store(tmp_path: Path, job_name: str = "avatar-gateway-gaze") -> GazeSpeechStore:
    """一時ディレクトリ上のcronと状態ファイルを使うストアを作ります。"""
    return GazeSpeechStore(tmp_path / "cron", tmp_path / "gaze_speech.json", job_name)


def _performance(*beats: GazeBeat) -> GazePerformance:
    """テストで期待する反応を短く組み立てます。"""
    return GazePerformance(beats)


def test_extract_gaze_performance_keeps_response_beats_only() -> None:
    """指示文の見本や無言指定を読み上げず、応答の演技だけを残します。"""
    logged = (
        "## Prompt\n"
        "[speech]ここに日本語の一文[/speech]\n"
        "## Response\n"
        '[avatar]{"v":1,"motion":"wave","expression":"happy"}[/avatar]\n'
        "[speech] 予定が一つ残ってる。 [/speech]\n"
        '[avatar]{"v":1,"motion":"lean_forward","expression":"relaxed"}[/avatar]\n'
        "[speech]先に片づける？[/speech]\n"
    )
    assert extract_gaze_performance(logged) == _performance(
        GazeBeat("予定が一つ残ってる。", "wave", "happy"),
        GazeBeat("先に片づける？", "lean_forward", "relaxed"),
    )
    assert extract_gaze_performance("## Response\n[gaze:silent]") is None
    assert extract_gaze_performance("タグのないメモ") is None
    assert extract_gaze_performance("[speech][gaze:silent][/speech]") is None
    assert extract_gaze_performance("[speech]ここに日本語の一文[/speech]") is None


def test_extract_gaze_performance_keeps_speech_when_close_tags_are_missing() -> None:
    """閉じタグを省いたcron応答でも、応答側の一文と演技を残します。"""
    logged = (
        "## Prompt\n"
        "[speech]ここに日本語の一文[/speech]\n"
        "## Response\n"
        '[avatar] {"v": 1, "motion": "hands_behind_back", "expression": "relaxed"}\n'
        "[speech] 午後の光が少し強くなって、机の角が白く浮かんでいる。\n"
    )
    assert extract_gaze_performance(logged) == _performance(
        GazeBeat("午後の光が少し強くなって、机の角が白く浮かんでいる。", "hands_behind_back", "relaxed"),
    )


def test_extract_limits_a_performance_to_three_beats() -> None:
    """一度に読み上げるのは先頭の三文までにします。"""
    text = "".join(f"[speech]{index}番です。[/speech]" for index in range(1, 6))
    performance = extract_gaze_performance(text)
    assert performance is not None
    assert [beat.text for beat in performance.beats] == ["1番です。", "2番です。", "3番です。"]


def test_startup_ignores_outputs_already_on_disk(tmp_path: Path) -> None:
    """起動前からある出力は話さず、その後に増えた反応だけを積むことを確認します。"""
    cron_dir = tmp_path / "cron"
    _write_jobs(cron_dir, [{"id": "abc123def456", "name": "avatar-gateway-gaze"}])
    _write_output(cron_dir, "abc123def456", "2026-10-07_09-00-00.md", "[speech]古い用件です。[/speech]")
    store = _store(tmp_path)

    assert store.scan() == 0
    assert store.claim() is None

    _write_output(cron_dir, "abc123def456", "2026-10-07_10-00-00.md", "[speech]新しい用件です。[/speech]")
    assert store.scan() == 1
    assert store.claim() == _performance(GazeBeat("新しい用件です。"))
    assert store.claim() is None


def test_prompt_example_and_other_jobs_do_not_enter_the_queue(tmp_path: Path) -> None:
    """無言の結果、指示内の見本、別の名前のジョブ出力は待ち行列へ入れません。"""
    cron_dir = tmp_path / "cron"
    _write_jobs(cron_dir, [
        {"id": "abc123def456", "name": "avatar-gateway-gaze"},
        {"id": "fff000aaa111", "name": "daily-news"},
    ])
    store = _store(tmp_path)
    assert store.scan() == 0

    _write_output(
        cron_dir,
        "abc123def456",
        "2026-10-07_11-00-00.md",
        "## Prompt\n[speech]ここに日本語の一文[/speech]\n## Response\n[gaze:silent]\n",
    )
    _write_output(cron_dir, "fff000aaa111", "2026-10-07_11-00-00.md", "[speech]別のジョブです。[/speech]")
    assert store.scan() == 0
    assert store.status()["pending"] == 0
    assert store.status()["job_found"] is True


def test_wrapped_jobs_json_groups_beats_into_one_performance(tmp_path: Path) -> None:
    """同じ出力の複数文は、カメラを見た一回で続けて話す反応にまとめます。"""
    cron_dir = tmp_path / "cron"
    cron_dir.mkdir()
    (cron_dir / "jobs.json").write_text(json.dumps({
        "jobs": [{"id": "abc123def456", "name": "avatar-gateway-gaze"}],
    }), encoding="utf-8")
    store = _store(tmp_path)
    store.scan()
    _write_output(
        cron_dir,
        "abc123def456",
        "2026-10-07_12-00-00_123456.md",
        '[avatar]{"v":1,"motion":"nod","expression":"happy"}[/avatar]\n'
        "[speech]最初です。[/speech]\n"
        '[avatar]{"v":1,"motion":"none","expression":"shy"}[/avatar]\n'
        "[speech]次です。[/speech]",
    )

    assert store.scan() == 1
    assert store.claim() == _performance(
        GazeBeat("最初です。", "nod", "happy"),
        GazeBeat("次です。", None, "shy"),
    )


def test_unsafe_job_id_is_not_read(tmp_path: Path) -> None:
    """ジョブIDにディレクトリ脱出が含まれていても、cron出力の外は読みません。"""
    cron_dir = tmp_path / "cron"
    _write_jobs(cron_dir, [{"id": "../secret", "name": "avatar-gateway-gaze"}])
    outside = tmp_path / "secret"
    outside.mkdir()
    (outside / "note.md").write_text("[speech]読んではいけない文です。[/speech]", encoding="utf-8")
    store = _store(tmp_path)

    assert store.scan() == 0
    assert store.claim() is None
    assert store.status()["job_found"] is False


def test_queue_survives_restart_and_returns_failed_synthesis(tmp_path: Path) -> None:
    """再起動後も未読の反応を保ち、合成失敗時は先頭へ戻すことを確認します。"""
    cron_dir = tmp_path / "cron"
    _write_jobs(cron_dir, [{"id": "abc123def456", "name": "avatar-gateway-gaze"}])
    store = _store(tmp_path)
    store.scan()
    _write_output(cron_dir, "abc123def456", "2026-10-07_13-00-00.md", "[speech]まだ話していません。[/speech]")
    store.scan()

    restored = _store(tmp_path)
    performance = restored.claim()
    assert performance == _performance(GazeBeat("まだ話していません。"))
    assert performance is not None
    restored.put_back(performance)
    assert restored.claim() == performance


def test_legacy_placeholder_queue_is_dropped(tmp_path: Path) -> None:
    """以前の見本文が待ち行列に残っていても、再読み込みで捨てます。"""
    state = tmp_path / "gaze_speech.json"
    state.write_text(json.dumps({
        "seeded": True,
        "seen": [],
        "queue": ["ここに日本語の一文"],
    }, ensure_ascii=False), encoding="utf-8")
    store = GazeSpeechStore(tmp_path / "cron", state, "avatar-gateway-gaze")

    assert store.claim() is None


@pytest.mark.asyncio
async def test_claim_endpoint_synthesizes_each_beat_without_a_conversation(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """視線発話APIが会話Runを作らず、ブロックごとの音声と演技を返すことを確認します。"""
    from dataclasses import replace

    from app import main as main_module
    from app.services.motion_tags import MotionCatalog, MotionDefinition

    cron_dir = tmp_path / "cron"
    _write_jobs(cron_dir, [{"id": "abc123def456", "name": "avatar-gateway-gaze"}])
    store = GazeSpeechStore(cron_dir, tmp_path / "state.json", "avatar-gateway-gaze")
    store.scan()
    _write_output(
        cron_dir,
        "abc123def456",
        "2026-10-07_14-00-00.md",
        '[avatar]{"v":1,"motion":"wave","expression":"happy"}[/avatar][speech]視線の用件です。[/speech]',
    )
    monkeypatch.setattr(main_module, "gaze_store", store)
    monkeypatch.setattr(main_module, "settings", replace(main_module.settings, tts_enabled=True))
    wave = MotionDefinition(
        name="wave",
        label="手を振る",
        file_name="wave.vrma",
        prompt="挨拶",
        enabled=True,
        available=True,
    )
    monkeypatch.setattr(main_module, "_load_motion_catalog", lambda: MotionCatalog((wave,), None))
    synthesized: list[str] = []

    async def fake_synthesize(text: str, _config, _client=None):
        """外部TTSの代わりに、渡された文と仮の音声IDを返します。"""
        synthesized.append(text)
        return "a" * 32, tmp_path / "voice.wav"

    monkeypatch.setattr(main_module, "synthesize", fake_synthesize)

    payload = await main_module.claim_gaze_speech()

    assert synthesized == ["視線の用件です。"]
    assert payload["spoken"] is True
    assert payload["text"] == "視線の用件です。"
    assert payload["beats"][0]["expression"] == "happy"
    assert payload["beats"][0]["motion"]["name"] == "wave"
    assert payload["audio_url"] == "/api/audio/" + ("a" * 32) + ".wav"
    assert store.claim() is None


@pytest.mark.asyncio
async def test_claim_endpoint_rejects_disabled_tts(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """音声合成が無効なときは反応を消費せず、話せない理由を返します。"""
    from dataclasses import replace

    from app import main as main_module

    cron_dir = tmp_path / "cron"
    _write_jobs(cron_dir, [{"id": "abc123def456", "name": "avatar-gateway-gaze"}])
    store = GazeSpeechStore(cron_dir, tmp_path / "state.json", "avatar-gateway-gaze")
    store.scan()
    _write_output(cron_dir, "abc123def456", "2026-10-07_15-00-00.md", "[speech]残しておく文です。[/speech]")
    monkeypatch.setattr(main_module, "gaze_store", store)
    monkeypatch.setattr(main_module, "settings", replace(main_module.settings, tts_enabled=False))

    with pytest.raises(HTTPException) as caught:
        await main_module.claim_gaze_speech()

    assert caught.value.status_code == 409
    assert store.claim() == _performance(GazeBeat("残しておく文です。"))


@pytest.mark.asyncio
async def test_claim_endpoint_splits_a_long_beat_at_the_tts_chunk_limit(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """音声上限を超える視線の一文を、会話と同じ文字数へ切ってから合成します。"""
    from dataclasses import replace

    from app import main as main_module
    from app.services.motion_tags import MotionCatalog, MotionDefinition

    short_text = "短い確認です。"
    long_text = "朝の机には、" + ("あ" * 80) + "、" + ("い" * 70) + "。"
    cron_dir = tmp_path / "cron"
    _write_jobs(cron_dir, [{"id": "abc123def456", "name": "avatar-gateway-gaze"}])
    store = GazeSpeechStore(cron_dir, tmp_path / "state.json", "avatar-gateway-gaze")
    store.scan()
    _write_output(
        cron_dir,
        "abc123def456",
        "2026-10-10_09-40-00.md",
        (
            '[avatar]{"v":1,"motion":"nod","expression":"relaxed"}[/avatar]'
            f"[speech]{short_text}[/speech]"
            '[avatar]{"v":1,"motion":"wave","expression":"happy"}[/avatar]'
            f"[speech]{long_text}[/speech]"
        ),
    )
    monkeypatch.setattr(main_module, "gaze_store", store)
    monkeypatch.setattr(
        main_module,
        "settings",
        replace(
            main_module.settings,
            tts_enabled=True,
            tts_chunk_min_chars=6,
            tts_chunk_max_chars=100,
        ),
    )
    nod = MotionDefinition(
        name="nod",
        label="うなずく",
        file_name="nod.vrma",
        prompt="同意",
        enabled=True,
        available=True,
    )
    wave = MotionDefinition(
        name="wave",
        label="手を振る",
        file_name="wave.vrma",
        prompt="挨拶",
        enabled=True,
        available=True,
    )
    monkeypatch.setattr(
        main_module,
        "_load_motion_catalog",
        lambda: MotionCatalog((nod, wave), None),
    )
    synthesized: list[str] = []

    async def fake_synthesize(text: str, _config, _client=None):
        """外部TTSの代わりに、渡された文と仮の音声IDを返します。"""
        synthesized.append(text)
        utterance_id = f"{len(synthesized):032d}"[-32:]
        return utterance_id, tmp_path / f"{utterance_id}.wav"

    monkeypatch.setattr(main_module, "synthesize", fake_synthesize)

    payload = await main_module.claim_gaze_speech()

    first_chunk = "朝の机には、" + ("あ" * 80) + "、"
    second_chunk = ("い" * 70) + "。"
    assert synthesized == [short_text, first_chunk, second_chunk]
    assert all(len(text) <= 100 for text in synthesized)
    assert [beat["text"] for beat in payload["beats"]] == synthesized
    assert [beat["expression"] for beat in payload["beats"]] == ["relaxed", "happy", "happy"]
    assert [beat["motion"]["name"] for beat in payload["beats"]] == ["nod", "wave", "wave"]
    assert store.claim() is None


@pytest.mark.asyncio
async def test_claim_endpoint_returns_the_original_performance_when_a_chunk_fails(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """分割後の途中で合成に失敗しても、切る前の反応全体を先頭へ戻します。"""
    from dataclasses import replace

    from app import main as main_module
    from app.services.stylebertvits2 import TtsError

    long_text = "朝の机には、" + ("あ" * 80) + "、" + ("い" * 70) + "。"
    cron_dir = tmp_path / "cron"
    _write_jobs(cron_dir, [{"id": "abc123def456", "name": "avatar-gateway-gaze"}])
    store = GazeSpeechStore(cron_dir, tmp_path / "state.json", "avatar-gateway-gaze")
    store.scan()
    _write_output(
        cron_dir,
        "abc123def456",
        "2026-10-10_09-41-00.md",
        f"[speech]{long_text}[/speech]",
    )
    monkeypatch.setattr(main_module, "gaze_store", store)
    monkeypatch.setattr(
        main_module,
        "settings",
        replace(main_module.settings, tts_enabled=True, tts_chunk_min_chars=6, tts_chunk_max_chars=100),
    )
    created: list[Path] = []

    async def fake_synthesize(text: str, _config, _client=None):
        """最初の断片だけ音声ファイルを作り、次の断片で合成失敗にします。"""
        if created:
            raise TtsError("string_too_long")
        path = tmp_path / "partial.wav"
        path.write_bytes(b"wav")
        created.append(path)
        return "b" * 32, path

    monkeypatch.setattr(main_module, "synthesize", fake_synthesize)

    with pytest.raises(HTTPException) as caught:
        await main_module.claim_gaze_speech()

    assert caught.value.status_code == 502
    assert created[0].exists() is False
    assert store.claim() == _performance(GazeBeat(long_text))
