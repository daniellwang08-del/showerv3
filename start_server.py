#!/usr/bin/env python3
"""
Startup script that fixes Windows Python 3.13 subprocess issue.

On Windows with reload=True, uvicorn spawns a child process that does NOT run
this script. The child creates the event loop before loading our app, so
ProactorEventLoop is never set. Playwright then fails with NotImplementedError
when creating subprocesses. Use reload=False on Windows to avoid this.
"""
import asyncio
import os
import sys

# Fix for Windows subprocess issue with Python 3.13
if sys.platform == "win32":
    try:
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    except Exception:
        pass  # Fallback to default policy

# Add the current directory to Python path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

if __name__ == "__main__":
    import uvicorn

    # On Windows with reload=True, uvicorn spawns a child that doesn't run this script.
    # The child creates the event loop before loading our app, so our policy is never set.
    # Playwright then fails with NotImplementedError. Use reload=False on Windows.
    # Set RELOAD=1 to force reload (browser will not work).
    use_reload = sys.platform != "win32" and os.environ.get("RELOAD", "1").lower() in (
        "1",
        "true",
        "yes",
    )

    port = int(os.environ.get("PORT", 8000))

    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=port,
        reload=use_reload,
    )
