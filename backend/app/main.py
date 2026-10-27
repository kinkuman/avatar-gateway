"""会話・音声・VRM・Web UIを同一オリジンで提供するFastAPIアプリです。"""

import asyncio
import base64
import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import NoReturn
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .config import PROJECT_ROOT, settings
from .models import (
    HermesConversationRequest,
    HermesModelSelectRequest,
    HermesRunApprovalRequest,
    HermesRunCreateRequest,
    HermesSessionCreateRequest,
    SpeechEvent,
)
from .services.hermes import (
    HermesClient,
    HermesConflictError,
    HermesError,
    HermesSessionNotFoundError,
)
from .services.hermes_runs import HermesRunCoordinator
from .services.model_selection import (
    ModelSelectionError,
    ModelSelectionStore,
    SelectedHermesModel,
    public_model_catalog,
    selection_is_listed,
)
from .services.generated_images import GeneratedImageStore
from .services.hermes_diagnostics import hermes_diagnostic_notice
from .services.speech_backends import (
    OPENAI_PROVIDER,
    NoSpeechDetectedError,
    SpeechStreamUnsupported,
    TranscriptionError,
    TranscriptionUnavailableError,
    TtsError,
    create_transcriber,
    create_tts_client,
    iter_speech_pcm,
    synthesize,
    transcription_status,
)
from .services.access_control import (
    authenticate_basic_header,
    gateway_authentication_enabled,
    is_same_origin_request,
)
from .services.motion_tags import (
    AvatarDirectiveParser,
    MotionCatalog,
    MotionDefinition,
    ParsedAvatarChunk,
    load_motion_catalog_safely,
    strip_avatar_directives,
    strip_motion_tags,
)
from .services.speech_chunks import SentenceChunker
from .services.speech_tags import (
    ParsedSpeechChunk,
    SpeechTagParser,
    fallback_speech_summary,
    strip_speech_tags,
)
from .services.gaze_speech import GazeSpeechStore
from .services.touch_interaction import present_touch_input, touch_response_instructions
from .services.ui_settings import UiSettings, UiSettingsError, UiSettingsStore, list_backgrounds


logger = logging.getLogger("avatar_gateway")
# Uvicornの既定INFOハンドラーを使い、起動ターミナルで生の応答を確認できるようにします。
assistant_output_logger = logging.getLogger("uvicorn.error.avatar_gateway")
generated_image_store = GeneratedImageStore(
    settings.hermes_image_cache_dir,
    settings.image_dir,
    settings.image_retention_days,
)


async def _gaze_speech_scan_loop() -> None:
    """Hermes cronのlocal出力を定期的に確認し、新しい視線発話だけを積んでおきます。"""
    while True:
        try:
            await asyncio.to_thread(gaze_store.scan)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("gaze speech scan failed")
        await asyncio.sleep(5)


async def _generated_image_cleanup_loop() -> None:
    """起動直後と6時間ごとに、90日を過ぎた生成画像を運用処理から回収します。"""
    while True:
        try:
            removed = generated_image_store.cleanup_expired()
            if removed:
                logger.info("generated image cleanup removed %s expired file(s)", removed)
        except asyncio.CancelledError:
            raise
        except Exception:
            # 一時的な削除失敗で会話サーバーを停止せず、次回の定期処理で再試行します。
            logger.exception("generated image cleanup failed")
        await asyncio.sleep(6 * 60 * 60)


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    """画像削除ワーカーをアプリの起動期間だけ所有し、終了時に確実に停止します。"""
    cleanup_task = asyncio.create_task(
        _generated_image_cleanup_loop(),
        name="generated-image-cleanup",
    )
    gaze_task = asyncio.create_task(_gaze_speech_scan_loop(), name="gaze-speech-scan")
    try:
        yield
    finally:
        cleanup_task.cancel()
        gaze_task.cancel()
        await asyncio.gather(cleanup_task, gaze_task, return_exceptions=True)


app = FastAPI(title="Avatar Gateway", version="0.1.0", lifespan=_lifespan)
if settings.gateway_lan_mode:
    # LAN公開時はHostヘッダー攻撃を避け、利用者が明示した名前・IPだけを受け付けます。
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(settings.gateway_allowed_hosts))
_PRODUCER_DONE = object()
run_coordinator = HermesRunCoordinator(lambda: HermesClient(settings), settings.daily_timezone)
gaze_store = GazeSpeechStore(
    settings.hermes_cron_dir,
    settings.gaze_state_file,
    settings.gaze_cron_job_name,
)
# 読み上げ停止でHermesのRunを巻き込まず、対象のTTSワーカーだけを中断するため保持します。
speech_sequence_workers: dict[str, asyncio.Task[None]] = {}
transcriber = create_transcriber(settings)

_SUPPORTED_AUDIO_TYPES = frozenset({
    "audio/mp4",
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
    "audio/webm",
    "audio/x-m4a",
})


@app.middleware("http")
async def protect_gateway(request: Request, call_next):
    """認証設定時は静的画面を含む全経路へBasic認証とOrigin検証を適用します。"""
    if not gateway_authentication_enabled(settings):
        return await call_next(request)
    if not authenticate_basic_header(request.headers.get("Authorization"), settings):
        return JSONResponse(
            {"detail": "Avatar Gatewayの認証が必要です"},
            status_code=401,
            headers={"WWW-Authenticate": 'Basic realm="Avatar Gateway", charset="UTF-8"'},
        )
    if request.method not in {"GET", "HEAD", "OPTIONS"} and not is_same_origin_request(
        request.headers.get("Origin"),
        request.headers.get("Host"),
    ):
        return JSONResponse({"detail": "異なるオリジンからの操作は許可されていません"}, status_code=403)
    return await call_next(request)


def _sse(event: str, data: dict) -> str:
    """改行を含む本文も壊れないJSON形式のSSEイベントを作ります。"""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _model_selection_store() -> ModelSelectionStore:
    """テストが差し替えた設定ファイルも、いまの選択として読みます。"""
    return ModelSelectionStore(settings.hermes_model_file)


