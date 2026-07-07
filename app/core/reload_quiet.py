"""Suppress benign uvicorn reload noise in dev (CancelledError during hot reload)."""
from __future__ import annotations

import asyncio
import logging
import sys


def install_uvicorn_reload_noise_filter() -> None:
    """Install on every process that imports the app (parent reloader + child workers).

    Uvicorn logs ``ERROR: Exception in 'lifespan' protocol`` with a CancelledError
    traceback when a second hot reload kills a worker still starting up. That is
    expected on Windows and not a real failure — hide it so dev logs stay readable.
    """
    if getattr(install_uvicorn_reload_noise_filter, "_installed", False):
        return
    install_uvicorn_reload_noise_filter._installed = True  # type: ignore[attr-defined]

    class _ReloadNoiseFilter(logging.Filter):
        def filter(self, record: logging.LogRecord) -> bool:
            msg = record.getMessage()
            if "Exception in 'lifespan' protocol" in msg:
                return False
            if record.exc_info:
                exc_type = record.exc_info[0]
                if exc_type is asyncio.CancelledError:
                    return False
                if exc_type is KeyboardInterrupt and sys.platform == "win32":
                    return False
            if "CancelledError" in msg and "lifespan" in msg:
                return False
            return True

    filt = _ReloadNoiseFilter()
    for name in ("uvicorn.error", "uvicorn"):
        logging.getLogger(name).addFilter(filt)
