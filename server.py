"""
Hybrid Agent Engine — local WebSocket bridge

Run with:
    python terminal_bridge.py

The bridge listens on ws://127.0.0.1:8765 and provides:
- terminal execution inside the selected workspace
- a native workspace picker (useful on browsers such as Firefox that do not
  expose window.showDirectoryPicker())
- workspace file read/write fallback for browsers without the File System
  Access API
"""

import asyncio
import base64
import json
import os
import secrets
import re
import subprocess
import shutil
import urllib.request
import urllib.error
import urllib.parse
import uuid
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import threading

import websockets

APP_DIR = os.path.dirname(os.path.abspath(__file__))
HTTP_HOST = "127.0.0.1"
HTTP_PORT = int(os.environ.get("REX_HTTP_PORT", "3456"))
CLOUDFLARED_DOWNLOAD_URL = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
REMOTE_ACCESS_TOKEN = None
CLOUDFLARED_PROCESS = None
CLOUDFLARED_URL = None
CLOUDFLARED_OUTPUT_THREAD = None
CLOUDFLARED_LOG = []
REMOTE_ACCESS_LOCK = threading.Lock()
DEFAULT_WORKSPACE_DIR = os.environ.get("REX_WORKSPACE", os.path.abspath(os.getcwd()))
WORKSPACE_DIR = DEFAULT_WORKSPACE_DIR
WORKSPACE_LOCK = threading.Lock()
API_KEY_FILENAMES = ["API Keys.txt", "API_Keys.txt", "api keys.txt", "api_keys.txt"]
# Deliberately obvious fallback. Replace this if you want a built-in Gemini key.
GEMINI_FALLBACK_KEY = "REPLACE---ME----WITH----YOUR----GEMINI----KEY"


def parse_api_keys(text):
    aliases = {
        "gemini": "gemini",
        "antigravity": "antigravity",
        "antigravity api key": "antigravity",
        "google antigravity": "antigravity",
        "google gemini": "gemini",
        "open router": "openrouter",
        "openrouter": "openrouter",
        "openrouter api key": "openrouter",
        "open code": "openrouter",
        "opencode": "openrouter",
        "open code api key": "openrouter",
        "exa": "exa",
        "exa search": "exa",
        "groqcloud": "groq",
        "groq": "groq",
        "openrouter model": "openrouterModel",
        "pollinations": "pollinations",
        "pollinations api key": "pollinations",
        "pollinations model": "pollinationsModel",
    }
    result = {}
    pending_key = None
    for raw_line in str(text or "").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or line.startswith("//"):
            continue
        if ":" in line:
            label, value = line.split(":", 1)
            key = aliases.get(label.strip().lower())
            value = value.strip()
            if key:
                if value:
                    result[key] = value
                    pending_key = None
                else:
                    pending_key = key
                continue
        if pending_key:
            result[pending_key] = line
            pending_key = None
    return result


def find_api_key_file():
    for filename in API_KEY_FILENAMES:
        path = os.path.join(APP_DIR, filename)
        if os.path.isfile(path):
            try:
                with open(path, "r", encoding="utf-8-sig") as f:
                    return filename, parse_api_keys(f.read())
            except OSError:
                return filename, {}
    return None, {}


def get_workspace():
    with WORKSPACE_LOCK:
        return WORKSPACE_DIR



