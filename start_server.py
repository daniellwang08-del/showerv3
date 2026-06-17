#!/usr/bin/env python3
"""
Startup script for the FastAPI API server.

Uses uvicorn --reload in local development so Python changes under app/ are picked
up automatically. Set RELOAD=0 to disable, or APP_ENV=production (reload off by default).

On Windows, reload spawns a child process that imports app.main (which sets the
Proactor event loop policy before asyncio is used), so Playwright still works.

We pass ``loop="none"`` to uvicorn. Without it, uvicorn's ``Config.setup_event_loop``
calls ``uvicorn.loops.asyncio.asyncio_setup(use_subprocess=True)`` whenever
``reload=True`` on Windows, which executes
``asyncio.set_event_loop_policy(WindowsSelectorEventLoopPolicy())`` and CLOBBERS
the Proactor policy we set above. The selector loop on Windows does not implement
``_make_subprocess_transport`` (it raises ``NotImplementedError`` from
``BaseEventLoop``), so Playwright's ``asyncio.create_subprocess_exec`` call to
spawn the Node driver fails with ``NotImplementedError`` and the browser pool
init aborts. With ``loop="none"`` uvicorn skips its own policy setup and our
Proactor policy survives, giving Playwright a working subprocess transport.
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent

if sys.platform == "win32":
    try:
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    except Exception:
        pass

sys.path.insert(0, str(ROOT))


def _reload_enabled() -> bool:
    from app.core.dev_reload import api_reload_enabled

    return api_reload_enabled()


def _api_host() -> str:
    """Host for Uvicorn.

    Local dev defaults to loopback so LAN clients use the Vite proxy on :5173 only.
    Set API_HOST=0.0.0.0 to expose the API directly on the network.
    """
    explicit = os.environ.get("API_HOST", "").strip()
    if explicit:
        return explicit
    if os.environ.get("APP_ENV", "local").lower() != "production":
        return "127.0.0.1"
    return "0.0.0.0"


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", 8000))
    host = _api_host()
    use_reload = _reload_enabled()
    reload_dirs = [str(ROOT / "app")]

    if use_reload:
        print(f"[reload] Watching {reload_dirs[0]} — save a file to restart the API.")
    else:
        print("[reload] Disabled (set RELOAD=1 or APP_ENV=local to enable).")
    if host == "127.0.0.1":
        print("[lan] API bound to 127.0.0.1 — other devices should use http://<your-ip>:5173 only.")

    uvicorn.run(
        "app.main:app",
        host=host,
        port=port,
        reload=use_reload,
        reload_dirs=reload_dirs if use_reload else None,
        # See module docstring: prevents uvicorn from overwriting our
        # Proactor policy with SelectorEventLoopPolicy on Windows+reload,
        # which would otherwise break Playwright's subprocess spawn.
        loop="none",
    )
