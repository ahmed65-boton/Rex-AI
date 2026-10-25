"""Cloudflare Quick Tunnel lifecycle management."""
import os
import re
import secrets
import shutil
import subprocess
import threading
import urllib.parse

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTTP_PORT = int(os.environ.get("REX_HTTP_PORT", "3456"))
CLOUDFLARED_DOWNLOAD_URL = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
REMOTE_ACCESS_TOKEN = None
CLOUDFLARED_PROCESS = None
CLOUDFLARED_URL = None
CLOUDFLARED_OUTPUT_THREAD = None
CLOUDFLARED_LOG = []
REMOTE_ACCESS_LOCK = threading.Lock()


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



def authorize_token(token):
    """Validate a remote bridge token without exposing it to callers."""
    import hmac
    with REMOTE_ACCESS_LOCK:
        expected = REMOTE_ACCESS_TOKEN
    return bool(expected and hmac.compare_digest(str(token or ""), expected))