class RexHTTPHandler(SimpleHTTPRequestHandler):
    def _is_sensitive_path(self):
        name = os.path.basename(urllib.parse.unquote(urllib.parse.urlparse(self.path).path)).lower()
        return name in {
            "api keys.txt", "api_keys.txt", "api_keys.txt.example",
            "server.py", "run.ps1", "cloudflared.ps1", "cloudflared.exe"
        } or name.startswith(".")

    def do_GET(self):
        if self._is_sensitive_path():
            self.send_error(404)
            return
        super().do_GET()

    def end_headers(self):
        path = urllib.parse.urlparse(self.path).path.lower()
        if path.endswith(('.html', '.js', '.css', '.ico')):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/api/bridge":
            self.send_error(404)
            return
        token = self.headers.get("X-Rex-Access-Token", "")
        with REMOTE_ACCESS_LOCK:
            expected = REMOTE_ACCESS_TOKEN
        if not expected or not secrets.compare_digest(token, expected):
            self.send_error(401, "Rex remote access code required")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 30 * 1024 * 1024:
                raise ValueError("Invalid request size.")
            raw = self.rfile.read(length)
            data = json.loads(raw.decode("utf-8"))
            if not isinstance(data, dict):
                raise ValueError("JSON object required.")
            result = asyncio.run(handle_message(data))
            payload = json.dumps(result).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception as exc:
            payload = json.dumps({"ok": False, "error": str(exc)}).encode("utf-8")
            self.send_response(400)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    def log_message(self, format, *args):
        if not (str(args[0]).startswith("GET /api/") or str(args[0]).startswith("POST /api/")):
            super().log_message(format, *args)


def start_http_server():
    server = ThreadingHTTPServer((HTTP_HOST, HTTP_PORT), partial(RexHTTPHandler, directory=APP_DIR))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    print(f"  Web app:    http://localhost:{HTTP_PORT}/index.html")
    return server

def _windows_drives():
    if os.name != "nt":
        return [os.path.abspath(os.sep)]
    drives = []
    for code in range(ord("A"), ord("Z") + 1):
        drive = f"{chr(code)}:\\"
        if os.path.isdir(drive):
            drives.append(drive)
    return drives


def _normalize_browse_path(path):
    raw = str(path or "").strip()
    if os.name == "nt" and not raw:
        return None
    if os.name != "nt" and not raw:
        return os.path.abspath(os.sep)
    candidate = os.path.abspath(os.path.expanduser(raw))
    if not os.path.isdir(candidate):
        raise FileNotFoundError("Folder not found.")
    return candidate


def browse_workspace(path=""):
    current = _normalize_browse_path(path)
    if current is None:
        entries = []
        for drive in _windows_drives():
            entries.append({"name": drive.rstrip("\\/"), "path": drive, "type": "drive"})
        return {"ok": True, "path": "", "name": "This PC", "parent": None, "entries": entries}

    entries = []
    try:
        children = list(os.scandir(current))
    except OSError as exc:
        raise RuntimeError(f"Could not read folder: {exc}") from exc
    for item in children:
        try:
            if item.is_dir(follow_symlinks=False):
                entries.append({"name": item.name, "path": item.path, "type": "folder"})
        except OSError:
            continue
    entries.sort(key=lambda item: item["name"].lower())
    parent = os.path.dirname(current)
    if os.name == "nt" and os.path.splitdrive(current)[1] in ("\\", "/"):
        parent = ""
    elif parent == current:
        parent = ""
    return {
        "ok": True,
        "path": current,
        "name": os.path.basename(current.rstrip(os.sep)) or current,
        "parent": parent,
        "entries": entries,
    }


def select_workspace(path):
    global WORKSPACE_DIR
    candidate = _normalize_browse_path(path)
    if candidate is None:
        raise ValueError("Select a folder first.")
    with WORKSPACE_LOCK:
        WORKSPACE_DIR = candidate
    return get_workspace()


