"""画像入力の境界と、正式履歴を保ったままHermesへ画像が届く契約を検証します。"""

import base64
import json
from dataclasses import replace

import httpx
import pytest
from pydantic import ValidationError

from app import main as main_module
from app.config import Settings
from app.models import HermesConversationRequest
from app.services.hermes import HermesClient, HermesSessionMessage
from app.services.hermes_runs import HermesRunCoordinator
from app.services.input_images import MAX_IMAGE_BYTES, present_image_input

SESSION_ID = 'avatar_gateway_0123456789abcdef0123456789abcdef'
RUN_ID = 'run_0123456789abcdef0123456789abcdef'
PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg=='


@pytest.mark.parametrize('image', [
    'https://example.com/private.png',
    'data:image/png;base64,not base64!',
    'data:image/jpeg;base64,' + base64.b64encode(b'not a jpeg').decode(),
    'data:image/svg+xml;base64,' + base64.b64encode(b'<svg/>').decode(),
    'data:image/png;base64,' + base64.b64encode(b'\x89PNG\r\n\x1a\n' + b'x' * MAX_IMAGE_BYTES).decode(),
])
def test_rejects_invalid_or_oversized_image(image: str) -> None:
    """外部URL・偽の形式・上限超過を、Hermesへ渡す前に拒否します。"""
    with pytest.raises(ValidationError):
        HermesConversationRequest(input='見てください', image=image)


def test_public_history_hides_image_paths_without_changing_saved_context() -> None:
    """履歴表示だけで保存パスを隠し、次回送る正式履歴の文字列は維持します。"""
    content = 'これは何？\n\n[Image attached at: /private/native-inputs/hash/api_image.png]\n[screenshot]'
    message = HermesSessionMessage({'role': 'user', 'content': content})
    assert message.data['content'] == content
    assert message.to_public_dict()['content'] == 'これは何？\n\n（画像を添付）'
    assert present_image_input('普通の質問') == '普通の質問'


@pytest.mark.asyncio
async def test_image_flows_through_api_coordinator_and_client(monkeypatch, tmp_path) -> None:
    """会話から日時・正式履歴・一枚の画像が届き、Gatewayにファイルを作らないことを確認します。"""
    requests: list[httpx.Request] = []
    saved_content = '以前の質問\n[screenshot]'

    def upstream(request: httpx.Request) -> httpx.Response:
        """実通信の代わりにHermesのSession/Run契約を返します。"""
        requests.append(request)
        if request.url.path.endswith('/messages'):
            return httpx.Response(200, json={'data': [
                {'role': 'user', 'content': saved_content},
                {'role': 'assistant', 'content': '以前の回答'},
            ]})
        if request.url.path.endswith('/events'):
            return httpx.Response(200, text='event: run.completed\ndata: {"event":"run.completed","output":"画像を確認しました"}\n\n')
        if request.method == 'POST':
            return httpx.Response(202, json={'run_id': RUN_ID, 'status': 'started'})
        return httpx.Response(200, json={'session': {'id': SESSION_ID, 'source': 'api_server'}})

    config = replace(Settings(), hermes_api_key='test-secret', hermes_model_file=tmp_path/'model.json')
    client = HermesClient(config, httpx.MockTransport(upstream))
    coordinator = HermesRunCoordinator(lambda: client)
    monkeypatch.setattr(main_module, 'HermesClient', lambda _settings: client)
    monkeypatch.setattr(main_module, 'run_coordinator', coordinator)
    request = HermesConversationRequest(input='このボタンは何？', session_id=SESSION_ID, image=PNG)
    events = [event async for event in main_module._stream_agent_run(request, '既存のアバター指示')]
    body = json.loads(next(r.content for r in requests if r.method == 'POST'))
    current = body['input'][0]
    assert current['role'] == 'user'
    assert current['content'][0]['text'].endswith('このボタンは何？')
    assert '[avatar_gateway_time]' in current['content'][0]['text']
    assert current['content'][1] == {'type': 'image_url', 'image_url': {'url': PNG}}
    assert body['conversation_history'] == [
        {'role': 'user', 'content': saved_content},
        {'role': 'assistant', 'content': '以前の回答'},
    ]
    assert body['instructions'].startswith('既存のアバター指示')
    assert events[0][0] == 'session.ready'
    assert events[1][0] == 'run.started'
    assert events[-1][0] == 'session.messages'
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
async def test_http_validation_blocks_bad_image_before_run(monkeypatch) -> None:
    """HTTP経由の不正画像でも、セッション・Runを開始しません。"""
    async def unexpected_run(*_args, **_kwargs):
        """検証前に推論が始まった場合は試験を失敗させます。"""
        pytest.fail('invalid image reached Hermes')

    monkeypatch.setattr(main_module.run_coordinator, 'start_run', unexpected_run)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main_module.app), base_url='http://localhost') as client:
        response = await client.post('/api/hermes/conversation/stream', json={
            'input': '見てください', 'image': 'https://example.com/image.png',
        })
    assert response.status_code == 422
