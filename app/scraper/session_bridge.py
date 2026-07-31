"""Local HTTP bridge so the Chrome extension can export live session cookies.

Chrome holds an exclusive lock on its Cookies SQLite DB while running, so Python
cannot read HttpOnly auth cookies from disk. The MV3 extension uses
chrome.cookies (live session API) and POSTs them here.
"""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable
from urllib.parse import urlparse


BRIDGE_HOST = "127.0.0.1"
BRIDGE_PORT = 8765


class SessionBridge:
    def __init__(self, platform: str, on_export: Callable[[str, list[dict]], dict[str, Any]]):
        self.platform = platform
        self.on_export = on_export
        self.done = threading.Event()
        self.result: dict[str, Any] | None = None
        self._httpd: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def base_url(self) -> str:
        return f"http://{BRIDGE_HOST}:{BRIDGE_PORT}"

    def start(self) -> None:
        bridge = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, fmt: str, *args) -> None:  # noqa: A003
                return

            def _json(self, code: int, payload: dict) -> None:
                body = json.dumps(payload).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.end_headers()
                self.wfile.write(body)

            def do_OPTIONS(self) -> None:  # noqa: N802
                self._json(200, {"ok": True})

            def do_GET(self) -> None:  # noqa: N802
                path = urlparse(self.path).path
                if path == "/pending":
                    if bridge.done.is_set():
                        self._json(200, {"platform": None, "done": True})
                    else:
                        self._json(200, {"platform": bridge.platform, "done": False})
                    return
                if path == "/health":
                    self._json(200, {"ok": True, "platform": bridge.platform})
                    return
                self._json(404, {"ok": False, "error": "not_found"})

            def do_POST(self) -> None:  # noqa: N802
                path = urlparse(self.path).path
                if path != "/export":
                    self._json(404, {"ok": False, "error": "not_found"})
                    return
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b"{}"
                try:
                    payload = json.loads(raw.decode("utf-8"))
                except json.JSONDecodeError:
                    self._json(400, {"ok": False, "error": "invalid_json"})
                    return

                platform = str(payload.get("platform") or "").strip()
                cookies = payload.get("cookies") or []
                if platform != bridge.platform:
                    self._json(409, {"ok": False, "error": "platform_mismatch"})
                    return
                if not isinstance(cookies, list) or not cookies:
                    self._json(400, {"ok": False, "error": "no_cookies"})
                    return

                try:
                    result = bridge.on_export(platform, cookies)
                except Exception as e:  # noqa: BLE001
                    self._json(500, {"ok": False, "error": str(e)})
                    return

                bridge.result = result
                bridge.done.set()
                self._json(200, result)

        class ReusableServer(ThreadingHTTPServer):
            allow_reuse_address = True

        self._httpd = ReusableServer((BRIDGE_HOST, BRIDGE_PORT), Handler)
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()

    def wait(self, timeout_sec: float) -> dict[str, Any] | None:
        self.done.wait(timeout=timeout_sec)
        return self.result

    def stop(self) -> None:
        if self._httpd is not None:
            self._httpd.shutdown()
            self._httpd.server_close()
            self._httpd = None
        if self._thread is not None:
            self._thread.join(timeout=2)
            self._thread = None