def _effective_hermes_model() -> str:
    """画面の選択があればそれを、なければ起動時のモデル名を返します。"""
    try:
        selected = _model_selection_store().load()
    except ModelSelectionError:
        logger.warning("saved Hermes model selection is unreadable")
        return settings.hermes_model
    return selected.model if selected else settings.hermes_model


def _load_motion_catalog() -> MotionCatalog:
    """設定不備を記録しつつ、APIを停止させない実行時カタログを返します。"""
    catalog = load_motion_catalog_safely(
        settings.motion_catalog_file,
        settings.local_assets_dir,
        settings.bundled_assets_dir,
    )
    if catalog.error:
        logger.warning("motion catalog unavailable: %s", catalog.error)
    return catalog


def _ui_settings_store() -> UiSettingsStore:
    """テスト時のSettings差し替えも反映できるよう、現在の設定パスから保存器を作ります。"""
    return UiSettingsStore(settings.ui_settings_file)


def _approval_prompt_text(request: HermesConversationRequest) -> str:
    """今回の会話で送られた文を優先し、未指定のときだけサーバー既定値を使います。"""
    if request.approval_prompt is not None:
        return request.approval_prompt
    try:
        return _ui_settings_store().load().approval_prompt
    except UiSettingsError:
        return "承認をお願いします"


def _resolve_vrm_asset() -> tuple[Path | None, str | None]:
    """利用者の差し替えを優先し、なければ同梱サンプルVRMを同一オリジンで返します。"""
    local_path = settings.local_assets_dir / "vrm" / settings.vrm_file
    if local_path.is_file():
        return local_path, f"/local-assets/vrm/{settings.vrm_file}"
    bundled_path = settings.bundled_assets_dir / "vrm" / settings.vrm_file
    if bundled_path.is_file():
        return bundled_path, f"/assets/vrm/{settings.vrm_file}"
    return None, None


def _present_assistant_text(text: str, _motion_catalog: MotionCatalog) -> str:
    """連結された複数発話の制御情報を、Hermesには保存したまま表示から除きます。"""
    diagnostic_notice = hermes_diagnostic_notice(text)
    if diagnostic_notice:
        return diagnostic_notice
    return strip_speech_tags(strip_motion_tags(strip_avatar_directives(text)))


def _log_raw_assistant_output(output: str) -> None:
    """speechやmotionタグを除去する前のHermes応答だけを、確認しやすい境界付きで記録します。"""
    assistant_output_logger.info(
        "Hermes raw assistant output BEGIN\n%s\nHermes raw assistant output END",
        output,
    )


def _agent_response_instructions(motion_catalog: MotionCatalog) -> str:
    """通常会話は豊かに読み、実ツール結果だけを短く伝える発話契約をHermesへ渡します。"""
    # 条件ごとの境界を明確にし、通常会話をツール結果の短文規則と混同させないためMarkdownで渡します。
    speech_instructions = """
# 読み上げ規則

利用者に読み上げる文章は、必ず `[speech]` と `[/speech]` で囲んでください。

## 通常会話

ツールを使わない場合は、回答内の会話文を最初から最後まですべて `[speech]...[/speech]` に入れてください。

- avatarタグが1個だけなら、speechタグも回答全体で一組だけにする
- 回答途中でavatarタグを追加する場合は、現在のspeechタグを閉じてから次のavatarタグと新しいspeechタグを置く
- 各avatarタグには、直後のspeechタグを必ず一組だけ対応させる

- 演技を切り替えないのに最初の一文だけで `[/speech]` を閉じない
- `[speech]` の外に会話の続きを残さない
- 回答を短い一言へ省略しない

## ツール実行前

自然な返事だけを `[speech]` に入れてください。

次の内容は読み上げず、タグの外へ書いてください。

- ユーザー命令の復唱
- コマンド
- ファイルパス
- 実行内容の詳細

## ツール実行後

結果の短い結論だけを `[speech]` に入れてください。

ツール出力、根拠、数値、コード、パスなどの詳細は、タグの外へ書いてください。
""".strip()
    motion_instructions = motion_catalog.selection_prompt()
    interaction_instructions = touch_response_instructions()
    if motion_instructions:
        return f"{motion_instructions}\n\n{interaction_instructions}\n\n{speech_instructions}"
    return f"{interaction_instructions}\n\n{speech_instructions}"


def _present_session_messages(
    messages: list[dict],
    motion_catalog: MotionCatalog,
    published_images: dict[str, str] | None = None,
) -> list[dict]:
    """Hermesの正式履歴から、画面表示できる本文と制御タグ除去済み内容だけを返します。"""
    presented: list[dict] = []
    pending_images: dict[str, str] = {}
    for message in messages:
        item = dict(message)
        if item.get("role") == "tool":
            # 画像は生成ツールの直後に確定するassistant回答へだけ紐付け、別ターンへ漏らしません。
            for source_path in generated_image_store.generated_image_paths([item]):
                public_url = (published_images or {}).get(source_path)
                if public_url is not None:
                    pending_images[source_path] = public_url
        if item.get("role") == "assistant" and isinstance(item.get("content"), str):
            # 本文なしのassistant記録はツール呼び出しを保持する内部項目なので、会話欄へ混ぜません。
            if not item["content"].strip():
                continue
            content = _present_assistant_text(item["content"], motion_catalog)
            item["content"] = generated_image_store.present_assistant_images(
                content,
                pending_images,
            )
            pending_images = {}
        elif item.get("role") == "user" and isinstance(item.get("content"), str):
            # 中断等で画像後の回答が欠けても、次のユーザーターンへ画像を持ち越しません。
            pending_images = {}
            item["content"] = present_touch_input(item["content"])
        presented.append(item)
    return presented


async def _prepare_session_messages(
    messages: list[dict],
    motion_catalog: MotionCatalog,
) -> list[dict]:
    """正式履歴の生成画像をコピーしてから、ブラウザ向け本文へ一貫して変換します。"""
    published_images = generated_image_store.publish_from_messages(messages)
    return _present_session_messages(messages, motion_catalog, published_images)


