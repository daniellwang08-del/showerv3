#!/usr/bin/env python3
"""
Startup script for the FastAPI API server.

Uses uvicorn --reload in local development so Python changes under app/ are picked
up automatically. Set RELOAD=0 to disable, or APP_ENV=production (reload off by default).

On Windows, reload spawns a child process that imports app.main (which sets the
Proactor event loop policy before asyncio is used), so Playwright still works.
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


def _env_flag(name: str, default: str) -> bool:
    return os.environ.get(name, default).lower() in ("1", "true", "yes")


def _reload_enabled() -> bool:
    app_env = os.environ.get("APP_ENV", "local").lower()
    default = "0" if app_env == "production" else "1"
    return _env_flag("RELOAD", default)


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", 8000))
    use_reload = _reload_enabled()
    reload_dirs = [str(ROOT / "app")]

    if use_reload:
        print(f"[reload] Watching {reload_dirs[0]} — save a file to restart the API.")
    else:
        print("[reload] Disabled (set RELOAD=1 or APP_ENV=local to enable).")

    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=port,
        reload=use_reload,
        reload_dirs=reload_dirs if use_reload else None,
    )
