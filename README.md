# Rex AI

Browser AI agent with cloud providers (Groq, OpenRouter, Gemini), local WASM models, workspace tools, and a Python terminal bridge.

## Quick start

```bash
# Install (optional, for esbuild)
npm install

# Build frontend bundle
npm run build

# Run server (serves UI + WebSocket bridge)
python server.py
# or
./run.sh
```

Open `http://127.0.0.1:8765` (or the port printed by the server).

## Layout

```
index.html          # App shell
web/                # Static UI assets (CSS, extra HTML)
  styles.css
  404.html
modules/            # All frontend JavaScript (ES modules)
dist/               # esbuild output (dist/app.js)
rex_server/         # Python bridge (terminal, workspace, remote)
tests/              # JS + Python unit tests
terminal_blocklist.json
api_keys_schema.json
```

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run build` | Bundle `modules/main.js` → `dist/app.js` |
| `npm run check` | Syntax-check JS modules |
| `npm test` | check + build + frontend tests + Python tests |
| `npm run test:js` | Frontend tests only |
| `npm run test:py` | Python tests only |

## Features

- Multi-provider cloud chat + tools (terminal, files, web search, image gen, memory)
- Prompt library, chat search/rename, risk cards (type-to-confirm for high risk)
- Shared API key schema and terminal blocklist (JS + Python)
- Optional local WASM (wllama) model load
- Remote access via Cloudflare tunnel helpers

---

## Project notes (from previous README)

Rex AI is a Windows browser-based hybrid AI agent. It combines cloud LLMs, Exa web search, a PowerShell 7 terminal/workspace bridge, and Pollinations image generation.

## Providers

- **GroqCloud** — default `openai/gpt-oss-120b`
- **OpenRouter** — OpenAI-compatible; default `openai/gpt-oss-120b`
- **Google Gemini** — native Gemini API; default `gemini-3.6-flash`
- **Google Antigravity** — local autonomous agent; uses its own key and the currently attached Rex workspace
- **Exa** — current web search
- **Pollinations** — image generation; default image model `flux`

The old Cloudflare Workers AI, Unsloth, Hugging Face, and Cloudflare R2 settings are no longer part of Rex because they were not required by the current project.

## Image generation

Rex exposes a `generate_image` agent tool. When the user asks Rex to create/draw/generate an image, the selected cloud model can call this tool. The local Python bridge sends the request to Pollinations and stores the generated image under `generated_images/`, so a Pollinations secret key is not exposed to browser JavaScript.

Pollinations currently supports image generation through `https://gen.pollinations.ai/image/{prompt}` and `/v1/images/generations`. Its documentation says secret `sk_` keys are intended for server-side apps; free Pollen is available for prototypes/testing and can also be earned through quests.

## API_Keys.txt

Supported labels:

```text
Gemini: YOUR_GEMINI_API_KEY
OpenRouter: YOUR_OPENROUTER_API_KEY
OpenRouter model: openai/gpt-oss-120b
GroqCloud: YOUR_GROQ_API_KEY
Exa: YOUR_EXA_API_KEY
Pollinations: YOUR_POLLINATIONS_API_KEY
Pollinations model: flux
Antigravity: YOUR_ANTIGRAVITY_API_KEY
```

A Pollinations secret key should stay in `API_Keys.txt`; do not put it into frontend JavaScript.

## Start Rex

Python 3.10+ is required. On Windows, run `run.ps1` in PowerShell 7; on macOS/Linux, run `./run.sh`. The launcher creates a local virtual environment and installs `requirements.txt` when needed. The bridge serves the UI at `http://localhost:3456/index.html` and provides WebSocket workspace/terminal access on `127.0.0.1:8765`.

## Settings and model selection

The Settings screen is split into four sections:

- **General** — appearance (`System`, `Light`, or `Dark`) and the name Rex should call you.
- **API Keys** — upload a supported `API_Keys.txt` file or enter provider keys in the UI.
- **Model** — GroqCloud, OpenRouter, and Google Gemini each have their own model selector. Rex attempts to load the live model list from each provider when a key is configured, with the configured/default model retained as a fallback if the list cannot be loaded.
- **Credits** — acknowledges the creator and AI development tools used during development.

Model selections are stored independently, so changing the OpenRouter model does not change the GroqCloud or Gemini model.

## Runtime model identity

Before each cloud request, Rex adds authoritative runtime metadata to the system instructions containing the current provider and selected model. This prevents a model from simply assuming it is Gemini, GPT, or another model based on prior conversation text.