async def _hermes_health() -> dict:
    """秘密情報を出さず、Hermes専用機能を利用できる状態か確認します。"""
    if not settings.hermes_api_key:
        return {
            "status": "misconfigured",
            "message": "HERMES_API_KEYが設定されていません",
            "capabilities": None,
        }

    try:
        capabilities = await HermesClient(settings).get_capabilities()
    except HermesError as exc:
        # HermesClientが安全な利用者向け文言へ変換済みのため、応答本文や秘密情報は含まれません。
        logger.warning("Hermes capabilities unavailable: %s", exc)
        return {
            "status": "unavailable",
            "message": str(exc),
            "capabilities": None,
        }

    missing = capabilities.missing_required_features
    return {
        "status": "incompatible" if missing else "ready",
        "message": "必要なHermes機能が不足しています" if missing else None,
        "capabilities": capabilities.to_public_dict(),
    }


def _raise_hermes_api_error(exc: HermesError) -> NoReturn:
    """安全化済みHermes例外を、利用者が対処できるHTTP状態へ変換します。"""
    if isinstance(exc, HermesSessionNotFoundError):
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if isinstance(exc, HermesConflictError):
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/health")
async def health() -> dict:
    """UIが接続状態と現在の機能設定を確認できる情報を返します。"""
    vrm_path, vrm_url = _resolve_vrm_asset()
    motion_catalog = _load_motion_catalog()
    hermes = await _hermes_health()
    return {
        "status": "ok",
        "model": _effective_hermes_model(),
        "hermes": hermes,
        "tts_enabled": settings.tts_enabled,
        "tts_provider": settings.tts_provider,
        "stt": transcription_status(settings),
        "vrm_available": vrm_path is not None,
        "vrm_url": vrm_url,
        "suppress_blink_during_expression": settings.suppress_blink_during_expression,
        "motions": [motion.to_public_dict() for motion in motion_catalog.motions],
        "generating_motion": (
            motion_catalog.generating_motion.name if motion_catalog.generating_motion else None
        ),
        "motion_catalog_error": motion_catalog.error,
    }


async def _read_limited_audio(request: Request) -> bytes:
    """Content-Lengthがない送信でも上限を越えた音声をメモリへ保持しません。"""
    raw_length = request.headers.get("content-length")
    if raw_length:
        try:
            if int(raw_length) > settings.stt_max_audio_bytes:
                raise HTTPException(status_code=413, detail="録音データが大きすぎます")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Content-Lengthが正しくありません") from exc

    audio = bytearray()
    async for chunk in request.stream():
        audio.extend(chunk)
        if len(audio) > settings.stt_max_audio_bytes:
            raise HTTPException(status_code=413, detail="録音データが大きすぎます")
    if not audio:
        raise HTTPException(status_code=400, detail="録音データがありません")
    return bytes(audio)


@app.post("/api/transcriptions")
async def transcribe_audio(request: Request) -> dict:
    """同一オリジンのブラウザ録音を受け取り、既存会話へ渡せる文字列を返します。"""
    if not settings.stt_enabled:
        raise HTTPException(status_code=503, detail="音声入力は無効です")
    media_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if media_type not in _SUPPORTED_AUDIO_TYPES:
        raise HTTPException(status_code=415, detail="対応していない録音形式です")

    audio = await _read_limited_audio(request)
    try:
        return await transcriber.transcribe(audio)
    except NoSpeechDetectedError as exc:
        logger.info(
            "transcription rejected: no speech detected (bytes=%s, media_type=%s)",
            len(audio),
            media_type,
        )
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except TranscriptionUnavailableError as exc:
        logger.warning("transcription unavailable: %s", exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except TranscriptionError as exc:
        logger.warning(
            "transcription rejected: audio decode or inference failed (bytes=%s, media_type=%s)",
            len(audio),
            media_type,
        )
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/api/hermes/sessions")
async def list_hermes_sessions(
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=1_000),
) -> dict:
    """Avatar Gatewayが作成したHermesセッションだけを一覧で返します。"""
    try:
        return (await HermesClient(settings).list_sessions(limit=limit, offset=offset)).to_public_dict()
    except HermesError as exc:
        _raise_hermes_api_error(exc)


@app.post("/api/hermes/sessions", status_code=201)
async def create_hermes_session(request: HermesSessionCreateRequest) -> dict:
    """任意のIDやsystem promptを受け付けず、空のHermesセッションを作成します。"""
    try:
        session = await HermesClient(settings).create_session(request.title)
        return {"session": session.to_public_dict()}
    except HermesError as exc:
        _raise_hermes_api_error(exc)


@app.get("/api/hermes/sessions/{session_id}")
async def get_hermes_session(session_id: str) -> dict:
    """所有IDを検証してから一件のHermesセッション情報を返します。"""
    try:
        session = await HermesClient(settings).get_session(session_id)
        return {"session": session.to_public_dict()}
    except HermesError as exc:
        _raise_hermes_api_error(exc)


@app.post("/api/hermes/sessions/{session_id}/end")
async def end_hermes_session(session_id: str) -> dict:
    """画面を新しい会話へ切り替える前に、現在の所有セッションを終了します。"""
    try:
        session = await HermesClient(settings).end_session(session_id)
        return {"session": session.to_public_dict()}
    except HermesError as exc:
        _raise_hermes_api_error(exc)


@app.post("/api/hermes/sessions/{session_id}/fork", status_code=201)
async def fork_hermes_session(session_id: str) -> dict:
    """終了済みの所有セッションから、履歴を継承する新しい会話を作成します。"""
    try:
        session = await HermesClient(settings).fork_ended_session(session_id)
        return {"session": session.to_public_dict()}
    except HermesError as exc:
        _raise_hermes_api_error(exc)


