# Avatar Gateway クイックスタート

[English](QUICKSTART.en.md)

![はむ子がクイックスタートを案内する](docs/images/quickstart_welcome.png)

この文書では、Avatar Gatewayで最初の会話を始めるまでを、順番に説明します。

最初は文章だけで会話します。音声の読み上げ、マイク入力、画像生成などは、あとから追加できます。まずは、アバターが表示され、Hermesから文章で返事が来るところまで進めましょう。

## この手順で想定している使い方

このクイックスタートでは、次の状態を想定しています。

- Linuxが動いている1台のパソコンを使う。Linuxは、パソコンを動かす基本ソフトウェアの一種です
- HermesとAvatar Gatewayを同じパソコンで動かす
- Hermesのインストールと初期設定は終わっている
- Hermesを起動できる

Hermesをまだインストールしていない場合は、先にHermesの説明書に従って準備してください。Avatar GatewayだけではAIとの会話を作れません。

## 最初に知っておく言葉

この文書では、次の言葉を使います。

- **Hermes**：AIへ質問を送り、返事や作業結果を受け取るプログラムです。
- **Avatar Gateway**：Hermesの返事を受け取り、アバターと一緒に画面へ表示するプログラムです。
- **ターミナル**：文字でパソコンへ命令を入力するための画面です。これから出てくる灰色の枠内の命令を、ここへ入力します。
- **コマンド**：ターミナルへ入力する命令です。1行ずつ入力し、最後にEnterキーを押します。
- **サーバー**：ほかのプログラムからの要求を待ち、返事をするプログラムです。この手順では、HermesとAvatar Gatewayの両方をサーバーとして起動します。
- **バックエンド**：Hermesとの通信や設定の読み込みを担当する、画面の裏側のプログラムです。
- **フロントエンド**：ブラウザにアバターや会話欄を表示する、利用者が見る画面です。
- **ブラウザ**：Webページを見るアプリです。Firefox、Google Chrome、Microsoft Edgeなどがあります。
- **APIキー**：プログラム同士が安全に通信するための、パスワードのような文字列です。

意味をすべて覚える必要はありません。手順どおりに進めれば大丈夫です。

## 用意するもの

![必要なものを準備するはむ子](docs/images/quickstart_requirements.png)

次のものが必要です。

- Python 3.11以降。Avatar Gatewayのバックエンドを動かすために使います
- Node.js 20以降。Avatar Gatewayの画面を準備して動かすために使います
- 起動できる状態のHermes
- Hermesに設定した`API_SERVER_KEY`
- Firefox、Google Chrome、Microsoft Edgeなどのブラウザ

`API_SERVER_KEY`はHermesへ接続するためのAPIキーです。あとでAvatar Gatewayの設定ファイルへ同じ値を書きます。

## 1. Avatar Gatewayのフォルダを開く

配布されたAvatar Gatewayをダウンロードしてください。ZIPファイルは、複数のファイルを1つにまとめたものです。ZIPファイルで入手した場合は、先に展開して中のファイルを取り出します。

展開してできたフォルダを、この文書では「Avatar Gatewayのフォルダ」と呼びます。その中には、少なくとも次のファイルとフォルダがあります。

```text
README.md
.env.example
backend
frontend
```

ターミナルを開き、Avatar Gatewayのフォルダへ移動してください。フォルダの場所は、ダウンロードした場所によって異なります。

例えば、ホームフォルダの下に`avatar-gateway`という名前で置いた場合は、次のコマンドです。

```bash
cd ~/avatar-gateway
```

`cd`は、ターミナルで作業するフォルダを移動するコマンドです。

## 2. PythonとNode.jsを確認する

次のコマンドを1行ずつ実行します。

```bash
python3 --version
node --version
npm --version
```

バージョンとは、ソフトウェアの世代を表す番号です。

- Pythonが`3.11`以上なら利用できます。
- Node.jsが`20`以上なら利用できます。
- `npm`はNode.jsと一緒に入る、必要な部品を準備するためのプログラムです。

`command not found`と表示された場合は、そのソフトウェアが入っていません。先にPythonまたはNode.jsをインストールしてください。

## 3. Hermesを起動する

Hermesを、API Serverが使える状態で起動してください。

APIは、プログラム同士が情報をやり取りするための窓口です。API Serverは、その窓口で要求を待つプログラムです。

このクイックスタートでは、Hermesが次のアドレスで待ち受けているものとします。

```text
http://127.0.0.1:8642
```

`127.0.0.1`は「いま使っているこのパソコン」を表します。`8642`は、同じパソコンの中でHermesを見分けるための番号です。

Hermesの設定では、少なくともAPI Serverを有効にし、`API_SERVER_KEY`を設定してください。このキーは次の手順で使います。

設定する値は次のとおりです。

```env
API_SERVER_ENABLED=true
API_SERVER_HOST=127.0.0.1
API_SERVER_PORT=8642
API_SERVER_MODEL_NAME=hermes-agent
API_SERVER_KEY=自分で決めた秘密の文字列
```

- `API_SERVER_ENABLED=true`は、API Serverを使えるようにする設定です。
- `API_SERVER_HOST`と`API_SERVER_PORT`は、Hermesが要求を待つアドレスと番号です。
- `API_SERVER_MODEL_NAME`は、Avatar Gatewayが接続先を指定するときに使う名前です。
- `API_SERVER_KEY`は、他人に推測されにくい秘密の文字列にします。

設定方法やHermesの起動方法は、利用しているHermesの説明書を確認してください。

## 4. Avatar Gatewayの設定ファイルを作る

![HermesとAvatar Gatewayを接続するはむ子](docs/images/quickstart_connection.png)

