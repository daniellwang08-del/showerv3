"""Read decrypted cookies from the local Google Chrome profile.

Used by auth capture to export a live login without attaching CDP.
Chrome 136+ ignores --remote-debugging-port on the default User Data path,
so reading the cookie DB (after the user signs in in their normal Chrome)
is the reliable way to capture an already-open session.
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import sqlite3
import tempfile
import time
from pathlib import Path
from typing import Iterable


def default_chrome_user_data_dir() -> Path | None:
    candidates: list[Path] = []
    local = os.environ.get("LOCALAPPDATA")
    if local:
        candidates.append(Path(local) / "Google" / "Chrome" / "User Data")
    home = Path.home()
    candidates.extend(
        [
            home / "Library" / "Application Support" / "Google" / "Chrome",
            home / ".config" / "google-chrome",
            home / ".config" / "chromium",
        ]
    )
    for path in candidates:
        if path.is_dir():
            return path
    return None


def _chrome_expires_to_unix(expires_utc: int | float | None) -> float:
    if not expires_utc:
        return -1
    # Chrome timestamps are microseconds since 1601-01-01.
    return (float(expires_utc) / 1_000_000.0) - 11_644_473_600.0


def _map_samesite(value: int | None) -> str:
    # Chrome: -1/0 unspecified, 1 = no_restriction/None, 2 = Lax, 3 = Strict
    if value == 1:
        return "None"
    if value == 3:
        return "Strict"
    return "Lax"


def _dpapi_decrypt(encrypted: bytes) -> bytes:
    """Windows DPAPI decrypt via ctypes (no pywin32 required)."""
    import ctypes
    import ctypes.wintypes

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [
            ("cbData", ctypes.wintypes.DWORD),
            ("pbData", ctypes.POINTER(ctypes.c_char)),
        ]

    blob_in = DATA_BLOB(len(encrypted), ctypes.create_string_buffer(encrypted, len(encrypted)))
    blob_out = DATA_BLOB()
    if ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(blob_in),
        None,
        None,
        None,
        None,
        0,
        ctypes.byref(blob_out),
    ) == 0:
        raise OSError("CryptUnprotectData failed")

    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)


def _load_chrome_aes_key(user_data_dir: Path) -> bytes:
    local_state_path = user_data_dir / "Local State"
    data = json.loads(local_state_path.read_text(encoding="utf-8"))
    encrypted_key_b64 = data["os_crypt"]["encrypted_key"]
    encrypted_key = base64.b64decode(encrypted_key_b64)

    if os.name == "nt":
        if encrypted_key.startswith(b"DPAPI"):
            encrypted_key = encrypted_key[5:]
        return _dpapi_decrypt(encrypted_key)

    # macOS / Linux: cookie values are often still readable for many sites via
    # older paths; raise clearly if we hit v10 payloads without platform support.
    raise RuntimeError(
        "Chrome AES cookie-key decryption is implemented for Windows here. "
        "On macOS/Linux, close Chrome and re-run, or use a Windows machine."
    )


def _decrypt_cookie_value(encrypted_value: bytes, aes_key: bytes) -> str:
    if not encrypted_value:
        return ""

    # Prefixes: v10 / v11 (AES-GCM), or legacy DPAPI-only payloads on older Chrome.
    if encrypted_value.startswith(b"v10") or encrypted_value.startswith(b"v11"):
        prefix = encrypted_value[:3]
        payload = encrypted_value[3:]
        nonce = payload[:12]
        ciphertext = payload[12:]
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        plain = AESGCM(aes_key).decrypt(nonce, ciphertext, None)
        return plain.decode("utf-8", errors="replace")

    if os.name == "nt":
        try:
            return _dpapi_decrypt(encrypted_value).decode("utf-8", errors="replace")
        except OSError:
            pass

    # Plain / empty
    try:
        return encrypted_value.decode("utf-8")
    except UnicodeDecodeError:
        return ""


def _cookie_db_candidates(user_data_dir: Path, profile_directory: str) -> list[Path]:
    profile = user_data_dir / profile_directory
    return [
        profile / "Network" / "Cookies",
        profile / "Cookies",
    ]


def _read_file_shared(path: Path) -> bytes:
    """Read a file even when Chrome holds it open (Windows share-mode read).

    Evidence: shutil.copy2 raises WinError 32 on Default/Network/Cookies while
    Chrome is running. CreateFileW with FILE_SHARE_READ|WRITE|DELETE succeeds
    for Chromium's SQLite cookie store on Windows.
    """
    if os.name != "nt":
        return path.read_bytes()

    import ctypes
    from ctypes import wintypes

    GENERIC_READ = 0x80000000
    FILE_SHARE_READ = 0x00000001
    FILE_SHARE_WRITE = 0x00000002
    FILE_SHARE_DELETE = 0x00000004
    OPEN_EXISTING = 3
    FILE_ATTRIBUTE_NORMAL = 0x80
    INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value

    kernel32 = ctypes.windll.kernel32
    handle = kernel32.CreateFileW(
        str(path),
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        None,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        None,
    )
    if handle == INVALID_HANDLE_VALUE or handle == -1:
        raise OSError(f"CreateFileW failed for {path}")

    try:
        size = path.stat().st_size
        buf = ctypes.create_string_buffer(size)
        bytes_read = wintypes.DWORD(0)
        ok = kernel32.ReadFile(handle, buf, size, ctypes.byref(bytes_read), None)
        if not ok:
            raise OSError(f"ReadFile failed for {path}")
        return buf.raw[: bytes_read.value]
    finally:
        kernel32.CloseHandle(handle)


def _copy_cookie_db(src_db: Path, dest_dir: Path) -> Path:
    """Copy Cookies (+ wal/shm/journal) so we can read while Chrome is open."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_db = dest_dir / "Cookies"

    last_err: Exception | None = None
    for attempt in range(8):
        try:
            for suffix in ("", "-journal", "-wal", "-shm"):
                src = Path(str(src_db) + suffix) if suffix else src_db
                if not src.exists():
                    continue
                dest = Path(str(dest_db) + suffix) if suffix else dest_db
                try:
                    shutil.copy2(src, dest)
                except OSError:
                    # Chrome exclusive lock: fall back to shared CreateFile read.
                    dest.write_bytes(_read_file_shared(src))
            if dest_db.exists() and dest_db.stat().st_size > 0:
                return dest_db
        except OSError as e:
            last_err = e
            time.sleep(0.35 * (attempt + 1))
    raise OSError(f"Could not copy Chrome cookie DB from {src_db}: {last_err}")


