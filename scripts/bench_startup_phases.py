"""Break down uvicorn reload startup phases."""
from __future__ import annotations

import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def run(reload: bool) -> None:
    env = os.environ.copy()
    env["RELOAD"] = "1" if reload else "0"
    t0 = time.perf_counter()
    proc = subprocess.Popen(
        [sys.executable, str(ROOT / "start_server.py")],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    markers: dict[str, float] = {}
    port_ready: float | None = None
    try:
        assert proc.stdout is not None
        while True:
            line = proc.stdout.readline()
            if not line and proc.poll() is not None:
                break
            now = time.perf_counter() - t0
            if "Started server process" in line and "started" not in markers:
                markers["uvicorn_started"] = now
            if "Waiting for application startup" in line:
                markers["lifespan_begin"] = now
            if "Application startup complete" in line:
                markers["lifespan_complete"] = now
            if "Uvicorn running on" in line:
                markers["uvicorn_running"] = now
            if port_ready is None:
                try:
                    s = socket.create_connection(("127.0.0.1", 8000), timeout=0.05)
                    s.close()
                    port_ready = now
                except OSError:
                    pass
            if markers.get("uvicorn_running") and port_ready is not None:
                break
            if now > 60:
                break
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()

    print(f"\n=== reload={'on' if reload else 'off'} ===")
    for k, v in sorted(markers.items(), key=lambda kv: kv[1]):
        print(f"{k:20s} {v:6.2f}s")
    print(f"{'port_accept':20s} {port_ready if port_ready is not None else 'n/a'}")


if __name__ == "__main__":
    run(reload=False)
    run(reload=True)