@app.delete("/api/hermes/sessions/{session_id}")
async def delete_hermes_session(session_id: str) -> dict:
    """利用者が確認した終了済みの所有セッションだけを完全削除します。"""
    try:
        await HermesClient(settings).delete_ended_session(session_id)
        return {"id": session_id, "deleted": True}
    except HermesError as exc:
        _raise_hermes_api_error(exc)


@app.get("/api/hermes/sessions/{session_id}/messages")
async def get_hermes_session_messages(session_id: str) -> dict:
    """system promptと内部推論を除いた、所有セッションの正式履歴を返します。"""
    try:
        messages = await HermesClient(settings).get_session_messages(session_id)
        public_messages = [message.to_public_dict() for message in messages]
        return {
            "session_id": session_id,
            "data": await _prepare_session_messages(public_messages, _load_motion_catalog()),
        }
    except HermesError as exc:
        _raise_hermes_api_error(exc)


@app.get("/api/hermes/skills")
async def list_hermes_skills() -> dict:
    """Hermesが現在利用できるSkillの安全なメタデータを中継します。"""
    try:
        skills = await HermesClient(settings).list_skills()
        return {"data": [skill.to_public_dict() for skill in skills]}
    except HermesError as exc:
        _raise_hermes_api_error(exc)


@app.get("/api/hermes/toolsets")
async def list_hermes_toolsets() -> dict:
    """Hermes API ServerのToolsetと有効状態を読み取り専用で中継します。"""
    try:
        toolsets = await HermesClient(settings).list_toolsets()
        return {"data": [toolset.to_public_dict() for toolset in toolsets]}
    except HermesError as exc:
        _raise_hermes_api_error(exc)


@app.post("/api/hermes/runs", status_code=202)
async def start_hermes_run(request: HermesRunCreateRequest) -> dict:
    """所有セッションの正式履歴を使ってRunを開始し、直ちに上流SSE購読を開始します。"""
    try:
        return await run_coordinator.start_run(request.session_id, request.input)
    except HermesError as exc:
        _raise_hermes_api_error(exc)


@app.get("/api/hermes/models")
async def list_hermes_models() -> dict:
    """Hermesのモデル一覧を、認証情報を除いて画面へ返します。"""
    try:
        selected = _model_selection_store().load()
        catalog = public_model_catalog(await HermesClient(settings).list_model_options())
    except ModelSelectionError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except HermesError as exc:
        _raise_hermes_api_error(exc)
    return {
        "default_model": settings.hermes_model,
        "selected": selected.model_dump() if selected else None,
        "current_model": catalog["current_model"],
        "current_provider": catalog["current_provider"],
        "providers": catalog["providers"],
    }


@app.put("/api/hermes/model")
async def select_hermes_model(request: Request, body: HermesModelSelectRequest) -> dict:
    """選んだモデルを保存し、進行中のセッションがあればHermesへ固定します。"""
    if not is_same_origin_request(request.headers.get("Origin"), request.headers.get("Host")):
        raise HTTPException(status_code=403, detail="異なるオリジンからの設定変更は許可されていません")
    store = _model_selection_store()
    client = HermesClient(settings)
    try:
        if body.use_default:
            store.clear()
            locked = await _lock_default_session_model(client, body.session_id)
            return {"selected": None, "model": settings.hermes_model, "session_locked": locked}
        if not body.model or not body.provider:
            raise HTTPException(status_code=422, detail="モデルとプロバイダを指定してください")
        catalog = public_model_catalog(await client.list_model_options())
        if not selection_is_listed(catalog, body.model, body.provider):
            raise HTTPException(status_code=422, detail="指定されたモデルはHermesの一覧にありません")
        saved = store.save(SelectedHermesModel(model=body.model, provider=body.provider))
        locked = False
        if body.session_id:
            await client.lock_session_model(body.session_id, saved.model, saved.provider)
            locked = True
    except ModelSelectionError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except HermesError as exc:
        _raise_hermes_api_error(exc)
    return {"selected": saved.model_dump(), "model": saved.model, "session_locked": locked}


async def _lock_default_session_model(client: HermesClient, session_id: str | None) -> bool:
    """既定へ戻すとき、進行中セッションの固定先もHermesの現在モデルへ合わせます。"""
    if not session_id:
        return False
    catalog = public_model_catalog(await client.list_model_options())
    model = catalog["current_model"]
    provider = catalog["current_provider"]
    if not model or not provider:
        return False
    await client.lock_session_model(session_id, model, provider)
    return True


@app.get("/api/hermes/runs/{run_id}")
async def get_hermes_run(run_id: str) -> dict:
    """保持中またはHermesから安全に回収できた所有Run状態を返します。"""
    try:
        return await run_coordinator.get_or_recover_run(run_id)
    except HermesError as exc:
        _raise_hermes_api_error(exc)


@app.get("/api/hermes/runs/{run_id}/events")
async def stream_hermes_run_events(
    run_id: str,
    after: int = Query(default=0, ge=0),
) -> StreamingResponse:
    """保存済みイベントまたは回収後の状態変化を連番付きで配信します。"""
    try:
        await run_coordinator.get_or_recover_run(run_id)
    except HermesError as exc:
        _raise_hermes_api_error(exc)

    async def events():
        """接続維持コメントとJSONイベントをSSE形式へ変換します。"""
        async for event in run_coordinator.stream_events(run_id, after=after):
            if event is None:
                yield ": keepalive\n\n"
            else:
                yield _sse(str(event["type"]), event)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/hermes/runs/{run_id}/stop")
async def stop_hermes_run(run_id: str) -> dict:
    """ブラウザの中断を通信切断だけで終わらせず、Hermesエージェントへ伝えます。"""
    try:
        return await run_coordinator.stop_run(run_id)
    except HermesError as exc:
        _raise_hermes_api_error(exc)


@app.post("/api/hermes/runs/{run_id}/approval")
async def respond_to_hermes_run_approval(
    run_id: str,
    request: HermesRunApprovalRequest,
) -> dict:
    """ブラウザの検証済み選択を、現在承認待ちの所有Runへ一件だけ送ります。"""
    try:
        return await run_coordinator.respond_to_approval(run_id, request.choice)
    except HermesError as exc:
        _raise_hermes_api_error(exc)


