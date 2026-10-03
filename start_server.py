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

Hot reload watches **app/** Python files only. Uvicorn's WatchFiles backend also
observes the project root; we narrow that with reload_includes/reload_excludes so
saving start_server.py, run_worker.py, alembic migrations, or frontend code does
not restart the API.
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# Proactor is already the default on modern Windows/Python; setting the
# deprecated WindowsProactorEventLoopPolicy warns on 3.14+. Uvicorn still
# needs loop="none" below so it does not clobber Proactor with Selector.
if sys.platform == "win32" and sys.version_info < (3, 14):
    try:
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    except Exception:
        pass

sys.path.insert(0, str(ROOT))


def _reload_enabled() -> bool:
    from app.core.dev_reload import api_reload_enabled

    return api_reload_enabled()


def _reload_watch_config() -> tuple[list[str], list[str], list[str], float]:
    """Return (dirs, includes, excludes, delay) for uvicorn reload."""
    app_dir = str(ROOT / "app")
    # Do NOT put ``*.py`` here - uvicorn adds it to exclude patterns and blocks app/ too.
    # Directory names exclude everything under alembic/, frontend/, etc.
    excludes = [
        "**/__pycache__/**",
        "**/*.pyc",
        "**/_*.py",
        "**/user_templates/**",
        "alembic",
        "frontend",
        "extension",
        "venv",
        "tests",
        "start_server.py",
        "run_worker.py",
    ]
    includes = ["app/**/*.py"]
    # Windows editors / antivirus often emit two WatchFiles events for one save.
    # A second reload while the worker is still in lifespan startup leaves the
    # reloader parent holding :8000 with a live-looking child that never serves
    # HTTP (TCP accept works, requests hang forever). Debounce hard enough to
    # coalesce those duplicates, see app/core/reload_quiet.py.
    delay = 4.0
    return [app_dir], includes, excludes, delay


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

    from app.core.reload_quiet import install_uvicorn_reload_noise_filter

    port = int(os.environ.get("PORT", 8000))
    host = _api_host()
    use_reload = _reload_enabled()
    reload_dirs, reload_includes, reload_excludes, reload_delay = _reload_watch_config()

    if use_reload:
        print(f"[reload] Watching {reload_dirs[0]}/*.py only - saves outside app/ will not restart the API.")
    else:
        print("[reload] Disabled (set RELOAD=1 or APP_ENV=local to enable).")
    if host == "127.0.0.1":
        print("[lan] API bound to 127.0.0.1 - other devices should use http://<your-ip>:5173 only.")

    install_uvicorn_reload_noise_filter()

    # uvicorn ignores workers under reload; Windows keeps one process so the
    # Proactor loop policy above stays in effect.
    workers = 1 if use_reload or sys.platform == "win32" else max(1, int(os.environ.get("API_WORKERS", "1")))
    if workers > 1:
        print(f"[workers] {workers} API processes")

    uvicorn.run(
        "app.main:app",
        host=host,
        port=port,
        workers=workers,
        reload=use_reload,
        reload_dirs=reload_dirs if use_reload else None,
        reload_includes=reload_includes if use_reload else None,
        reload_excludes=reload_excludes if use_reload else None,
        reload_delay=reload_delay if use_reload else None,
        # See module docstring: prevents uvicorn from overwriting our
        # Proactor policy with SelectorEventLoopPolicy on Windows+reload,
        # which would otherwise break Playwright's subprocess spawn.
        # Linux gets uvloop + httptools (Playwright verified on uvloop).
        loop="none" if sys.platform == "win32" else "uvloop",
        http="auto" if sys.platform == "win32" else "httptools",
    )