def _domain_match(host_key: str, domains: Iterable[str]) -> bool:
    host = (host_key or "").lower().lstrip(".")
    for domain in domains:
        d = domain.lower().lstrip(".")
        if host == d or host.endswith("." + d) or d.endswith("." + host):
            return True
        if d in host:
            return True
    return False


def extract_chrome_cookies(
    domains: Iterable[str],
    *,
    user_data_dir: Path | None = None,
    profile_directory: str = "Default",
) -> list[dict]:
    """Return Playwright-shaped cookies for the given domains from Chrome."""
    user_data_dir = user_data_dir or default_chrome_user_data_dir()
    if not user_data_dir:
        raise FileNotFoundError("Chrome user data directory not found.")

    db_path = next((p for p in _cookie_db_candidates(user_data_dir, profile_directory) if p.exists()), None)
    if not db_path:
        raise FileNotFoundError(
            f"Chrome cookie database not found under {user_data_dir / profile_directory}"
        )

    aes_key = _load_chrome_aes_key(user_data_dir)
    domain_list = list(domains)

    with tempfile.TemporaryDirectory(prefix="chrome_cookies_") as tmp:
        copied = _copy_cookie_db(db_path, Path(tmp))
        uri = copied.resolve().as_uri() + "?mode=ro"
        conn = sqlite3.connect(uri, uri=True)
        try:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                """
                SELECT host_key, name, value, encrypted_value, path,
                       expires_utc, is_secure, is_httponly, samesite
                FROM cookies
                """
            ).fetchall()
        finally:
            conn.close()

    cookies: list[dict] = []
    for row in rows:
        host_key = row["host_key"] or ""
        if not _domain_match(host_key, domain_list):
            continue

        value = row["value"] or ""
        if not value:
            enc = row["encrypted_value"] or b""
            if isinstance(enc, str):
                enc = enc.encode("latin-1", errors="ignore")
            try:
                value = _decrypt_cookie_value(bytes(enc), aes_key)
            except Exception:
                continue
        if not value:
            continue

        cookies.append(
            {
                "name": row["name"],
                "value": value,
                "domain": host_key,
                "path": row["path"] or "/",
                "expires": _chrome_expires_to_unix(row["expires_utc"]),
                "httpOnly": bool(row["is_httponly"]),
                "secure": bool(row["is_secure"]),
                "sameSite": _map_samesite(row["samesite"]),
            }
        )

    return cookies