async def _stream_agent_run(
    request: HermesConversationRequest,
    instructions: str,
) -> AsyncIterator[tuple[str, dict]]:
    """セッションを確定してRunを開始し、完了後の正式履歴まで一つのイベント列にします。"""
    client = HermesClient(settings)
    session_id = request.session_id
    created = session_id is None
    if session_id is None:
        session_id = (await client.create_session()).id

    yield "session.ready", {"session_id": session_id, "created": created}
    started = await run_coordinator.start_run(session_id, request.input, instructions)
    run_id = str(started["run_id"])
    yield "run.started", {
        "run_id": run_id,
        "session_id": session_id,
        "status": started["status"],
    }

    async for event in run_coordinator.stream_events(run_id):
        if event is None:
            continue
        yield str(event["type"]), event

    # Run表示中の仮履歴をHermes SessionDBの正本で置き換えられるよう、終端後に再取得します。
    messages = await client.get_session_messages(session_id)
    yield "session.messages", {
        "session_id": session_id,
        "data": [message.to_public_dict() for message in messages],
    }


@app.post("/api/hermes/conversation/stream")
async def stream_hermes_conversation(
    request: HermesConversationRequest,
) -> StreamingResponse:
    """Hermes Session/Runの表示と文単位TTSをSSEで段階的に返します。"""
    motion_catalog = _load_motion_catalog()

    async def events():
        event_queue: asyncio.Queue[tuple[str, dict] | object] = asyncio.Queue()
        speech_queue: asyncio.Queue[tuple[int, str, MotionDefinition | None, str] | None] = asyncio.Queue()
        audio_ready = asyncio.Event()
        sequence_id = uuid4().hex
        generation_failed = False
        generated_audio_paths: set[Path] = set()
        stream_finished_normally = False

        async def produce_text() -> None:
            """Hermes Run本文を即時表示し、完成した文だけをTTSワーカーへ渡します。"""
            nonlocal generation_failed
            full_text = ""
            segment_index = 0
            diagnostic_response_seen = False
            saw_delta_in_current_reply = False
            saw_speech_tag = False
            streamed_assistant_text = ""
            current_speech_motion: MotionDefinition | None = None
            current_speech_expression = "neutral"
            avatar_parser = AvatarDirectiveParser(motion_catalog.selectable_motions)
            speech_parser = SpeechTagParser()
            chunker = SentenceChunker(
                min_chars=settings.tts_chunk_min_chars,
                max_chars=settings.tts_chunk_max_chars,
            )

            async def enqueue_speech_chunks(chunks: list[str]) -> None:
                """文番号と現在のアバター制御を固定し、音声タスクの再生順を保ちます。"""
                nonlocal segment_index
                if not settings.tts_enabled:
                    return
                for chunk in chunks:
                    if segment_index == 0:
                        await event_queue.put(("speech.sequence.started", {"sequence_id": sequence_id}))
                    await speech_queue.put((
                        segment_index,
                        chunk,
                        current_speech_motion,
                        current_speech_expression,
                    ))
                    segment_index += 1
                if chunks:
                    # バッファ済みLLM差分が多い場合も、最初の合成を先に開始できるよう譲ります。
                    await asyncio.sleep(0)

            async def speak_approval_prompt() -> None:
                """承認ウィンドウの表示に合わせ、設定された一文だけを会話履歴へ残さず読み上げます。"""
                nonlocal current_speech_motion, current_speech_expression
                prompt = _approval_prompt_text(request)
                if not prompt:
                    return
                current_speech_motion = motion_catalog.selectable_motions.get("please")
                current_speech_expression = "relaxed"
                await enqueue_speech_chunks([prompt])

            async def publish_speech_parts(
                speech_parsed: ParsedSpeechChunk,
                source_sequence: int | None,
            ) -> None:
                """speech解析済みの表示本文と音声本文を、同じ順序で各キューへ渡します。"""
                nonlocal full_text
                if speech_parsed.display_text:
                    full_text += speech_parsed.display_text
                    text_event = {"delta": speech_parsed.display_text}
                    if source_sequence is not None:
                        text_event["sequence"] = source_sequence
                    await event_queue.put(("text.delta", text_event))
                if speech_parsed.speech_text:
                    await enqueue_speech_chunks(chunker.feed(speech_parsed.speech_text))

            async def process_speech_text(text: str, source_sequence: int | None) -> None:
                """現在の演技ブロックに属する本文を、表示と読み上げへ分離します。"""
                nonlocal saw_speech_tag
                speech_parsed = speech_parser.feed(text)
                saw_speech_tag = saw_speech_tag or speech_parser.has_speech_tag
                await publish_speech_parts(speech_parsed, source_sequence)

            async def finish_speech_scene(source_sequence: int | None = None) -> None:
                """表情切替前に旧設定のTTS断片を確定し、次のspeechタグ用に解析器を更新します。"""
                nonlocal speech_parser, chunker, saw_speech_tag
                speech_remainder = speech_parser.finish()
                saw_speech_tag = saw_speech_tag or speech_parser.has_speech_tag
                await publish_speech_parts(speech_remainder, source_sequence)
                await enqueue_speech_chunks(chunker.finish())
                speech_parser = SpeechTagParser()
                chunker = SentenceChunker(
                    min_chars=settings.tts_chunk_min_chars,
                    max_chars=settings.tts_chunk_max_chars,
                )

            async def process_avatar_parts(
                parts: tuple[ParsedAvatarChunk, ...],
                source_sequence: int | None,
            ) -> None:
                """本文と制御の出現順を保ち、音声境界を越える前に演技を切り替えます。"""
                nonlocal current_speech_motion, current_speech_expression
                for parsed in parts:
                    if parsed.expression is not None:
                        await finish_speech_scene(source_sequence)
                        current_speech_motion = parsed.motion
                        current_speech_expression = parsed.expression
                        await event_queue.put(("avatar.selected", {
                            "motion": parsed.motion.to_public_dict() if parsed.motion else None,
                            "expression": parsed.expression,
                        }))
                    if parsed.text:
                        await process_speech_text(parsed.text, source_sequence)

            async def process_assistant_delta(delta: str, source_sequence: int | None) -> None:
                """本文差分へRun連番を引き継ぎ、複数の演技ブロックを順番どおり処理します。"""
                await process_avatar_parts(avatar_parser.feed(delta), source_sequence)

            try:
                await event_queue.put(("status", {"state": "generating"}))
                session_messages_event: dict | None = None
                async for event_name, event_data in _stream_agent_run(
                    request,
                    _agent_response_instructions(motion_catalog),
                ):
                    completed_diagnostic: str | None = None
                    if event_name == "assistant.completed" and isinstance(event_data.get("output"), str):
                        completed_diagnostic = hermes_diagnostic_notice(event_data["output"])

                    if event_name == "assistant.delta":
                        delta = str(event_data.get("delta") or "")
                        streamed_assistant_text += delta
                        saw_delta_in_current_reply = saw_delta_in_current_reply or bool(delta)
                    elif event_name == "assistant.completed" and not saw_delta_in_current_reply:
                        # ツール後の最終回答に差分がない場合も、承認前の予告とは別発話として読み上げます。
                        completed_output = str(event_data.get("output") or "")
                        # HermesがRun全体を返す場合は、既に処理した予告部分を重複させません。
                        delta = (
                            completed_output[len(streamed_assistant_text):]
                            if streamed_assistant_text and completed_output.startswith(streamed_assistant_text)
                            else completed_output
                        )
                        saw_delta_in_current_reply = bool(delta)
                    else:
                        delta = ""

                    # Hermes自身の診断文は通常回答ではないため、解析器とTTSへ流しません。
                    if completed_diagnostic:
                        delta = ""
                        diagnostic_response_seen = True
                        display_notice = f"\n\n{completed_diagnostic}" if full_text else completed_diagnostic
                        full_text += display_notice
                        await event_queue.put(("text.delta", {"delta": display_notice}))

                    if event_name == "agent.failed":
                        raise HermesError(str(event_data.get("message") or "Hermes Runに失敗しました"))
                    if event_name == "agent.stopped":
                        raise HermesError("Hermes Runは停止されました")
                    if event_name == "session.messages":
                        session_messages_event = event_data
                        continue

                    if event_name in {"approval.requested", "tool.started"}:
                        # 予告文を次のLLM差分まで保留せず、承認表示やツール実行と並行して発話させます。
                        await finish_speech_scene()
                        if event_name == "approval.requested":
                            await speak_approval_prompt()
                        # ツール結果は別のassistant発話なので、アバター制御も独立して解析します。
                        avatar_parser = AvatarDirectiveParser(motion_catalog.selectable_motions)
                        current_speech_motion = None
                        current_speech_expression = "neutral"
                        # 境界後の完了本文は新しいassistant発話なので、差分の有無も改めて判定します。
                        saw_delta_in_current_reply = False

                    if event_name not in {"assistant.delta", "assistant.completed"}:
                        # Session、Run、Tool、Approvalイベントは次のUI段階でも使える形でそのまま中継します。
                        await event_queue.put((event_name, event_data))

                    # run.completedにだけ本文がある場合も、完了通知より先に最後の表示差分を確定します。
                    if delta:
                        raw_sequence = event_data.get("sequence")
                        source_sequence = raw_sequence if isinstance(raw_sequence, int) else None
                        await process_assistant_delta(delta, source_sequence)

                    if event_name == "assistant.completed":
                        # このイベント以降は、SessionDBやTTSの後始末を待たずHermes完了として扱えます。
                        presented_event = dict(event_data)
                        if isinstance(presented_event.get("output"), str):
                            _log_raw_assistant_output(presented_event["output"])
                            presented_event["output"] = _present_assistant_text(
                                presented_event["output"],
                                motion_catalog,
                            )
                        await event_queue.put(("assistant.completed", presented_event))

                # 通常本文として確定した残りだけを処理し、不完全な制御JSONは外へ出しません。
                await process_avatar_parts(avatar_parser.finish(), None)
                await finish_speech_scene()

                # 旧応答やタグ生成失敗時も全文読みに戻さず、最初の段落だけを代替音声にします。
                if not saw_speech_tag and not diagnostic_response_seen:
                    fallback = fallback_speech_summary(full_text)
                    if fallback:
                        await enqueue_speech_chunks(chunker.feed(fallback))
                await enqueue_speech_chunks(chunker.finish())
                if session_messages_event is not None:
                    raw_messages = session_messages_event.get("data")
                    if isinstance(raw_messages, list):
                        session_messages_event = {
                            **session_messages_event,
                            "data": await _prepare_session_messages(raw_messages, motion_catalog),
                        }
                    await event_queue.put(("session.messages", session_messages_event))
                # 正式履歴まで反映できた時点を、音声停止後に次の入力を許可できる本文終端とします。
                await event_queue.put(("text.completed", {"text": full_text}))

                # LLM完了時にも最初のWAVが未完成の場合だけ、音声準備中として表示します。
                if settings.tts_enabled and segment_index > 0 and not audio_ready.is_set():
                    await event_queue.put(("status", {"state": "synthesizing"}))
            except HermesError as exc:
                generation_failed = True
                await event_queue.put(("error", {"message": str(exc)}))
            except asyncio.CancelledError:
                raise
            except Exception:
                generation_failed = True
                logger.exception("conversation text producer failed")
                await event_queue.put(("error", {"message": "会話ストリームの処理に失敗しました"}))
            finally:
                await speech_queue.put(None)

        async def produce_speech() -> None:
            """GPU負荷と順序を安定させるため、文を一つずつ合成して通知します。"""
            succeeded = 0
            failed = 0
            attempted = 0
            try:
                if settings.tts_enabled:
                    async with create_tts_client() as client:
                        async def emit_openai_stream(text, client, segment_index, motion, expression) -> str:
                            """SSEで届いたPCMを順に渡し、非対応のサーバーではWAVへ戻します。"""
                            utterance_id = uuid4().hex
                            announced = False
                            try:
                                async for kind, value in iter_speech_pcm(text, settings, client):
                                    if generation_failed:
                                        if announced:
                                            await event_queue.put(("speech.stream.done", {
                                                "utterance_id": utterance_id,
                                            }))
                                        return "played"
                                    if kind == "rate":
                                        announced = True
                                        await event_queue.put(("speech.stream.started", {
                                            "sequence_id": sequence_id,
                                            "segment_index": segment_index,
                                            "utterance_id": utterance_id,
                                            "sample_rate": value,
                                            "motion": motion.to_public_dict() if motion else None,
                                            "expression": expression,
                                        }))
                                    elif kind == "pcm" and value:
                                        audio_ready.set()
                                        await event_queue.put(("speech.audio.delta", {
                                            "utterance_id": utterance_id,
                                            "audio": base64.b64encode(value).decode("ascii"),
                                        }))
                                    elif kind == "done":
                                        await event_queue.put(("speech.stream.done", {
                                            "utterance_id": utterance_id,
                                        }))
                                return "played"
                            except SpeechStreamUnsupported:
                                if not announced:
                                    return "wav"
                                await event_queue.put(("speech.failed", {
                                    "sequence_id": sequence_id,
                                    "segment_index": segment_index,
                                    "reason": "音声ストリームを開始した後に中断されました",
                                }))
                                return "failed"
                            except TtsError as exc:
                                if not announced:
                                    raise
                                await event_queue.put(("speech.failed", {
                                    "sequence_id": sequence_id,
                                    "segment_index": segment_index,
                                    "reason": str(exc),
                                }))
                                return "failed"

                        while True:
                            item = await speech_queue.get()
                            if item is None:
                                break
                            segment_index, text, motion, expression = item
                            attempted += 1
                            if generation_failed:
                                continue
                            try:
                                if settings.tts_provider == OPENAI_PROVIDER:
                                    outcome = await emit_openai_stream(
                                        text, client, segment_index, motion, expression,
                                    )
                                    if outcome == "played":
                                        succeeded += 1
                                        continue
                                    if outcome == "failed":
                                        failed += 1
                                        continue
                                utterance_id, audio_path = await synthesize(text, settings, client)
                                generated_audio_paths.add(audio_path)
                                if generation_failed:
                                    try:
                                        audio_path.unlink(missing_ok=True)
                                        generated_audio_paths.discard(audio_path)
                                    except OSError as exc:
                                        logger.warning("cancelled audio cleanup failed for %s: %s", utterance_id, exc)
                                    continue
                                audio_ready.set()
                                succeeded += 1
                                await event_queue.put(("speech.requested", {
                                    "sequence_id": sequence_id,
                                    "segment_index": segment_index,
                                    "utterance_id": utterance_id,
                                    "audio_url": f"/api/audio/{utterance_id}.wav",
                                    "motion": motion.to_public_dict() if motion else None,
                                    "expression": expression,
                                }))
                            except TtsError as exc:
                                failed += 1
                                await event_queue.put(("speech.failed", {
                                    "sequence_id": sequence_id,
                                    "segment_index": segment_index,
                                    "reason": str(exc),
                                }))
                else:
                    # 無効時も終端を消費し、同じ終了制御を利用します。
                    while True:
                        if await speech_queue.get() is None:
                            break

                if attempted > 0 and not generation_failed:
                    await event_queue.put(("speech.sequence.completed", {
                        "sequence_id": sequence_id,
                        "segments": attempted,
                        "succeeded": succeeded,
                        "failed": failed,
                    }))
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("conversation speech producer failed")
                await event_queue.put(("speech.failed", {"reason": "音声合成処理に失敗しました"}))
        producers = [
            asyncio.create_task(produce_text()),
            asyncio.create_task(produce_speech()),
        ]
        # 開始直後にキャンセルされたタスクも必ず数え、SSEが終了待ちのまま残らないようにします。
        for producer in producers:
            producer.add_done_callback(lambda _task: event_queue.put_nowait(_PRODUCER_DONE))
        speech_worker = producers[1]
        speech_sequence_workers[sequence_id] = speech_worker
        try:
            completed_producers = 0
            while completed_producers < len(producers):
                item = await event_queue.get()
                if item is _PRODUCER_DONE:
                    completed_producers += 1
                    continue
                event_name, data = item
                yield _sse(event_name, data)
            if not generation_failed:
                # 全イベントを渡した後は、WAVの所有権を再生結果通知へ引き継ぎます。
                stream_finished_normally = True
                yield _sse("done", {})
            else:
                stream_finished_normally = True
        finally:
            if speech_sequence_workers.get(sequence_id) is speech_worker:
                speech_sequence_workers.pop(sequence_id, None)
            for producer in producers:
                if not producer.done():
                    producer.cancel()
            await asyncio.gather(*producers, return_exceptions=True)
            if not stream_finished_normally:
                # 切断時はブラウザへ未通知のWAVも含め、この会話で作った一時資産を回収します。
                for audio_path in generated_audio_paths:
                    try:
                        audio_path.unlink(missing_ok=True)
                    except OSError as exc:
                        logger.warning("disconnected audio cleanup failed for %s: %s", audio_path.name, exc)

    return StreamingResponse(events(), media_type="text/event-stream")


