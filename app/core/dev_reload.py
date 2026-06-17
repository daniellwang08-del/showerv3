"""Local-dev reload flags for the API (uvicorn) and arq workers (watchfiles)."""
from __future__ import annotations

import os


def _env_flag(name: str, default: str) -> bool:
    return os.environ.get(name, default).strip().lower() in ("1", "true", "yes")


def api_reload_enabled() -> bool:
    """Whether uvicorn should watch ``app/`` and restart the API process."""
    app_env = os.environ.get("APP_ENV", "local").strip().lower()
    default = "0" if app_env == "production" else "1"
    return _env_flag("RELOAD", default)


def worker_reload_enabled() -> bool:
    """Whether arq workers should watch ``app/`` and restart on ``.py`` changes.

    ``WORKER_RELOAD`` is independent of ``RELOAD``. Workers default to **off**
    so five parallel watchers do not enter a restart storm when the API or an
    IDE touches many files under ``app/``. ``start.cmd`` sets ``WORKER_RELOAD=0``
    explicitly; set ``WORKER_RELOAD=1`` when actively editing worker code.
    """
    if os.environ.get("WORKER_RELOAD") is not None:
        return _env_flag("WORKER_RELOAD", "0")
    return False
