# Avatar Gateway Quick Start

[日本語](QUICKSTART.md)

![Hamuko welcoming you to the quick start](docs/images/quickstart_welcome.png)

This guide walks you through the steps required to start your first conversation with Avatar Gateway.

You will begin with text chat only. Speech output, microphone input, and image generation can be added later. For now, the goal is simple: display the avatar and receive a text reply from Hermes.

## What This Guide Assumes

This quick start assumes the following:

- You are using one computer that runs Linux. Linux is a type of operating system: the basic software that runs a computer.
- Hermes and Avatar Gateway will run on the same computer.
- You have already installed and configured Hermes.
- You know how to start Hermes.

If Hermes is not installed yet, prepare it first by following the Hermes documentation. Avatar Gateway cannot provide AI conversations by itself.

## Words Used in This Guide

This guide uses the following terms:

- **Hermes:** The program that sends your questions to an AI and receives replies or task results.
- **Avatar Gateway:** The program that receives replies from Hermes and displays them with an avatar.
- **Terminal:** A window where you control your computer by typing text commands. Enter the commands shown in the gray boxes into this window.
- **Command:** An instruction typed into a terminal. Enter one line at a time, then press Enter.
- **Server:** A program that waits for requests from another program and sends back a response. In this guide, both Hermes and Avatar Gateway run server programs.
- **Backend:** The part of Avatar Gateway that works behind the screen. It communicates with Hermes and reads your settings.
- **Frontend:** The part of Avatar Gateway that displays the avatar and conversation controls in a browser.
- **Browser:** An application used to view web pages, such as Firefox, Google Chrome, or Microsoft Edge.
- **API key:** A secret string similar to a password. Programs use it to communicate securely.

You do not need to memorize these words. You can follow the steps as written.

## What You Need

![Hamuko preparing the required tools](docs/images/quickstart_requirements.png)

Prepare the following:

- Python 3.11 or later. It runs the Avatar Gateway backend.
- Node.js 20 or later. It prepares and runs the Avatar Gateway screen.
- A working Hermes installation.
- The `API_SERVER_KEY` configured in Hermes.
- A browser such as Firefox, Google Chrome, or Microsoft Edge.

`API_SERVER_KEY` is the API key used to connect to Hermes. You will copy the same value into the Avatar Gateway settings later.

## 1. Open the Avatar Gateway Folder

Download the Avatar Gateway distribution. A ZIP file is one file that contains many other files. If you downloaded a ZIP file, extract it first.

This guide calls the extracted folder the “Avatar Gateway folder.” It should contain at least the following files and folders:

```text
README.md
.env.example
backend
frontend
```

Open a terminal and move into the Avatar Gateway folder. Its location depends on where you downloaded or extracted it.

For example, if the folder is named `avatar-gateway` and is directly inside your home folder, run:

```bash
cd ~/avatar-gateway
```

`cd` is a command that changes the folder in which the terminal is working.

## 2. Check Python and Node.js

Run the following commands one line at a time:

```bash
python3 --version
node --version
npm --version
```

A version is a number that identifies a generation of software.

- Python `3.11` or later can be used.
- Node.js `20` or later can be used.
- `npm` is installed with Node.js. It prepares the software parts needed by the frontend.

If you see `command not found`, that software is not installed. Install Python or Node.js before continuing.

## 3. Start Hermes

Start Hermes with its API Server enabled.

An API is a connection point that programs use to exchange information. An API Server is the program that waits for requests at that connection point.

This quick start assumes that Hermes is available at this address:

```text
http://127.0.0.1:8642
```

`127.0.0.1` means “this computer.” `8642` is the number used to identify Hermes from other programs on the same computer.

At minimum, enable the Hermes API Server and set `API_SERVER_KEY`. You will use this key in the next step.

Use these values:

```env
API_SERVER_ENABLED=true
API_SERVER_HOST=127.0.0.1
API_SERVER_PORT=8642
API_SERVER_MODEL_NAME=hermes-agent
API_SERVER_KEY=your-own-secret-string
```

- `API_SERVER_ENABLED=true` turns on the API Server.
- `API_SERVER_HOST` and `API_SERVER_PORT` specify the address and number where Hermes waits for requests.
- `API_SERVER_MODEL_NAME` is the name Avatar Gateway uses when connecting.
- `API_SERVER_KEY` must be a secret string that other people cannot easily guess.

See the documentation for your Hermes installation for its configuration and startup instructions.

## 4. Create the Avatar Gateway Settings File

![Hamuko connecting Hermes and Avatar Gateway](docs/images/quickstart_connection.png)

In the terminal that is open in the Avatar Gateway folder, run:

```bash
cp .env.example .env
```

`cp` copies a file. This command copies the example settings file, `.env.example`, to the settings file that Avatar Gateway will actually use, `.env`.

`.env` stores settings used only on this computer, such as connection addresses and API keys. The `.` at the beginning is part of the filename.

When Hermes runs on the same computer, leave this line unchanged. `HERMES_BASE_URL` tells Avatar Gateway where the Hermes API Server is located.

```env
HERMES_BASE_URL=http://127.0.0.1:8642/v1
```

Open `.env` in a text editor and find the following line. A text editor is an application used to edit files that contain plain text.

```env
HERMES_API_KEY=ここにHermesのAPI_SERVER_KEYと同じ値を設定
```

Replace everything to the right of `=` with the same value as the Hermes `API_SERVER_KEY`.

For example, if the Hermes API key is `example-secret-key`, use:

```env
HERMES_API_KEY=example-secret-key
```

Save `.env` after making the change.

Treat the API key like a password. Do not send `.env` to other people or publish its contents.

## 5. Prepare the Frontend

![Hamuko preparing and starting Avatar Gateway](docs/images/quickstart_start.png)

The first time you set up Avatar Gateway, prepare the browser interface. Run these commands one line at a time:

```bash
cd frontend
npm ci
npm run build
cd ..
```

Each command has a purpose:

1. `cd frontend` moves into the folder containing the browser interface.
2. `npm ci` downloads the software parts needed by the interface. The first installation may take some time.
3. `npm run build` creates the files that the backend serves under `frontend/dist`.
4. `cd ..` returns to the Avatar Gateway folder.

You do not need to repeat this preparation every time you start Avatar Gateway. Repeat this step after updating the Avatar Gateway source code.

## 6. Start the Backend

In the same terminal, run the following commands one line at a time:

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m app
```

Each command has a purpose:

1. `cd backend` moves into the backend folder.
2. `python3 -m venv .venv` creates a separate Python environment for Avatar Gateway. This prevents its software parts from getting mixed with those of other Python programs.
3. `.venv/bin/pip install -r requirements.txt` downloads the software parts required by the backend. The first installation may take some time.
4. `.venv/bin/python -m app` starts the backend.

After the last command, the terminal displays status messages and does not return to the usual command prompt. This is normal. Keep this terminal open while using Avatar Gateway.

The backend normally waits at this address:

```text
http://127.0.0.1:8000
```

## 7. Open Avatar Gateway in a Browser

![Hamuko celebrating a successful first conversation](docs/images/quickstart_success.png)

Open Firefox, Google Chrome, Microsoft Edge, or another compatible browser. Enter this address in the browser’s address bar:

```text
http://127.0.0.1:8000
```

An address tells the browser where to connect.

When you see the avatar and the text input box, send a short message such as:

```text
Hello
```

Setup is complete when a reply from Hermes appears.

Speech output and microphone input are disabled in the initial settings. It is normal to see a text reply without hearing any sound.

## How to Stop

In the terminal running the backend, hold the `Ctrl` key and press the `C` key. This key combination is written as `Ctrl+C`.

Closing the browser page may leave the backend running. Stop it in the terminal when you are finished.

## Starting Avatar Gateway Next Time

The first-time setup is now complete, so you do not need to install the software parts every time.

Open the Avatar Gateway folder and run:

```bash
cd backend
.venv/bin/python -m app
```

Then open `http://127.0.0.1:8000` in your browser.

## If Something Does Not Work

### The Page Does Not Open

Make sure the terminal that started the backend is still running. If it has stopped, run `.venv/bin/python -m app` again.

### Avatar Gateway Cannot Connect to Hermes

Check the following items in order:

1. Hermes is running.
2. The Hermes API Server is enabled.
3. `HERMES_API_KEY` in `.env` exactly matches `API_SERVER_KEY` in Hermes.
4. `HERMES_BASE_URL` in `.env` is `http://127.0.0.1:8642/v1`.

Uppercase and lowercase letters are treated as different characters. The API keys must match exactly, including any spaces.

### You Need More Error Information

Open this address in your browser:

```text
http://127.0.0.1:8000/api/health
```

This page shows the connection status detected by Avatar Gateway. Here, `health` means information used to check whether a program is working correctly.

If the problem remains, check the error messages in the terminal that started the backend. An error message is text that reports the cause of a problem.

## Adding Speech and Other Features

After text chat works, you can add speech output, microphone input, and image generation. You can also configure Hermes Profiles, which separate Hermes settings by purpose, or use Avatar Gateway from another device on your home network, also called a LAN.

See the full [README](README.en.md) for detailed setup and usage instructions.
