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
import json
import os
import subprocess
import shutil
import urllib.request
import urllib.parse
import uuid
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import threading
import tkinter as tk
from tkinter import filedialog

import websockets

APP_DIR = os.path.dirname(os.path.abspath(__file__))
HTTP_HOST = "127.0.0.1"
HTTP_PORT = int(os.environ.get("REX_HTTP_PORT", "8000"))
DEFAULT_WORKSPACE_DIR = os.environ.get("REX_WORKSPACE", os.path.abspath(os.getcwd()))
WORKSPACE_DIR = DEFAULT_WORKSPACE_DIR
WORKSPACE_LOCK = threading.Lock()
API_KEY_FILENAMES = ["API Keys.txt", "API_Keys.txt", "api keys.txt", "api_keys.txt"]


def parse_api_keys(text):
    aliases = {
        "gemini": "gemini",
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



def start_http_server():
    handler = partial(SimpleHTTPRequestHandler, directory=APP_DIR)
    server = ThreadingHTTPServer((HTTP_HOST, HTTP_PORT), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    print(f"  Web app:    http://localhost:{HTTP_PORT}/index.html")
    return server

def choose_workspace_native():
    global WORKSPACE_DIR
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        selected = filedialog.askdirectory(
            title="Select Hybrid Agent Engine workspace",
            initialdir=get_workspace() if os.path.isdir(get_workspace()) else os.getcwd(),
            mustexist=True,
        )
    finally:
        root.destroy()

    if selected:
        with WORKSPACE_LOCK:
            WORKSPACE_DIR = os.path.abspath(selected)
    return get_workspace()


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


async def handle_message(data):
    global WORKSPACE_DIR
    action = data.get("action") or data.get("type") or "terminal"

    if action == "ping":
        return {"ok": True, "workspace": get_workspace()}

    if action in {"pick_workspace", "choose_workspace"}:
        # tkinter must run on a normal thread so the asyncio event loop remains responsive.
        workspace = await asyncio.to_thread(choose_workspace_native)
        return {
            "ok": bool(workspace),
            "workspace": workspace,
            "workspaceName": os.path.basename(workspace.rstrip(os.sep)) if workspace else None,
        }

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

    if action == "write_file":
        try:
            await asyncio.to_thread(write_workspace_file, data.get("path", ""), data.get("content", ""))
            return {"ok": True}
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
            http_server.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
