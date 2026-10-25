"""Local HTTP server and authenticated remote bridge endpoint."""
import asyncio
import json
import os
import threading
import urllib.parse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from . import remote_access
from .api_keys import APP_DIR
from .bridge import handle_message

HTTP_HOST = "127.0.0.1"
HTTP_PORT = int(os.environ.get("REX_HTTP_PORT", "3456"))

class RexHTTPHandler(SimpleHTTPRequestHandler):
    def _is_sensitive_path(self):
        name = os.path.basename(urllib.parse.unquote(urllib.parse.urlparse(self.path).path)).lower()
        return name in {
            "api keys.txt", "api_keys.txt", "api_keys.txt.example",
            "server.py", "run.ps1", "cloudflared.ps1", "cloudflared.exe"
        } or name.startswith(".")

    def send_error(self, code, message=None, explain=None):
        """Show a branded 404 page for browser page navigations only.

        Missing scripts, stylesheets, API routes, and other assets keep the
        normal HTTP error response so the browser never receives HTML in place
        of a missing JavaScript or CSS file.
        """
        parsed = urllib.parse.urlparse(getattr(self, "path", "/"))
        path = urllib.parse.unquote(parsed.path or "/")
        accept = self.headers.get("Accept", "") if hasattr(self, "headers") else ""
        is_page_navigation = (
            code == 404
            and getattr(self, "command", "GET") == "GET"
            and "text/html" in accept.lower()
            and not path.startswith("/api/")
            and not os.path.splitext(os.path.basename(path))[1]
        )
        page_path = os.path.join(APP_DIR, "web", "404.html")
        if is_page_navigation and os.path.isfile(page_path):
            try:
                with open(page_path, "rb") as page:
                    payload = page.read()
                self.send_response(404, "Not Found")
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(payload)
                return
            except (OSError, ConnectionError):
                pass
        super().send_error(code, message, explain)

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
        if not remote_access.authorize_token(token):
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