Avatar Gatewayのフォルダを開いているターミナルで、次のコマンドを実行します。

```bash
cp .env.example .env
```

`cp`はファイルをコピーするコマンドです。この操作では、設定例の`.env.example`をコピーして、実際に使う`.env`を作ります。

`.env`は、接続先やAPIキーなど、このパソコンだけで使う設定を書くファイルです。ファイル名の先頭にある`.`も名前の一部です。

同じパソコンでHermesを動かす場合、次の行は変更しません。`HERMES_BASE_URL`は、HermesのAPI Serverがある場所を表す設定です。

```env
HERMES_BASE_URL=http://127.0.0.1:8642/v1
```

作成された`.env`をテキストエディタで開き、次の行を探します。テキストエディタは、文字だけのファイルを編集するアプリです。

```env
HERMES_API_KEY=ここにHermesのAPI_SERVER_KEYと同じ値を設定
```

`=`の右側を、Hermesに設定した`API_SERVER_KEY`と同じ文字列へ書き換えてください。

例えばHermesのAPIキーが`example-secret-key`なら、次のようにします。

```env
HERMES_API_KEY=example-secret-key
```

書き換えたら、`.env`を保存します。

APIキーはパスワードと同じように扱ってください。`.env`を他人へ送ったり、内容を公開したりしないでください。

## 5. フロントエンドを準備する

![Avatar Gatewayを準備して起動するはむ子](docs/images/quickstart_start.png)

初回だけ、ブラウザへ表示する画面を準備します。次のコマンドを1行ずつ実行してください。

```bash
cd frontend
npm ci
npm run build
cd ..
```

それぞれのコマンドには、次の役割があります。

1. `cd frontend`で、画面を作るプログラムのフォルダへ移動します。
2. `npm ci`で、画面表示に必要な部品をインターネットから取得します。最初の1回は少し時間がかかることがあります。
3. `npm run build`で、バックエンドから配信できる画面を`frontend/dist`へ作成します。
4. `cd ..`で、Avatar Gatewayのフォルダへ戻ります。

この準備は起動するたびに行う必要はありません。Avatar Gatewayのソースコードを更新した場合は、この手順をもう一度実行してください。

## 6. バックエンドを起動する

同じターミナルで、次のコマンドを1行ずつ実行します。

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m app
```

それぞれのコマンドには、次の役割があります。

1. `cd backend`で、バックエンドのフォルダへ移動します。
2. `python3 -m venv .venv`で、Avatar Gateway専用のPython環境を作ります。専用環境を使うことで、ほかのPythonプログラムと部品が混ざるのを防ぎます。
3. `.venv/bin/pip install -r requirements.txt`で、バックエンドに必要な部品をインターネットから取得します。最初の1回は少し時間がかかることがあります。
4. `.venv/bin/python -m app`で、バックエンドを起動します。

最後のコマンドを実行すると、ターミナルへ動作状況を表す文字が表示されます。これは正常です。会話している間は、このターミナルを閉じないでください。

バックエンドは、通常は次のアドレスで待ち受けます。

```text
http://127.0.0.1:8000
```

## 7. ブラウザで開く

![最初の会話が成功して喜ぶはむ子](docs/images/quickstart_success.png)

Firefox、Google Chrome、Microsoft Edgeなどのブラウザを開き、アドレス欄へ次を入力します。

```text
http://127.0.0.1:8000
```

アドレスとは、ブラウザが接続する場所を表す文字列です。

画面にアバターと文章入力欄が表示されたら、次のような短い文章を送ってみてください。

```text
こんにちは
```

Hermesから返事が表示されれば、準備は完了です。

最初の設定では、音声の読み上げとマイク入力は無効です。返事が文章だけで表示され、音が出ないのは正常です。

## 終了する方法

バックエンドを起動しているターミナルで、`Ctrl`キーを押しながら`C`キーを押します。この操作を`Ctrl+C`と書きます。

画面を閉じるだけでは、バックエンドが動き続けることがあります。使い終わったら、ターミナルで停止してください。

## 次に起動するとき

最初の準備は終わっているので、部品を毎回インストールする必要はありません。

Avatar Gatewayのフォルダを開き、次を実行します。

```bash
cd backend
.venv/bin/python -m app
```

その後、ブラウザで`http://127.0.0.1:8000`を開きます。

## うまく動かないとき

### 画面を開けない

バックエンドを起動したターミナルが動いているか確認してください。終了している場合は、もう一度`.venv/bin/python -m app`を実行します。

### Hermesへ接続できない

次の項目を順番に確認してください。

1. Hermesが起動しているか。
2. HermesのAPI Serverが有効になっているか。
3. `.env`の`HERMES_API_KEY`がHermesの`API_SERVER_KEY`と同じか。
4. `.env`の`HERMES_BASE_URL`が`http://127.0.0.1:8642/v1`になっているか。

大文字と小文字は別の文字として扱われます。APIキーは、空白も含めて完全に同じである必要があります。

### エラーの内容を確認したい

ブラウザで次のアドレスを開きます。

```text
http://127.0.0.1:8000/api/health
```

ここには、Avatar Gatewayが確認できた接続状態が表示されます。`health`は、プログラムが正しく動いているかを確認する情報という意味です。

解決しない場合は、バックエンドを起動したターミナルに表示されたエラーを確認してください。エラーとは、問題の原因を知らせるメッセージです。

## 音声なども使いたい場合

文章で会話できることを確認した後に、音声の読み上げ、マイク入力、画像生成などを追加できます。Hermesの設定を用途別に分けるProfileや、家庭内ネットワーク（LAN）の別端末から利用する方法も設定できます。

詳しい設定は[README](README.md)を参照してください。