def create_workspace_folder(parent_path, name):
    parent = _normalize_browse_path(parent_path)
    if parent is None:
        raise ValueError("Open a drive or folder before creating a folder.")

    folder_name = str(name or "").strip()
    if not folder_name:
        raise ValueError("Folder name is required.")
    if folder_name in {".", ".."} or any(ch in folder_name for ch in '<>:\"/\\|?*'):
        raise ValueError("That is not a valid folder name.")
    if folder_name.endswith((".", " ")):
        raise ValueError("Folder names cannot end with a dot or space on Windows.")

    candidate = os.path.abspath(os.path.join(parent, folder_name))
    if os.path.commonpath([parent, candidate]) != parent:
        raise PermissionError("Folder path escapes the current picker location.")
    try:
        os.mkdir(candidate)
    except FileExistsError:
        raise FileExistsError(f'A folder named "{folder_name}" already exists.')
    except OSError as exc:
        raise RuntimeError(f"Could not create folder: {exc}") from exc
    return {"ok": True, "path": candidate, "name": folder_name, "type": "folder"}


def safe_workspace_path(relative_path):
    if not isinstance(relative_path, str) or not relative_path.strip():
        raise ValueError("A workspace-relative path is required.")

    root = os.path.abspath(get_workspace())
    candidate = os.path.abspath(os.path.join(root, relative_path.replace("/", os.sep)))
    if os.path.commonpath([root, candidate]) != root:
        raise PermissionError("Path escapes the selected workspace.")
    return candidate