Rex also stores the last provider/model that successfully accessed each chat. When another provider takes over the same chat, the new model is told which provider and model accessed it previously.

## Storage

Chats, model selections, the selected provider, appearance, user-name preference, and entered provider settings are stored in browser IndexedDB. API keys stored there are not encrypted.

## Antigravity

Rex can run the Google Antigravity SDK as a separate full agent. Its credential is stored under the `Antigravity` key, separate from Rex's normal Gemini key. When Antigravity is selected, Rex passes the currently attached workspace to `LocalAgentConfig(workspaces=[...])`, allowing the agent to inspect/edit that workspace and use its built-in terminal and web tools.

Antigravity support requires `google-antigravity>=0.1.16`. The agent uses the Antigravity SDK's local workspace/tool runtime.

## Architecture

### Python backend modules

- `server.py` — backwards-compatible launcher and public helper exports.
- `rex_server/http_server.py` — local HTTP server and authenticated remote bridge endpoint.
- `rex_server/websocket_server.py` — WebSocket transport and request/response handling.
- `rex_server/bridge.py` — dispatches frontend bridge actions to backend services.
- `rex_server/terminal.py` — terminal command safety checks and command execution.
- `rex_server/workspace.py` — workspace selection and safe file operations.
- `rex_server/api_keys.py` — API-key file parsing and key resolution.
- `rex_server/media.py` — image generation, speech-to-text, and text-to-speech.
- `rex_server/agent.py` — optional Antigravity agent integration.
- `rex_server/remote_access.py` — Cloudflare remote access lifecycle and access-token checks.


Rex has three main layers: the browser frontend (`index.html`, `web/styles.css`, and `modules/main.js`), the local Python bridge (`server.py`), and a WebSocket connection used for workspace and terminal actions. The frontend entry point is `modules/main.js`, loaded as an ES module. The `modules/` modules separate shared state (`state.js`), IndexedDB persistence (`db.js`), WebSocket/remote transport (`ws.js`), provider configuration (`providers.js`), tool schemas (`tools.js`), and shared dialog primitives (`ui.js`). Shared helpers in the same `modules/` tree also handle API-key parsing, command-risk classification, Markdown rendering, and chat search/export serialization. The Python backend is split into `rex_server/api_keys.py` (key parsing), `workspace.py` (workspace browsing and safe file access), `terminal.py` (destructive-command checks), `remote_access.py` (Cloudflare tunnel lifecycle), `media.py` (image generation and speech APIs), and `agent.py` (Antigravity SDK integration). `server.py` remains the launch entry point and routes existing WebSocket actions to those modules. The frontend keeps transient runtime state in the `state` object. Browser persistence uses IndexedDB database `rex_ai_db`, with `settings` and `chats` stores; chat history also has a local-storage fallback for browsers where IndexedDB fails. Version 11 adds a `prompts` store for future saved-prompt functionality.

## Adding a provider

1. Add the provider's default model and key name to `src/state.js` and its model-selection defaults.
2. Add the provider's request and response handling in `modules/main.js` (or extract a dedicated adapter module), preserving streaming and abort behavior.
3. Add the provider to the model selector and API-key settings UI in `index.html` and update the settings save/load handlers.
4. Test missing keys, API errors, stream cancellation, and switching away from and back to the provider.

## Adding a tool

1. Define the tool schema in `src/tools.js` (and provider-specific schema if required).
2. Implement dispatch in `dispatchTool` in `modules/main.js` and validate all arguments before use.
3. If the tool needs local machine access, add a narrowly scoped action to `server.py`. Keep workspace paths inside the selected root, and never rely on frontend-only checks for security-sensitive operations.
4. Add tests for valid input, invalid input, and failure paths.

## Running tests

- Python tests: `python -m unittest discover -s tests -v` (or `pytest tests/` if pytest is installed).
- JavaScript syntax checks: `node --check modules/main.js` and `node --check modules/*.js`. Frontend tests: `npm run test:frontend`.
- On macOS/Linux, start Rex with `./run.sh`. On Windows, use `run.ps1`.

## Security notes

API key files are local secrets and must not be committed or shared. Keep `API Keys.txt` / `API_Keys.txt` out of archives sent to other people. The terminal bridge blocks a small set of highly destructive system commands server-side; this is a defense-in-depth guard, not a complete sandbox. Only enable remote access on networks and devices you trust.


## Memory