@app.post("/api/speech-sequences/{sequence_id}/cancel")
async def cancel_speech_sequence(sequence_id: str) -> JSONResponse:
    """Hermesの文章生成を残したまま、指定応答の未完了TTSワーカーだけを中断します。"""
    if len(sequence_id) != 32 or any(character not in "0123456789abcdef" for character in sequence_id):
        raise HTTPException(status_code=422, detail="音声シーケンスIDが不正です")

    worker = speech_sequence_workers.get(sequence_id)
    cancelled = worker is not None and not worker.done()
    if cancelled:
        worker.cancel()
    return JSONResponse({"accepted": True, "cancelled": cancelled})


@app.get("/api/ui-settings")
async def get_ui_settings() -> dict:
    """秘密情報を含まないUI既定値だけを、ブラウザの初期化用に返します。"""
    try:
        return _ui_settings_store().load().model_dump(mode="json")
    except UiSettingsError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/backgrounds")
async def get_backgrounds() -> dict:
    """製品同梱とローカル差し替えを統合し、壁紙選択肢として列挙します。"""
    try:
        return {"data": list_backgrounds(
            settings.bundled_assets_dir / "backgrounds",
            settings.local_assets_dir / "backgrounds",
        )}
    except UiSettingsError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.put("/api/ui-settings")
