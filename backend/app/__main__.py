"""環境設定の待受先と安全検証を必ず使ってAvatar Gatewayを起動します。"""

import uvicorn

from .config import settings


def main() -> None:
    """手入力したuvicorn引数によるLAN認証設定の取り違えを避けて起動します。"""
    uvicorn.run(
        "app.main:app",
        host=settings.gateway_host,
        port=settings.gateway_port,
    )


if __name__ == "__main__":
    main()
