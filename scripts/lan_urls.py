#!/usr/bin/env python3
"""Print LAN URLs for local-network access (dev server on 0.0.0.0)."""

from __future__ import annotations

import argparse
import socket


def _is_private_ipv4(ip: str) -> bool:
    parts = ip.split(".")
    if len(parts) != 4:
        return False
    try:
        a, b = int(parts[0]), int(parts[1])
    except ValueError:
        return False
    if a == 10:
        return True
    if a == 172 and 16 <= b <= 31:
        return True
    if a == 192 and b == 168:
        return True
    return False


def _collect_interface_ips() -> list[str]:
    ips: list[str] = []
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127."):
                ips.append(ip)
    except OSError:
        pass
    return ips


def detect_lan_ip() -> str | None:
    """Best-effort primary LAN IPv4, preferring RFC1918 private addresses."""
    candidates: list[str] = []

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            candidates.append(sock.getsockname()[0])
    except OSError:
        pass

    candidates.extend(_collect_interface_ips())

    seen: set[str] = set()
    ordered: list[str] = []
    for ip in candidates:
        if ip not in seen:
            seen.add(ip)
            ordered.append(ip)

    private = [ip for ip in ordered if _is_private_ipv4(ip)]
    if private:
        return private[0]
    return ordered[0] if ordered else None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ip", action="store_true", help="Print LAN IP only")
    parser.add_argument("--frontend-port", type=int, default=5173)
    parser.add_argument("--api-port", type=int, default=8000)
    args = parser.parse_args()

    ip = detect_lan_ip()
    if args.ip:
        if ip:
            print(ip)
        return

    if not ip:
        print("  LAN:          (could not detect - use ipconfig to find your IPv4 address)")
        return

    print(f"  Frontend LAN: http://{ip}:{args.frontend_port}")
    print(f"  Backend:      http://127.0.0.1:{args.api_port}  (host only - LAN clients use :5173)")


if __name__ == "__main__":
    main()