async def put_ui_settings(request: Request, value: UiSettings) -> dict:
    """同一オリジンから明示保存された現在値だけを、全ブラウザ用の既定値へ反映します。"""
    if not is_same_origin_request(request.headers.get("Origin"), request.headers.get("Host")):
        raise HTTPException(status_code=403, detail="異なるオリジンからの設定変更は許可されていません")
    try:
        return _ui_settings_store().save(value).model_dump(mode="json")
    except UiSettingsError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/gaze-speech")
async def gaze_speech_status() -> dict:
    """対象cronジョブの新しい出力を確認し、まだ話していない件数を返します。"""
    await asyncio.to_thread(gaze_store.scan)
    return gaze_store.status()


@app.post("/api/gaze-speech/claim")
async def claim_gaze_speech() -> dict:
    """待ち行列の先頭を音声化し、会話セッションへは書き込みません。"""
    await asyncio.to_thread(gaze_store.scan)
    performance = await asyncio.to_thread(gaze_store.claim)
    if performance is None:
        return {**gaze_store.status(), "spoken": False}
    if not settings.tts_enabled:
        await asyncio.to_thread(gaze_store.put_back, performance)
        raise HTTPException(status_code=409, detail="音声合成が無効です")
    catalog = _load_motion_catalog()
    created: list[Path] = []
    beats_out: list[dict] = []
    try:
        async with create_tts_client() as client:
            for beat in performance.beats:
                # 列へ入れる前に割ると三ブロックの上限で後ろが落ちるため、声の直前で会話と同じ長さへ切ります。
                chunker = SentenceChunker(
                    min_chars=settings.tts_chunk_min_chars,
                    max_chars=settings.tts_chunk_max_chars,
                )
                chunks = [*chunker.feed(beat.text), *chunker.finish()]
                motion = catalog.selectable_motions.get(beat.motion) if beat.motion else None
                for chunk in chunks:
                    utterance_id, audio_path = await synthesize(chunk, settings, client)
                    created.append(audio_path)
                    beats_out.append({
                        "text": chunk,
                        "utterance_id": utterance_id,
                        "audio_url": f"/api/audio/{utterance_id}.wav",
                        "motion": motion.to_public_dict() if motion else None,
                        "expression": beat.expression,
                    })
    except TtsError:
        logger.exception("gaze speech synthesis failed")
        for path in created:
            try:
                path.unlink(missing_ok=True)
            except OSError as exc:
                logger.warning("gaze speech cleanup failed for %s: %s", path, exc)
        await asyncio.to_thread(gaze_store.put_back, performance)
        raise HTTPException(status_code=502, detail="視線発話の音声を準備できませんでした") from None
    first = beats_out[0]
    return {
        **gaze_store.status(),
        "spoken": True,
        "beats": beats_out,
        "text": first["text"],
        "utterance_id": first["utterance_id"],
        "audio_url": first["audio_url"],
    }