Rex supports editable long-term user memory in **Settings → Memory**. Memory entries are stored locally in IndexedDB, one entry per line, and can be edited or cleared by the user. The model can call the `update_memory` tool to add or remove stable, user-shared preferences, goals, and ongoing-project details. Avoid storing sensitive personal information unless the user explicitly asks. Memory is supplied as one section of the system context, not appended to each user message; stateless provider APIs receive that system context with each request.

---

## Build (esbuild)

# Rex AI frontend build (ESBuild)

Rex keeps its readable, modular source in `src/` and `modules/`. ESBuild bundles the browser entry point into `dist/app.js` before the server starts.

## Requirements

- Node.js and npm
- Python 3.10+ for the local server

## Build manually

```powershell
npm install
npm run build
npm run test
```

The launchers `run.ps1` and `run.sh` install the ESBuild dependency on first run (if missing), rebuild the bundle, and then start the Python server. The generated `dist/` and `node_modules/` folders are build artifacts and are not committed.

## Why source files remain separate

Keep editing `src/` and `modules/`; do not edit `dist/app.js` by hand. Each launch regenerates the bundle from source. Source maps are emitted alongside the bundle to make browser debugging easier. Node-only dynamic imports in the shared API-key parser are marked external and are only used by its Node.js test path; browser execution uses `fetch`.

---

## Audit notes

# Rex AI deep audit — 2026-10-24

## Confirmed defects fixed in this patch

1. **Startup crash in send.js**: `ctx.btnSend` was accessed at module-evaluation time. ES-module dependencies execute before `app.js` runs `assignCtx`, so the button reference was still undefined. Send-button wiring now occurs through `bindSendUI()` after context initialization.
2. **Startup crash in chat-controls.js**: New-chat/history/link listeners were attached at module scope before `ctx` was initialized. Those listeners now bind from `bindChatControls()`.
3. **Broken chat-history selection**: `chat-controls.js` assigned to imported `conversationHistory`, which is an immutable ES-module binding. Added `setConversationHistory()` in `chats.js` and use it instead.
4. **Missing shared context services**: `app.js` did not expose several functions expected by UI modules through `ctx` (including chat save/title, model settings, prompt rendering, recording and message helpers). They are now assigned after the DOM references are initialized and before UI bind functions run.
5. **Model settings ReferenceError**: `providerModelCache`, `providerModelRequests`, and `MODEL_CACHE_TTL` were declared inside `bindSettingsUI()` but used by `loadModelOptions()` outside that scope. They are now module-scoped.
6. **Image-only prompt blocked**: `sendMessage()` rejected an empty text field even when an image was attached. It now sends a default image-description prompt in that case.
7. **Existing frontend test mismatch**: the architecture test rejected the valid `defer` attribute on the module script. The assertion now accepts either form.

## Validation performed

- JavaScript syntax checks: passed.
- Frontend tests: 20/20 passed.
- Python backend tests: 14/14 passed.
- Python compilation: passed.
- Searched `src/` and `index.html` for `.closest(`; no such call exists in this uploaded archive. The reported `ev.target.closest is not a function` therefore appears to originate from a different/stale script or a browser-injected script, and cannot be attributed to source in this archive.

## Not claimed as verified

Automated tests do not prove every browser interaction works. A live browser smoke test is still needed for Settings, chat export/search, workspace selection, file/image uploads, Enter-to-send, and actual WebSocket bridge connection/reconnection. The “forced layout before page fully loaded” message is a performance warning and was not treated as a root-cause exception.

---

## Search and send fixes

# Rex AI search/send fixes

## Changes
- Prompt composer Enter handling now calls the explicitly wired `ctx.sendMessage` callback instead of an undefined global `sendMessage`.
- Search conversations opens with every saved chat listed, then filters live by chat title or message contents as the user types. It shows a message count, date, and first user-message preview.
- Selecting a search result opens the selected conversation through the same shared helper used by chat history.
- API-key auto-detection no longer makes HTTP requests for key files. Rex's HTTP server intentionally returns 404 for those sensitive files; key loading stays on the local bridge or via importing keys into IndexedDB.
- Updated a stale test assertion to allow the existing valid `defer` attribute on the module script.

## Validation
- JavaScript syntax check: passed.
- Frontend tests: 18/18 passed.
- Python backend tests: 14/14 passed.
- Total automated tests: 32 passed.

Live browser testing was not performed, so please smoke-test search, selecting a chat, Enter-to-send, and API-key loading after applying.

---
