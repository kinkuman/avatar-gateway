# Third-Party Software Notices / 第三者ソフトウェアに関する表記

Avatar Gatewayは、次の主要なオープンソースソフトウェアを利用または外部サービスとして連携します。各ソフトウェアには、リンク先のプロジェクトが定めるライセンスが適用されます。

Avatar Gateway uses or integrates with the major open-source projects listed below. Each project remains subject to the license specified by its maintainers.

## Included libraries / 組み込みライブラリ

これらはAvatar GatewayのPython依存関係またはフロントエンド依存関係として直接利用します。

These projects are used directly as Python or frontend dependencies of Avatar Gateway.

| Software | Purpose / 用途 | License |
| --- | --- | --- |
| [React](https://github.com/facebook/react) | User interface / ユーザーインターフェース | MIT |
| [three.js](https://github.com/mrdoob/three.js) | 3D rendering / 3D表示 | MIT |
| [@pixiv/three-vrm and @pixiv/three-vrm-animation](https://github.com/pixiv/three-vrm) | VRM loading and animation / VRMの読込・アニメーション | MIT |
| [FastAPI](https://github.com/fastapi/fastapi) | Backend API / バックエンドAPI | MIT |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | Optional speech recognition / 任意の音声認識 | MIT |
| [noisejs](https://github.com/josephg/noisejs) | Perlin noise for idle motion and blink timing / 待機動作と瞬き頻度のPerlinノイズ | [ISC](third_party_licenses/noisejs-ISC.txt) |

Avatar Gatewayの`PerlinNoise2D.ts`は、Joseph GentleによるnoisejsをTypeScript向けに整理したものです。noisejsはStefan Gustavsonによるpublic domain実装を基にしています。

Avatar Gateway's `PerlinNoise2D.ts` is a TypeScript adaptation of noisejs by Joseph Gentle. Noisejs is based on a public-domain implementation by Stefan Gustavson.

## External software / 外部連携ソフトウェア

これらはAvatar Gatewayに同梱されません。利用者が別途導入・起動し、Avatar GatewayからAPI経由で接続します。

These projects are not bundled with Avatar Gateway. Users install and run them separately, and Avatar Gateway connects to them through their APIs.

| Software | Purpose / 用途 | License |
| --- | --- | --- |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | Conversations and tool execution / 会話・ツール実行 | MIT |
| [Style-Bert-VITS2](https://github.com/litagin02/Style-Bert-VITS2) | Optional speech synthesis / 任意の音声合成 | AGPL-3.0; its `text/user_dict/` module is LGPL-3.0 |

## Scope / この文書の範囲

このリポジトリはAvatar Gatewayをソースコードとして配布し、インストール後のPython仮想環境、`node_modules`、`frontend/dist`を同梱しません。この文書は、利用者が構成を把握しやすくするための主要プロジェクトの概要であり、パッケージ管理ツールが導入するすべての推移依存関係を列挙するものではありません。

This repository distributes Avatar Gateway as source code. It does not include an installed Python environment, `node_modules`, or `frontend/dist`. This document provides an overview of the major projects involved; it is not an exhaustive inventory of every transitive dependency installed by package managers.

ビルド済みフロントエンド、コンテナ、インストーラーなどを再配布する場合は、その配布物に実際に含まれる推移依存関係も確認し、各ライセンスが求める著作権表示、ライセンス本文、その他の告知を同梱してください。正式な条件は、配布する各バージョンに付属するライセンスファイルを参照してください。

Before redistributing a built frontend, container, installer, or similar artifact, review all transitive dependencies actually included in that artifact and provide the copyright notices, license texts, and other notices required by their licenses. Refer to the license files shipped with the exact versions being distributed for the authoritative terms.

Assets bundled with Avatar Gateway are documented separately in [ASSET_LICENSES.md](ASSET_LICENSES.md). The bundled Hamuko VRM model is subject to the [Hamuko model terms of use](docs/character_model_license.md).
