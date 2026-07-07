"""One-off benchmark: import time + time until port 8000 accepts."""
from __future__ import annotations

import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def bench_import() -> float:
    t0 = time.perf_counter()
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env")
    import app.main  # noqa: F401

    return time.perf_counter() - t0


def bench_port_ready(*, reload: bool) -> float | None:
    env = dict(**{k: v for k, v in __import__("os").environ.items()})
    env["RELOAD"] = "1" if reload else "0"
    t0 = time.perf_counter()
    proc = subprocess.Popen(
        [sys.executable, str(ROOT / "start_server.py")],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    ready: float | None = None
    try:
        for _ in range(160):
            try:
                sock = socket.create_connection(("127.0.0.1", 8000), timeout=0.2)
                sock.close()
                ready = time.perf_counter() - t0
                break
            except OSError:
                time.sleep(0.25)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
    return ready


if __name__ == "__main__":
    import_dt = bench_import()
    print(f"cold_import_app_main_seconds={import_dt:.3f}")
    for use_reload in (False, True):
        dt = bench_port_ready(reload=use_reload)
        label = "reload_on" if use_reload else "reload_off"
        print(f"port_ready_{label}_seconds={dt if dt is not None else 'timeout'}")