@app.get("/api/audio/{filename}")
async def audio(filename: str) -> FileResponse:
    """生成済みWAVだけを固定ディレクトリから安全に配信します。"""
    if not filename.endswith(".wav") or Path(filename).name != filename:
        raise HTTPException(status_code=404)
    path = settings.audio_dir / filename
    if not path.is_file():
        raise HTTPException(status_code=404)
    return FileResponse(path, media_type="audio/wav", filename=filename)


@app.get("/api/images/{filename}")
async def generated_image(filename: str) -> FileResponse:
    """Avatar Gatewayが複製・管理している生成画像だけを同一オリジンで配信します。"""
    path = generated_image_store.resolve_public_file(filename)
    if path is None:
        raise HTTPException(status_code=404)
    return FileResponse(path, headers={"Cache-Control": "private, max-age=86400"})


@app.post("/api/speech-events")
async def speech_event(event: SpeechEvent) -> JSONResponse:
    """実再生結果を記録し、不要になった文単位WAVを安全に削除します。"""
    logger.info("speech event: %s", event.model_dump())
    if event.type in {"speech.completed", "speech.failed", "speech.cancelled"}:
        audio_path = settings.audio_dir / f"{event.utterance_id}.wav"
        try:
            audio_path.unlink(missing_ok=True)
        except OSError as exc:
            # 削除失敗は会話を止めず、運用時にログから掃除できるよう記録します。
            logger.warning("temporary audio cleanup failed for %s: %s", event.utterance_id, exc)
    return JSONResponse({"accepted": True})


# ViteのJS/CSS用/assetsと衝突させず、製品同梱資産を用途別パスで限定公開します。
settings.local_assets_dir.mkdir(parents=True, exist_ok=True)
app.mount(
    "/assets/motions",
    StaticFiles(directory=settings.bundled_assets_dir / "motions"),
    name="bundled-motions",
)
app.mount(
    "/assets/backgrounds",
    StaticFiles(directory=settings.bundled_assets_dir / "backgrounds"),
    name="bundled-backgrounds",
)
app.mount(
    "/assets/vrm",
    StaticFiles(directory=settings.bundled_assets_dir / "vrm"),
    name="bundled-vrm",
)
app.mount("/local-assets", StaticFiles(directory=settings.local_assets_dir), name="local-assets")

frontend_dist = PROJECT_ROOT / "frontend" / "dist"
if frontend_dist.is_dir():
    app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")
