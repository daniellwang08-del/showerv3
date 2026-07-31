"""Tests for the local session-export bridge."""

import json
import time
from urllib.request import Request, urlopen

from app.scraper.session_bridge import BRIDGE_PORT, SessionBridge


def test_bridge_pending_and_export():
    saved = {}

    def on_export(platform, cookies):
        saved["platform"] = platform
        saved["cookies"] = cookies
        return {"ok": True, "platform": platform, "cookie_count": len(cookies), "path": "x"}

    bridge = SessionBridge("rrs", on_export)
    try:
        bridge.start()
        time.sleep(0.1)

        with urlopen(f"http://127.0.0.1:{BRIDGE_PORT}/pending", timeout=2) as resp:
            pending = json.loads(resp.read().decode("utf-8"))
        assert pending["platform"] == "rrs"

        body = json.dumps(
            {
                "platform": "rrs",
                "cookies": [
                    {
                        "name": "session",
                        "value": "abc",
                        "domain": ".remoterocketship.com",
                        "path": "/",
                        "expires": -1,
                        "httpOnly": True,
                        "secure": True,
                        "sameSite": "Lax",
                    }
                ],
            }
        ).encode("utf-8")
        req = Request(
            f"http://127.0.0.1:{BRIDGE_PORT}/export",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(req, timeout=2) as resp:
            result = json.loads(resp.read().decode("utf-8"))
        assert result["ok"] is True
        assert saved["platform"] == "rrs"
        assert bridge.done.is_set()
    finally:
        bridge.stop()