def read_workspace_file(relative_path):
    path = safe_workspace_path(relative_path)
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def write_workspace_file(relative_path, content):
    path = safe_workspace_path(relative_path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(content)


def _cloudflared_path():
    local = os.path.join(APP_DIR, "cloudflared.exe")
    if os.path.isfile(local):
        return local
    found = shutil.which("cloudflared") or shutil.which("cloudflared.exe")
    return found


def ensure_cloudflared():
    existing = _cloudflared_path()
    if existing:
        return existing

    # Keep the download logic in the user-editable PowerShell helper.
    # This lets Rex recover automatically when cloudflared.exe is missing.
    helper = os.path.join(APP_DIR, "cloudflare.ps1")
    if not os.path.isfile(helper):
        raise RuntimeError("cloudflare.ps1 is missing from the Rex folder.")

    powershell = shutil.which("pwsh") or shutil.which("powershell") or "powershell.exe"
    try:
        result = subprocess.run(
            [powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helper],
            cwd=APP_DIR,
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
        )
    except Exception as exc:
        raise RuntimeError(f"Could not run ./cloudflare.ps1: {exc}") from exc

    existing = _cloudflared_path()
    if existing:
        return existing

    details = (result.stderr or result.stdout or "").strip()
    raise RuntimeError(
        "cloudflare.ps1 ran, but cloudflared.exe was not found."
        + (f"\n\n{details}" if details else "")
    )


def _watch_cloudflared_output(process):
    global CLOUDFLARED_URL, CLOUDFLARED_LOG
    pattern = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com", re.I)
    try:
        for line in iter(process.stdout.readline, ""):
            match = pattern.search(line)
            if match:
                with REMOTE_ACCESS_LOCK:
                    CLOUDFLARED_URL = match.group(0)
            if line:
                clean = line.rstrip()
                with REMOTE_ACCESS_LOCK:
                    CLOUDFLARED_LOG.append(clean)
                    del CLOUDFLARED_LOG[:-40]
                print("[cloudflared] " + clean)
    except Exception:
        pass


def start_remote_access():
    global REMOTE_ACCESS_TOKEN, CLOUDFLARED_PROCESS, CLOUDFLARED_OUTPUT_THREAD, CLOUDFLARED_URL, CLOUDFLARED_LOG
    with REMOTE_ACCESS_LOCK:
        if CLOUDFLARED_PROCESS and CLOUDFLARED_PROCESS.poll() is None and CLOUDFLARED_URL:
            return {"ok": True, "url": CLOUDFLARED_URL, "accessCode": REMOTE_ACCESS_TOKEN, "shareUrl": f"{CLOUDFLARED_URL}/#access={urllib.parse.quote(REMOTE_ACCESS_TOKEN, safe='')}"}
        REMOTE_ACCESS_TOKEN = secrets.token_urlsafe(18)
        CLOUDFLARED_URL = None
        CLOUDFLARED_LOG = []

    exe = ensure_cloudflared()
    try:
        process = subprocess.Popen(
            [exe, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{HTTP_PORT}"],
            cwd=APP_DIR, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace",
        )
    except Exception as exc:
        with REMOTE_ACCESS_LOCK:
            REMOTE_ACCESS_TOKEN = None
        raise RuntimeError(f"Could not start cloudflared: {exc}") from exc

    with REMOTE_ACCESS_LOCK:
        CLOUDFLARED_PROCESS = process
    CLOUDFLARED_OUTPUT_THREAD = threading.Thread(target=_watch_cloudflared_output, args=(process,), daemon=True)
    CLOUDFLARED_OUTPUT_THREAD.start()

    for _ in range(120):
        with REMOTE_ACCESS_LOCK:
            url = CLOUDFLARED_URL
        if url:
            return {"ok": True, "url": url, "accessCode": REMOTE_ACCESS_TOKEN, "shareUrl": f"{url}/#access={urllib.parse.quote(REMOTE_ACCESS_TOKEN, safe='')}"}
        if process.poll() is not None:
            with REMOTE_ACCESS_LOCK:
                details = "\n".join(CLOUDFLARED_LOG[-12:])
            raise RuntimeError("cloudflared exited before creating a Quick Tunnel." + (f"\n\n{details}" if details else ""))
        threading.Event().wait(0.25)
    process.terminate()
    with REMOTE_ACCESS_LOCK:
        details = "\n".join(CLOUDFLARED_LOG[-12:])
    raise RuntimeError("Timed out waiting for Cloudflare to create the public URL." + (f"\n\n{details}" if details else ""))


def stop_remote_access():
    global REMOTE_ACCESS_TOKEN, CLOUDFLARED_PROCESS, CLOUDFLARED_URL
    with REMOTE_ACCESS_LOCK:
        process = CLOUDFLARED_PROCESS
        CLOUDFLARED_PROCESS = None
        CLOUDFLARED_URL = None
        REMOTE_ACCESS_TOKEN = None
    if process and process.poll() is None:
        try:
            process.terminate()
            process.wait(timeout=5)
        except Exception:
            try:
                process.kill()
            except Exception:
                pass
    return {"ok": True}


def remote_access_status():
    with REMOTE_ACCESS_LOCK:
        running = bool(CLOUDFLARED_PROCESS and CLOUDFLARED_PROCESS.poll() is None and CLOUDFLARED_URL)
        return {"ok": True, "running": running, "url": CLOUDFLARED_URL if running else None, "accessCode": REMOTE_ACCESS_TOKEN if running else None}



def generate_image(prompt, model="flux", width=1024, height=1024):
    """Generate an image through Pollinations without exposing its secret key to the browser."""
    _, keys = find_api_key_file()
    api_key = keys.get("pollinations")
    if not api_key or api_key.startswith("YOUR_"):
        raise RuntimeError("Pollinations API key is not configured in API_Keys.txt.")

    model = str(keys.get("pollinationsModel") or model or "flux").strip()
    try:
        width = max(256, min(2048, int(width)))
        height = max(256, min(2048, int(height)))
    except (TypeError, ValueError):
        width, height = 1024, 1024

    encoded_prompt = urllib.parse.quote(str(prompt).strip(), safe="")
    params = urllib.parse.urlencode({"model": model, "width": width, "height": height, "nologo": "true"})
    url = f"https://gen.pollinations.ai/image/{encoded_prompt}?{params}"
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {api_key}", "User-Agent": "Rex-AI/1.0"})
    with urllib.request.urlopen(request, timeout=180) as response:
        content_type = response.headers.get_content_type() or "image/jpeg"
        data = response.read()

    ext = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/svg+xml": ".svg"}.get(content_type, ".jpg")
    out_dir = os.path.join(APP_DIR, "generated_images")
    os.makedirs(out_dir, exist_ok=True)
    filename = f"rex_{uuid.uuid4().hex}{ext}"
    path = os.path.join(out_dir, filename)
    with open(path, "wb") as f:
        f.write(data)
    return {"url": f"/generated_images/{filename}", "model": model, "width": width, "height": height, "contentType": content_type}


def _api_key(name, override=None):
    value = str(override or '').strip()
    if not value:
        _, keys = find_api_key_file()
        value = str(keys.get(name) or '').strip()
    if name == 'gemini' and (not value or value.startswith('YOUR_') or value.startswith('REPLACE---ME')):
        value = GEMINI_FALLBACK_KEY
    if not value or value.startswith('YOUR_') or value.startswith('REPLACE---ME'):
        raise RuntimeError(f'{name.capitalize()} API key is not configured.')
    return value


def transcribe_audio(audio_b64, mime_type='audio/webm'):
    api_key = _api_key('groq')
    try:
        audio = base64.b64decode(str(audio_b64), validate=True)
    except Exception as exc:
        raise ValueError(f'Invalid audio data: {exc}') from exc
    if not audio:
        raise ValueError('The recorded audio is empty.')
    if len(audio) > 25 * 1024 * 1024:
        raise ValueError('Audio file is too large for Groq Whisper (25 MB maximum).')

    mime_type = str(mime_type or 'audio/webm').split(';', 1)[0].strip() or 'audio/webm'
    ext = {'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/mp4': '.mp4', 'audio/mpeg': '.mp3'}.get(mime_type, '.webm')
    boundary = f'----RexAI{uuid.uuid4().hex}'
    chunks = []
    def field(name, value):
        chunks.extend([
            f'--{boundary}\r\n'.encode(),
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
            str(value).encode(), b'\r\n'
        ])
    field('model', 'whisper-large-v3')
    field('language', 'en')
    field('temperature', '0')
    field('prompt', 'English voice dictation for an AI chatbot. Technical terms may include AI, chatbot, code, coding, Python, JavaScript, HTML, CSS, API, Groq, Gemini, and Cloudflare.')
    field('response_format', 'json')
    chunks.extend([
        f'--{boundary}\r\n'.encode(),
        f'Content-Disposition: form-data; name="file"; filename="recording{ext}"\r\n'.encode(),
        f'Content-Type: {mime_type}\r\n\r\n'.encode(),
        audio, b'\r\n', f'--{boundary}--\r\n'.encode()
    ])
    request = urllib.request.Request(
        'https://api.groq.com/openai/v1/audio/transcriptions',
        data=b''.join(chunks),
        headers={
            'Authorization': f'Bearer {api_key}',
            'Content-Type': f'multipart/form-data; boundary={boundary}',
            'User-Agent': 'Rex-AI/1.0',
        },
        method='POST',
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            payload = json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode('utf-8', errors='replace')[:1000]
        raise RuntimeError(f'Groq Whisper request failed ({exc.code}): {detail}') from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f'Could not reach Groq Whisper: {exc.reason}') from exc
    text = str(payload.get('text') or '').strip()
    if not text:
        raise RuntimeError('Groq Whisper returned an empty transcript.')
    return text


def synthesize_speech(text, api_key=None):
    api_key = _api_key('gemini', api_key)
    text = str(text or '').strip()
    if not text:
        raise ValueError('There is no text to synthesize.')
    if len(text) > 10000:
        raise ValueError('Text is too long for one TTS request.')

    # Gemini 3.8 TTS expects the transcript itself as the text input.
    # Wrapping it in "Say exactly..." can cause the TTS model to vocalize a
    # generated response instead of the requested transcript (for example,
    # the old Rex build could end up saying "Thank you.").
    models = ['gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview']
    last_error = None
    for model in models:
        url = f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent'
        payload = {
            'contents': [{'role': 'user', 'parts': [{
                'text': text,
                'speech_metadata': {'style': 'natural, clear, conversational'}
            }]}],
            'generationConfig': {
                'responseModalities': ['AUDIO'],
                'responseFormat': {'audio': {'mimeType': 'AUDIO_L16', 'sampleRate': 24000}},
                'speechConfig': {
                    'voiceConfig': {'prebuiltVoiceConfig': {'voiceName': 'Kore'}},
                    'languageCode': 'en-US',
                },
            },
        }
        request = urllib.request.Request(
            url, data=json.dumps(payload).encode('utf-8'),
            headers={'Content-Type': 'application/json', 'x-goog-api-key': api_key, 'User-Agent': 'Rex-AI/1.0'},
            method='POST'
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                result = json.loads(response.read().decode('utf-8'))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode('utf-8', errors='replace')[:1200]
            last_error = RuntimeError(f'Gemini TTS request failed ({exc.code}): {detail}')
            if exc.code in (400, 403, 404) and model != models[-1]:
                continue
            raise last_error from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f'Could not reach Gemini TTS: {exc.reason}') from exc

        parts = (((result.get('candidates') or [{}])[0].get('content') or {}).get('parts') or [])
        audio_part = next((part.get('inlineData') or part.get('inline_data') for part in parts if part.get('inlineData') or part.get('inline_data')), None)
        if not audio_part or not audio_part.get('data'):
            raise RuntimeError(f'Gemini TTS model {model} returned no audio data.')
        return {'audio': audio_part['data'], 'mimeType': audio_part.get('mimeType') or 'audio/L16;rate=24000'}

    raise last_error or RuntimeError('Gemini TTS failed.')


async def run_antigravity(prompt, api_key=None):
    """Run Google's local Antigravity agent against Rex's selected workspace."""
    workspace = get_workspace()
    if not workspace or not os.path.isdir(workspace):
        raise RuntimeError('Attach a workspace before using Antigravity.')
    key = str(api_key or '').strip()
    if not key:
        _, keys = find_api_key_file()
        key = str(keys.get('antigravity') or '').strip()
    if not key or key.startswith('YOUR_') or key.startswith('REPLACE---ME'):
        raise RuntimeError('Antigravity API key is not configured. Add Antigravity: ... to API Keys.txt or Rex Settings.')

    try:
        from google.antigravity import Agent, LocalAgentConfig
        from google.antigravity.hooks import policy
    except ImportError as exc:
        raise RuntimeError('Antigravity SDK is not installed. Run: python -m pip install -r requirements.txt') from exc

    old_key = os.environ.get('GEMINI_API_KEY')
    os.environ['GEMINI_API_KEY'] = key
    try:
        config = LocalAgentConfig(
            workspaces=[workspace],
            policies=[policy.allow_all()],
            system_instructions=(
                'You are Antigravity inside Rex AI. Work directly in the selected Rex workspace. '
                'You are a full autonomous coding agent: inspect files, edit files, run commands, use web tools, '
                'and complete multi-step tasks instead of merely explaining them. Keep all file work scoped to the '
                'provided workspace. Be concise in your final response.'
            ),
        )
        async with Agent(config) as agent:
            response = await agent.chat(str(prompt or ''))
            return {'ok': True, 'text': await response.text(), 'workspace': workspace}
    finally:
        if old_key is None:
            os.environ.pop('GEMINI_API_KEY', None)
        else:
            os.environ['GEMINI_API_KEY'] = old_key


async def handle_message(data):
    global WORKSPACE_DIR
    action = data.get("action") or data.get("type") or "terminal"

    if action == "remote_access_start":
        try:
            return await asyncio.to_thread(start_remote_access)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    if action == "remote_access_stop":
        return await asyncio.to_thread(stop_remote_access)

    if action == "remote_access_status":
        return remote_access_status()

    if action == "ping":
        return {"ok": True, "workspace": get_workspace()}

    if action in {"pick_workspace", "choose_workspace"}:
        return await asyncio.to_thread(browse_workspace, data.get("path", ""))

    if action == "workspace_browse":
        try:
            return await asyncio.to_thread(browse_workspace, data.get("path", ""))
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    if action == "workspace_mkdir":
        try:
            return await asyncio.to_thread(create_workspace_folder, data.get("path", ""), data.get("name", ""))
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    if action == "workspace_select":
        try:
            workspace = await asyncio.to_thread(select_workspace, data.get("path", ""))
            return {
                "ok": True,
                "workspace": workspace,
                "workspaceName": os.path.basename(workspace.rstrip(os.sep)) or workspace,
            }
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    if action == "load_api_keys":
        filename, keys = await asyncio.to_thread(find_api_key_file)
        return {"ok": True, "fileName": filename, "keys": keys}

    if action == "read_file":
        try:
            return {"ok": True, "content": await asyncio.to_thread(read_workspace_file, data.get("path", ""))}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    if action == "generate_image":
        try:
            result = await asyncio.to_thread(generate_image, data.get("prompt", ""), data.get("model", "flux"), data.get("width", 1024), data.get("height", 1024))
            return {"ok": True, **result}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    if action == "stt":
        try:
            text = await asyncio.to_thread(transcribe_audio, data.get("audio", ""), data.get("mimeType", "audio/webm"))
            return {"ok": True, "text": text}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    if action == "tts":
        try:
            result = await asyncio.to_thread(synthesize_speech, data.get("text", ""), data.get("apiKey"))
            return {"ok": True, **result}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    if action == "write_file":
        try:
            await asyncio.to_thread(write_workspace_file, data.get("path", ""), data.get("content", ""))
            return {"ok": True}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    if action == "antigravity":
        try:
            return await run_antigravity(data.get("prompt", ""), data.get("apiKey"))
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    if action == "terminal":
        command = str(data.get("command", "")).strip()
        if not command:
            return {"error": "No command provided."}

        cwd = get_workspace()
        print(f"[EXECUTING via pwsh in {cwd}]: {command}")
        pwsh = shutil.which("pwsh")
        if not pwsh:
            return {"error": "PowerShell 7 (pwsh.exe) was not found on PATH. Install PowerShell 7 and restart the bridge.", "returncode": -1}
        try:
            process = await asyncio.to_thread(
                subprocess.Popen,
                [pwsh, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
                cwd=cwd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            stdout, stderr = await asyncio.to_thread(process.communicate, timeout=120)
            return {"stdout": stdout, "stderr": stderr, "returncode": process.returncode, "workspace": cwd}
        except subprocess.TimeoutExpired:
            process.kill()
            await asyncio.to_thread(process.communicate)
            return {"error": "Command timed out after 120 seconds.", "returncode": -1}
        except Exception as exc:
            return {"error": str(exc)}

    return {"error": f"Unknown bridge action: {action}"}


async def handle_client(websocket):
    async for message in websocket:
        try:
            data = json.loads(message)
            result = await handle_message(data)
        except json.JSONDecodeError:
            result = {"error": "Invalid JSON payload."}
        except Exception as exc:
            result = {"error": str(exc)}
        if isinstance(data, dict) and data.get("requestId"):
            result["requestId"] = data["requestId"]
        await websocket.send(json.dumps(result))


async def main():
    print("=" * 60)
    print("  Hybrid Agent Engine — Terminal / Workspace Bridge")
    print("  Listening on ws://127.0.0.1:8765")
    print(f"  Workspace: {get_workspace()}")
    api_file, _ = find_api_key_file()
    print(f"  API keys:  {api_file or 'built-in / IndexedDB'}")
    print("=" * 60)
    http_server = start_http_server()
    async with websockets.serve(handle_client, "127.0.0.1", 8765):
        try:
            await asyncio.Future()
        finally:
            stop_remote_access()
            http_server.shutdown()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nRex stopped.")
