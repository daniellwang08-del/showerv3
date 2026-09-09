"""One-time browser authentication for job platforms.

Primary flow (`capture`) — keep your current Chrome open:
  1. Opens the site in your already-running Chrome session.
  2. You sign in there (Cloudflare / Google / etc.).
  3. A tiny local Chrome extension exports live cookies (including HttpOnly)
     to this app via http://127.0.0.1:8765.

Evidence for this design:
  - Launching chrome.exe with only a URL reuses the active session
    ("Opening in existing browser session").
  - Chrome 136+ ignores CDP on the default User Data path.
  - Chrome locks Cookies SQLite exclusively while running (WinError 32),
    so Python cannot read HttpOnly cookies from disk until Chrome exits.
  - chrome.cookies in an MV3 extension CAN read the live session.

Usage (cmd.exe):
    python -m app.scraper.auth capture rrs
    python -m app.scraper.auth capture jobright

One-time: Load unpacked extension from
  app/scraper/session_export_extension
in chrome://extensions (Developer mode).

    python -m app.scraper.auth status <platform>
    python -m app.scraper.auth clear <platform>

Supported platforms: rrs (RemoteRocketship), jobright
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse
from urllib.request import urlopen

logger = logging.getLogger(__name__)

SESSION_DIR = Path(__file__).resolve().parents[2] / "data"
BROWSER_PROFILE_ROOT = SESSION_DIR / "browser_profiles"
DEFAULT_CDP_URL = "http://127.0.0.1:9222"
DEFAULT_LOGIN_TIMEOUT_SEC = 600

_CF_URL_HINTS = (
    "challenges.cloudflare.com",
    "cdn-cgi/challenge",
    "__cf_chl",
)
_CF_TEXT_HINTS = (
    "performing security verification",
    "just a moment",
    "checking your browser",
    "cf-turnstile",
    "verify you are human",
    "verifying...",
)

# ── Platform configs ────────────────────────────────────────────────
PLATFORMS = {
    "rrs": {
        "label": "RemoteRocketship",
        "session_file": SESSION_DIR / "rrs_session.json",
        "login_url": "https://www.remoterocketship.com/log-in/",
        "cookie_domains": ("remoterocketship.com",),
        "done_markers": [
            "__NEXT_DATA__",
            "Find Your Dream",
            "Saved Jobs",
            "Applied Jobs",
            "Jobs You've Hidden",
        ],
        "login_markers": ["Sign in", "Log in", "Login", "sign in with", "Enter your email"],
        "login_paths": ["/log-in", "/login", "/signin"],
        "done_cookies": ["session", "token", "auth", "jwt", "sb-", "supabase"],
        "done_urls": [
            "remoterocketship.com/remote-jobs",
            "remoterocketship.com/jobs",
            "remoterocketship.com/?page=",
        ],
    },
    "jobright": {
        "label": "Jobright.ai",
        "session_file": SESSION_DIR / "jobright_session.json",
        "login_url": "https://jobright.ai/jobs/recommend",
        "cookie_domains": ("jobright.ai",),
        "done_markers": [],
        "done_cookies": ["jwt", "token", "session", "auth", "SESSION_ID"],
        "done_urls": ["jobright.ai/jobs/recommend"],
        "login_markers": [],
        "login_paths": ["/login", "/signin", "/auth"],
    },
}


def _get_platform(name: str) -> dict:
    key = name.lower().strip()
    if key not in PLATFORMS:
        print(f"Unknown platform: {name}")
        print(f"Supported: {', '.join(PLATFORMS.keys())}")
        sys.exit(1)
    return PLATFORMS[key]


def default_chrome_user_data_dir() -> Optional[Path]:
    """Return the OS default Google Chrome user-data directory if it exists."""
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


def dedicated_profile_dir(platform_key: str) -> Path:
    path = BROWSER_PROFILE_ROOT / platform_key.lower().strip()
    path.mkdir(parents=True, exist_ok=True)
    return path


def cdp_profile_dir(platform_key: str) -> Path:
    """Non-default Chrome user-data-dir required for CDP since Chrome 136."""
    path = BROWSER_PROFILE_ROOT / f"cdp_{platform_key.lower().strip()}"
    path.mkdir(parents=True, exist_ok=True)
    return path


def is_default_chrome_user_data_dir(path: Path | None) -> bool:
    """True when path is Chrome's default profile root (CDP disabled since Chrome 136)."""
    if not path:
        return False
    default = default_chrome_user_data_dir()
    if not default:
        return False
    try:
        return path.resolve() == default.resolve()
    except OSError:
        return str(path).lower().rstrip("\\/") == str(default).lower().rstrip("\\/")


# Files/dirs under Default/ that usually carry login state (skip huge caches).
_CHROME_DEFAULT_COPY_ENTRIES = (
    "Preferences",
    "Secure Preferences",
    "Cookies",
    "Cookies-journal",
    "Login Data",
    "Login Data-journal",
    "Network",
    "Local Storage",
    "Session Storage",
    "IndexedDB",
    "Web Data",
    "Web Data-journal",
)


def clone_chrome_profile_for_cdp(
    dest: Path,
    *,
    source: Path | None = None,
    profile_directory: str = "Default",
) -> Path:
    """Copy login-bearing files from Chrome into a CDP-safe user-data-dir.

    Chrome 136+ ignores --remote-debugging-port on the default User Data path.
    Cloning into a non-standard directory restores CDP while keeping cookies.
    """
    source = source or default_chrome_user_data_dir()
    if not source or not source.is_dir():
        raise FileNotFoundError("Chrome user data directory not found.")

    src_profile = source / profile_directory
    if not src_profile.is_dir():
        raise FileNotFoundError(f"Chrome profile directory not found: {src_profile}")

    if chrome_processes_running():
        raise RuntimeError(
            "Chrome is still running — cookie files are locked. "
            "Run: taskkill /IM chrome.exe /F"
        )

    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir(parents=True, exist_ok=True)

    local_state = source / "Local State"
    if local_state.is_file():
        shutil.copy2(local_state, dest / "Local State")

    dest_profile = dest / "Default"
    dest_profile.mkdir(parents=True, exist_ok=True)

    copied = 0
    for name in _CHROME_DEFAULT_COPY_ENTRIES:
        src_item = src_profile / name
        if not src_item.exists():
            continue
        dest_item = dest_profile / name
        if src_item.is_dir():
            shutil.copytree(src_item, dest_item, dirs_exist_ok=True)
        else:
            dest_item.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src_item, dest_item)
        copied += 1

    # Remove singleton locks so Chrome can start this clone.
    for lock_name in ("SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile"):
        lock_path = dest / lock_name
        if lock_path.exists() or lock_path.is_symlink():
            try:
                lock_path.unlink()
            except OSError:
                pass

    if copied == 0:
        raise RuntimeError(f"No profile files copied from {src_profile}")

    print(f"Cloned {copied} Chrome profile entries into CDP-safe dir:")
    print(f"  {dest}")
    return dest


def chrome_executable() -> Optional[Path]:
    """Locate google-chrome / chrome.exe on this machine."""
    env = os.environ.get("CHROME_PATH") or os.environ.get("GOOGLE_CHROME_BIN")
    if env:
        p = Path(env)
        if p.is_file():
            return p

    candidates: list[Path] = []
    for env_key in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
        root = os.environ.get(env_key)
        if root:
            candidates.append(Path(root) / "Google" / "Chrome" / "Application" / "chrome.exe")
    candidates.extend(
        [
            Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            Path("/usr/bin/google-chrome"),
            Path("/usr/bin/google-chrome-stable"),
            Path("/usr/bin/chromium"),
            Path("/usr/bin/chromium-browser"),
        ]
    )
    for path in candidates:
        if path.is_file():
            return path
    return None


def _parse_cdp_endpoint(cdp_url: str) -> tuple[str, int]:
    parsed = urlparse(cdp_url if "://" in cdp_url else f"http://{cdp_url}")
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or 9222
    return host, port


def cdp_endpoint_ready(cdp_url: str, timeout_sec: float = 0.5) -> bool:
    """True when Chrome remote-debugging HTTP endpoint answers."""
    host, port = _parse_cdp_endpoint(cdp_url)
    try:
        with socket.create_connection((host, port), timeout=timeout_sec):
            pass
    except OSError:
        return False
    try:
        with urlopen(f"http://{host}:{port}/json/version", timeout=timeout_sec) as resp:
            return resp.status == 200
    except Exception:
        return False


def chrome_processes_running() -> bool:
    """Best-effort check for running Chrome processes (Windows/macOS/Linux)."""
    try:
        if os.name == "nt":
            result = subprocess.run(
                ["tasklist", "/FI", "IMAGENAME eq chrome.exe"],
                capture_output=True,
                text=True,
                check=False,
            )
            return "chrome.exe" in (result.stdout or "").lower()
        result = subprocess.run(
            ["pgrep", "-f", "Google Chrome|chrome|chromium"],
            capture_output=True,
            text=True,
            check=False,
        )
        return bool((result.stdout or "").strip())
    except Exception:
        return False


def start_chrome_with_cdp(
    *,
    cdp_url: str = DEFAULT_CDP_URL,
    user_data_dir: Path | None = None,
    start_url: str | None = None,
) -> subprocess.Popen:
    """Start Google Chrome with --remote-debugging-port so Playwright can attach.

    ``user_data_dir`` MUST NOT be Chrome's default User Data path (Chrome 136+
    silently ignores remote debugging there).
    """
    exe = chrome_executable()
    if not exe:
        raise FileNotFoundError(
            "Google Chrome executable not found. Install Chrome or set CHROME_PATH."
        )

    host, port = _parse_cdp_endpoint(cdp_url)
    if host not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("Auto-start only supports local CDP hosts (127.0.0.1).")

    profile = user_data_dir or dedicated_profile_dir("cdp_shared")
    if is_default_chrome_user_data_dir(profile):
        raise ValueError(
            "Refusing to start CDP against Chrome's default User Data directory. "
            "Chrome 136+ ignores --remote-debugging-port there. "
            "Use a cloned profile under data/browser_profiles/cdp_* ."
        )
    profile.mkdir(parents=True, exist_ok=True)

    args = [
        str(exe),
        f"--remote-debugging-port={port}",
        f"--user-data-dir={profile}",
        "--profile-directory=Default",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-dev-shm-usage",
    ]
    if start_url:
        args.append(start_url)

    # DETACHED so Chrome stays up after this helper returns.
    creationflags = 0
    if os.name == "nt":
        creationflags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]

    print("Launch command:")
    print(" ", " ".join(f'"{a}"' if " " in a else a for a in args))

    return subprocess.Popen(
        args,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        creationflags=creationflags,
        close_fds=True,
    )


def wait_for_cdp(cdp_url: str, timeout_sec: float = 30.0) -> bool:
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        if cdp_endpoint_ready(cdp_url):
            return True
        time.sleep(0.4)
    return False


def _is_cloudflare_challenge(url: str, content: str | None = None) -> bool:
    url_l = (url or "").lower()
    if any(h in url_l for h in _CF_URL_HINTS):
        return True
    if content:
        content_l = content.lower()
        if any(h in content_l for h in _CF_TEXT_HINTS):
            return True
    return False


def _cookie_matches_platform(cookie: dict, cfg: dict) -> bool:
    domains = cfg.get("cookie_domains") or ()
    if not domains:
        return True
    domain = (cookie.get("domain") or "").lower().lstrip(".")
    return any(domain == d or domain.endswith("." + d) or domain.endswith(d) for d in domains)


def _filter_platform_cookies(cookies: list[dict], cfg: dict) -> list[dict]:
    matched = [c for c in cookies if _cookie_matches_platform(c, cfg)]
    return matched or list(cookies)


# ── Core auth functions ─────────────────────────────────────────────

def setup_auth(
    platform_key: str,
    *,
    chrome_profile: bool = False,
    user_data_dir: str | Path | None = None,
    cdp_url: str | None = None,
    manual_confirm: bool = False,
    timeout_sec: int = DEFAULT_LOGIN_TIMEOUT_SEC,
    sync_chrome_profile: bool = True,
) -> bool:
    """Open/attach Chrome so the user can log in. Save cookies on success."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        logger.error(
            "Playwright not installed. Run: pip install playwright && playwright install chromium"
        )
        return False

    cfg = _get_platform(platform_key)
    mode = "cdp" if cdp_url else ("chrome_profile" if chrome_profile or user_data_dir else "dedicated")

    print(f"\n=== {cfg['label']} Authentication Setup ===")
    if mode == "cdp":
        print(f"CDP target: {cdp_url}")
        print("Chrome 136+ cannot expose CDP on the default profile path.")
        print("This flow clones your Chrome login into a CDP-safe profile, then attaches.")
        print("Press Enter in this terminal after the site shows you as logged in.\n")
    elif mode == "chrome_profile":
        print("Launching your installed Google Chrome with your Chrome profile.")
        print("IMPORTANT: Fully quit Chrome (all windows) before continuing.")
        print("Note: Playwright persistent launch may still hit profile locks;")
        print("prefer: python -m app.scraper.auth capture <platform>\n")
    else:
        print("Launching installed Google Chrome with a dedicated profile.")
        print("Prefer `capture` if you already logged in with normal Chrome.\n")

    print("Once you are logged in, cookies are saved automatically.\n")

    try:
        with sync_playwright() as p:
            if cdp_url:
                return _setup_via_cdp(
                    p,
                    cfg,
                    platform_key=platform_key,
                    cdp_url=cdp_url,
                    manual_confirm=manual_confirm,
                    timeout_sec=timeout_sec,
                    sync_chrome_profile=sync_chrome_profile,
                )

            profile_path = _resolve_user_data_dir(
                platform_key,
                chrome_profile=chrome_profile,
                user_data_dir=user_data_dir,
            )
            return _setup_via_persistent_chrome(
                p,
                cfg,
                platform_key=platform_key,
                user_data_dir=profile_path,
                manual_confirm=manual_confirm,
                timeout_sec=timeout_sec,
                using_system_profile=bool(chrome_profile or user_data_dir),
            )
    except Exception as e:
        logger.error("Auth setup failed: %s", e)
        print(f"\nAuth setup failed: {e}")
        _print_recovery_hints(platform_key)
        return False


def open_url_in_existing_chrome(url: str) -> None:
    """Open a URL in the already-running Chrome session (does not kill Chrome).

    Evidence: launching chrome.exe with only a URL (no --user-data-dir) makes
    Chrome print "Opening in existing browser session" and reuse the active
    profile/window — the failure mode we saw when Playwright tried to own the
    default profile.
    """
    exe = chrome_executable()
    if not exe:
        # Fallback: OS default browser handler.
        import webbrowser

        webbrowser.open(url)
        return

    creationflags = 0
    if os.name == "nt":
        creationflags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]

    # Critical: do NOT pass --user-data-dir / --remote-debugging-port.
    # Those force a new/isolated instance; bare URL joins the active session.
    subprocess.Popen(
        [str(exe), url],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        creationflags=creationflags,
        close_fds=True,
    )


def _extension_dir() -> Path:
    return Path(__file__).resolve().parent / "session_export_extension"


def _try_disk_cookie_export(cfg: dict) -> list[dict] | None:
    """Best-effort disk export (works when Chrome is closed / DB not exclusive-locked)."""
    try:
        from app.scraper.chrome_cookies import extract_chrome_cookies

        cookies = extract_chrome_cookies(cfg.get("cookie_domains") or ())
        cookies = _filter_platform_cookies(cookies, cfg)
        return cookies or None
    except Exception as e:
        logger.info("disk_cookie_export_unavailable: %s", e)
        return None


def capture_session(platform_key: str, *, timeout_sec: int = DEFAULT_LOGIN_TIMEOUT_SEC) -> bool:
    """Open site in the active Chrome session and capture cookies without killing Chrome."""
    from app.scraper.session_bridge import SessionBridge

    cfg = _get_platform(platform_key)
    ext_dir = _extension_dir()

    print(f"\n=== {cfg['label']} Session Capture ===")
    print("Chrome stays open. No taskkill. No CDP on your default profile.\n")
    print("One-time setup (if you have not done it yet):")
    print("  1) Open chrome://extensions")
    print("  2) Enable Developer mode")
    print("  3) Load unpacked → select this folder:")
    print(f"     {ext_dir}")
    print()

    # Fast path: if disk cookies are readable, use them (Chrome closed / unlocked).
    disk_cookies = _try_disk_cookie_export(cfg)
    if disk_cookies:
        _save_session(disk_cookies, cfg["session_file"])
        print(f"Captured {len(disk_cookies)} cookies from Chrome profile on disk.")
        print(f"Location: {cfg['session_file']}\n")
        return True

    def on_export(platform: str, cookies: list[dict]) -> dict:
        filtered = _filter_platform_cookies(cookies, cfg)
        if not filtered:
            raise ValueError("No cookies for this platform were provided")
        _save_session(filtered, cfg["session_file"])
        return {
            "ok": True,
            "platform": platform,
            "cookie_count": len(filtered),
            "path": str(cfg["session_file"]),
        }

    bridge = SessionBridge(platform_key, on_export)
    try:
        bridge.start()
    except OSError as e:
        print(f"Could not start local bridge on 127.0.0.1:8765: {e}")
        print("Close whatever is using that port, then retry.")
        return False

    print(f"Local bridge listening: {bridge.base_url}")
    open_url_in_existing_chrome(cfg["login_url"])
    print(f"Opened in your current Chrome session: {cfg['login_url']}")
    print()
    print("Now:")
    print("  1) Finish login / Cloudflare in that Chrome tab")
    print("  2) Click the 'Job Scraper Session Export' extension icon")
    print(f"  3) Press 'Export {cfg['label']}'")
    print("     (or wait — the extension also auto-exports while capture is running)")
    print()

    result = bridge.wait(timeout_sec=timeout_sec)
    bridge.stop()

    if not result or not result.get("ok"):
        print("Capture timed out or failed.")
        print("Make sure the extension is installed/enabled, then run capture again.")
        _print_recovery_hints(platform_key)
        return False

    print(
        f"\nSession saved successfully! ({result.get('cookie_count', 0)} cookies)"
    )
    print(f"Location: {result.get('path')}")
    print("You can sync the spider now — Chrome can stay open.\n")
    return True


def _resolve_user_data_dir(
    platform_key: str,
    *,
    chrome_profile: bool,
    user_data_dir: str | Path | None,
) -> Path:
    if user_data_dir:
        path = Path(user_data_dir).expanduser().resolve()
        if not path.exists():
            raise FileNotFoundError(f"Chrome user-data dir not found: {path}")
        return path
    if chrome_profile:
        path = default_chrome_user_data_dir()
        if not path:
            raise FileNotFoundError(
                "Could not locate Google Chrome user data. Pass --user-data-dir explicitly."
            )
        return path
    return dedicated_profile_dir(platform_key)


def _setup_via_persistent_chrome(
    p,
    cfg: dict,
    *,
    platform_key: str,
    user_data_dir: Path,
    manual_confirm: bool,
    timeout_sec: int,
    using_system_profile: bool,
) -> bool:
    print(f"Chrome user data: {user_data_dir}")
    if using_system_profile:
        print("Close every Chrome window/process first, or profile lock will fail.\n")

    try:
        context = p.chromium.launch_persistent_context(
            user_data_dir=str(user_data_dir),
            channel="chrome",
            headless=False,
            viewport={"width": 1440, "height": 900},
            locale="en-US",
            timezone_id=_local_timezone_id(),
            args=[
                "--disable-dev-shm-usage",
            ],
            ignore_default_args=["--enable-automation"],
        )
    except Exception as e:
        msg = str(e)
        if "channel" in msg.lower() or "chrome" in msg.lower():
            print(
                "\nCould not launch Google Chrome via Playwright channel='chrome'.\n"
                "Install Google Chrome, or start Chrome with remote debugging and use --cdp.\n"
            )
        if "ProcessSingleton" in msg or "profile" in msg.lower() or "lock" in msg.lower():
            print(
                "\nChrome profile appears locked (Chrome is still running).\n"
                "Quit Chrome completely, then retry --chrome-profile, or use --cdp.\n"
            )
        raise

    browser = context.browser
    try:
        page = context.pages[0] if context.pages else context.new_page()
        login_url = cfg["login_url"]
        try:
            page.goto(login_url, wait_until="commit", timeout=90000)
        except Exception:
            print(f"Direct navigation to {login_url} timed out.")
            print("The browser is open - please navigate to the site manually.")
            print(f"Go to: {login_url}\n")

        print("Waiting for you to log in...")
        success = _wait_for_login(
            page,
            cfg,
            timeout_sec=timeout_sec,
            manual_confirm=manual_confirm,
        )
        if not success:
            print(f"\nLogin timed out ({timeout_sec // 60} minutes). Please try again.")
            _print_recovery_hints(platform_key)
            return False

        cookies = _filter_platform_cookies(context.cookies(), cfg)
        _save_session(cookies, cfg["session_file"])
        print(f"\nSession saved successfully! ({len(cookies)} cookies)")
        print(f"Location: {cfg['session_file']}")
        print("You can now use the scraper / resolver without logging in again.\n")
        return True
    finally:
        try:
            context.close()
        except Exception:
            pass
        if browser:
            try:
                browser.close()
            except Exception:
                pass


def _ensure_cdp_chrome(
    cdp_url: str,
    *,
    platform_key: str,
    start_url: str,
    sync_chrome_profile: bool,
) -> None:
    """Connect target must be listening; auto-start Chrome when it is not."""
    if cdp_endpoint_ready(cdp_url):
        print(f"CDP endpoint ready: {cdp_url}")
        return

    print(f"No Chrome listening on {cdp_url} — starting CDP-safe Chrome...")
    if chrome_processes_running():
        print(
            "\nChrome is already running WITHOUT remote debugging.\n"
            "Windows (cmd) — quit it, then re-run:\n"
            "  taskkill /IM chrome.exe /F\n"
            f"  python -m app.scraper.auth capture {platform_key}\n"
        )
        raise RuntimeError(
            "Chrome is running without CDP. Quit all chrome.exe processes, then retry."
        )

    profile = cdp_profile_dir(platform_key)
    if sync_chrome_profile and default_chrome_user_data_dir():
        print("Syncing cookies/login from your normal Chrome profile...")
        clone_chrome_profile_for_cdp(profile)
    else:
        profile.mkdir(parents=True, exist_ok=True)
        print(f"Using existing CDP profile (no sync): {profile}")

    print(f"Starting: {chrome_executable()}")
    print(f"Profile:  {profile}")
    start_chrome_with_cdp(cdp_url=cdp_url, user_data_dir=profile, start_url=start_url)

    if not wait_for_cdp(cdp_url, timeout_sec=60):
        raise RuntimeError(
            f"Started Chrome but CDP did not become ready at {cdp_url}. "
            "Confirm Chrome 136+ is using the cloned non-default profile path."
        )
    print("Chrome remote debugging is ready.\n")


def _setup_via_cdp(
    p,
    cfg: dict,
    *,
    platform_key: str,
    cdp_url: str,
    manual_confirm: bool,
    timeout_sec: int,
    sync_chrome_profile: bool = True,
) -> bool:
    _ensure_cdp_chrome(
        cdp_url,
        platform_key=platform_key,
        start_url=cfg["login_url"],
        sync_chrome_profile=sync_chrome_profile,
    )

    browser = p.chromium.connect_over_cdp(cdp_url)
    if not browser.contexts:
        print("Connected, but Chrome has no open contexts/windows.")
        return False

    context = browser.contexts[0]
    page = _pick_or_open_page(context, cfg["login_url"])

    # Prefer an existing tab already on the target site.
    target_host = urlparse(cfg["login_url"]).hostname or ""
    for existing in context.pages:
        try:
            if target_host and target_host in (existing.url or ""):
                page = existing
                break
        except Exception:
            continue

    print(f"Using tab: {page.url}")
    host = urlparse(cfg["login_url"]).hostname or ""
    if host and host not in (page.url or ""):
        try:
            page.goto(cfg["login_url"], wait_until="commit", timeout=90000)
        except Exception:
            print(f"Could not navigate automatically. Open {cfg['login_url']} in Chrome.")

    print("Waiting for login in the attached Chrome window...")
    success = _wait_for_login(
        page,
        cfg,
        timeout_sec=timeout_sec,
        manual_confirm=True,  # CDP: always allow Enter confirm
        force_manual_hint=True,
    )
    if not success:
        print(f"\nLogin timed out ({timeout_sec // 60} minutes). Please try again.")
        _print_recovery_hints(platform_key)
        return False

    cookies = _filter_platform_cookies(context.cookies(), cfg)
    if not cookies:
        print("No cookies found in the attached Chrome context.")
        return False

    _save_session(cookies, cfg["session_file"])
    print(f"\nSession saved successfully! ({len(cookies)} cookies)")
    print(f"Location: {cfg['session_file']}")
    print("You can now use the scraper / resolver without logging in again.\n")
    # Do not close the user's Chrome.
    return True


def _pick_or_open_page(context, login_url: str):
    if context.pages:
        return context.pages[0]
    page = context.new_page()
    return page


def _local_timezone_id() -> str:
    try:
        import tzlocal

        return str(tzlocal.get_localzone_name())
    except Exception:
        return "America/New_York"


def _print_recovery_hints(platform_key: str) -> None:
    ext_dir = _extension_dir()
    print("Recommended (keep Chrome open — no taskkill):")
    print("  1) Load unpacked extension once:")
    print(f"     {ext_dir}")
    print(f"  2) python -m app.scraper.auth capture {platform_key}")
    print("  3) Sign in in the opened Chrome tab, then Export via the extension")


def _wait_for_login(
    page,
    cfg: dict,
    timeout_sec: int = DEFAULT_LOGIN_TIMEOUT_SEC,
    *,
    manual_confirm: bool = False,
    force_manual_hint: bool = False,
) -> bool:
    """Wait until the user completes login.

    Detection strategies (any is enough):
      A. Content-based: done_markers appear in page AND login_markers disappear.
      B. Cookie-based: auth-like cookie names for the platform domain.
      C. Two-phase: saw a login form, then it disappeared.
      D. URL-based: current URL contains any of done_urls patterns.
      E. Manual Enter confirm (optional / CDP).
    """
    start = time.time()
    last_url = ""
    saw_login_form = False
    saw_cloudflare = False
    consecutive_done = 0
    required_done = 3
    done_markers = cfg.get("done_markers", [])
    login_markers = cfg.get("login_markers", [])
    login_paths = cfg.get("login_paths", [])
    done_cookie_keywords = [k.lower() for k in (cfg.get("done_cookies") or [])]
    done_urls = cfg.get("done_urls", [])
    content_poll_every = 3  # seconds; avoid hammering Turnstile iframes
    last_content_poll = 0.0
    cached_content = ""
    hinted_manual = force_manual_hint or manual_confirm

    if manual_confirm or force_manual_hint:
        print("Tip: when fully logged in, you can press Enter here to save cookies immediately.")

    context = page.context
    initial_cookie_names = {c["name"] for c in context.cookies()}

    while time.time() - start < timeout_sec:
        # Non-blocking-ish manual confirm (Windows/POSIX): poll stdin when interactive.
        if manual_confirm or force_manual_hint:
            if _stdin_enter_pressed():
                cookies = _filter_platform_cookies(context.cookies(), cfg)
                print(f"  Manual confirm received ({len(cookies)} cookies).")
                return True

        try:
            url = page.url
            if url != last_url:
                elapsed = int(time.time() - start)
                print(f"  [{elapsed}s] Current URL: {url}")
                last_url = url
                consecutive_done = 0

            # During Cloudflare challenges, avoid page.content() thrash.
            if _is_cloudflare_challenge(url):
                if not saw_cloudflare:
                    print(
                        "  Cloudflare security check detected. Wait for it to finish "
                        "(do not refresh). If it loops, use --chrome-profile or --cdp."
                    )
                    saw_cloudflare = True
                    if not hinted_manual:
                        print("  You can also press Enter after login succeeds (--manual).")
                        hinted_manual = True
                time.sleep(2)
                continue

            logged_in = False

            # Strategy D: URL-based
            if done_urls:
                for pattern in done_urls:
                    if pattern in url:
                        logged_in = True
                        break

            # Strategy B: cookie-based (new auth-like cookies for this platform)
            cookies_now = context.cookies()
            if not logged_in and done_cookie_keywords:
                current_names = {
                    c["name"]
                    for c in cookies_now
                    if _cookie_matches_platform(c, cfg)
                }
                new_cookies = current_names - initial_cookie_names
                for new_name in new_cookies:
                    name_lower = new_name.lower()
                    if any(kw in name_lower for kw in done_cookie_keywords):
                        logged_in = True
                        break

            now = time.time()
            should_poll_content = (now - last_content_poll) >= content_poll_every
            has_login_form = False
            on_login_path = any(lp in url for lp in login_paths)
            content = cached_content

            if should_poll_content and (done_markers or login_markers):
                try:
                    content = page.content()
                    cached_content = content
                    last_content_poll = now
                except Exception:
                    content = cached_content

                if _is_cloudflare_challenge(url, content):
                    if not saw_cloudflare:
                        print(
                            "  Cloudflare security check detected in page content. "
                            "Waiting without refreshing..."
                        )
                        saw_cloudflare = True
                    time.sleep(2)
                    continue

                has_login_form = (
                    any(m.lower() in content.lower() for m in login_markers)
                    if login_markers
                    else False
                )

                # Strategy A: content-based
                if not logged_in and done_markers:
                    has_done = any(m.lower() in content.lower() for m in done_markers)
                    if has_done and not has_login_form and len(content) > 500:
                        logged_in = True

            # Track login form appearances
            if has_login_form or on_login_path:
                if not saw_login_form:
                    elapsed = int(time.time() - start)
                    print(f"  [{elapsed}s] Login form detected - waiting for you to complete login...")
                saw_login_form = True
                if not logged_in:
                    consecutive_done = 0
                    time.sleep(1)
                    continue

            # Strategy C: login form was seen, now it's gone
            if not logged_in and saw_login_form and not has_login_form and not on_login_path:
                if len(content) > 500:
                    logged_in = True

            if logged_in:
                consecutive_done += 1
                if consecutive_done >= required_done:
                    return True
            else:
                consecutive_done = 0

        except Exception:
            consecutive_done = 0

        time.sleep(1)
    return False


def _stdin_enter_pressed() -> bool:
    """Return True if the user pressed Enter (non-blocking when possible)."""
    try:
        if not sys.stdin or not sys.stdin.isatty():
            return False
        if os.name == "nt":
            import msvcrt

            while msvcrt.kbhit():
                ch = msvcrt.getwch()
                if ch in ("\r", "\n"):
                    return True
            return False
        import select

        ready, _, _ = select.select([sys.stdin], [], [], 0)
        if ready:
            sys.stdin.readline()
            return True
        return False
    except Exception:
        return False


def _save_session(cookies: list[dict], session_file: Path):
    """Persist Playwright cookies to a JSON file."""
    SESSION_DIR.mkdir(parents=True, exist_ok=True)

    session_data = {
        "saved_at": datetime.now(timezone.utc).isoformat(),
        "cookies": cookies,
    }

    session_file.write_text(json.dumps(session_data, indent=2), encoding="utf-8")


def load_session(platform_key: str = "rrs") -> Optional[list[dict]]:
    """Load saved cookies from disk. Returns None if no session exists."""
    cfg = PLATFORMS.get(platform_key)
    if not cfg:
        return None
    session_file = cfg["session_file"]

    if not session_file.exists():
        return None

    try:
        data = json.loads(session_file.read_text(encoding="utf-8"))
        cookies = data.get("cookies", [])
        if not cookies:
            return None

        saved_at = data.get("saved_at", "unknown")
        logger.info("Loaded %s session from %s (%d cookies)", cfg["label"], saved_at, len(cookies))
        return cookies
    except (json.JSONDecodeError, KeyError) as e:
        logger.error("Corrupt session file %s: %s", session_file, e)
        return None


def _b64url_json(segment: str) -> dict | None:
    """Decode a base64/base64url JSON segment; return None on failure."""
    import base64
    from urllib.parse import unquote

    raw = unquote(segment or "").strip()
    if raw.startswith("base64-"):
        raw = raw[len("base64-") :]
    if not raw:
        return None
    pad = "=" * ((4 - len(raw) % 4) % 4)
    for decoder in (base64.urlsafe_b64decode, base64.b64decode):
        try:
            text = decoder(raw + pad).decode("utf-8")
            data = json.loads(text)
            return data if isinstance(data, dict) else None
        except Exception:
            continue
    return None


def parse_supabase_session_expiry(cookies: list[dict]) -> dict:
    """Extract expires_at from chunked ``sb-*-auth-token`` cookies when present.

    RemoteRocketship stores Supabase auth as ``base64-{json}`` split across
    ``…-auth-token.0``, ``…-auth-token.1``, …
    """
    chunks: dict[str, str] = {}
    for cookie in cookies or []:
        name = str(cookie.get("name") or "")
        if "auth-token" not in name or not name.startswith("sb-"):
            continue
        value = cookie.get("value")
        if value:
            chunks[name] = str(value)

    if not chunks:
        return {"token_expires_at": None, "token_expired": None}

    combined = "".join(chunks[k] for k in sorted(chunks.keys()))
    payload = _b64url_json(combined)
    if not payload:
        return {"token_expires_at": None, "token_expired": None}

    expires_at = payload.get("expires_at")
    if expires_at is None:
        access = payload.get("access_token") or ""
        if isinstance(access, str) and access.count(".") == 2:
            jwt_payload = _b64url_json(access.split(".")[1])
            if jwt_payload and jwt_payload.get("exp") is not None:
                expires_at = jwt_payload["exp"]

    if expires_at is None:
        return {"token_expires_at": None, "token_expired": None}

    try:
        exp_ts = int(expires_at)
    except (TypeError, ValueError):
        return {"token_expires_at": None, "token_expired": None}

    exp_dt = datetime.fromtimestamp(exp_ts, tz=timezone.utc)
    return {
        "token_expires_at": exp_dt.isoformat(),
        "token_expired": exp_dt < datetime.now(timezone.utc),
    }


def session_status(platform_key: str) -> dict:
    """Return info about the saved session."""
    cfg = _get_platform(platform_key)
    session_file = cfg["session_file"]

    if not session_file.exists():
        return {"exists": False, "platform": cfg["label"]}

    try:
        data = json.loads(session_file.read_text(encoding="utf-8"))
        cookies = data.get("cookies", [])
        status = {
            "exists": True,
            "platform": cfg["label"],
            "saved_at": data.get("saved_at", "unknown"),
            "cookie_count": len(cookies),
            "path": str(session_file),
            "token_expires_at": None,
            "token_expired": None,
        }
        if platform_key == "rrs":
            status.update(parse_supabase_session_expiry(cookies))
        return status
    except (json.JSONDecodeError, KeyError):
        return {"exists": True, "corrupt": True, "platform": cfg["label"], "path": str(session_file)}


def clear_session(platform_key: str) -> bool:
    """Delete saved session file."""
    cfg = _get_platform(platform_key)
    session_file = cfg["session_file"]
    if session_file.exists():
        session_file.unlink()
        return True
    return False


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.scraper.auth",
        description="One-time Chrome authentication for RemoteRocketship / Jobright",
    )
    parser.add_argument("command", choices=["setup", "capture", "status", "clear"])
    parser.add_argument("platform", choices=sorted(PLATFORMS.keys()))
    parser.add_argument(
        "--chrome-profile",
        action="store_true",
        help="Use your default Google Chrome profile (quit Chrome first; not for CDP)",
    )
    parser.add_argument(
        "--user-data-dir",
        type=str,
        default=None,
        help="Explicit Chrome user-data directory",
    )
    parser.add_argument(
        "--cdp",
        nargs="?",
        const=DEFAULT_CDP_URL,
        default=None,
        help=f"Attach/start CDP Chrome (default URL: {DEFAULT_CDP_URL})",
    )
    parser.add_argument(
        "--no-sync-chrome",
        action="store_true",
        help="Do not clone cookies from your normal Chrome profile into the CDP profile",
    )
    parser.add_argument(
        "--manual",
        action="store_true",
        help="Allow pressing Enter to save cookies once you are logged in",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_LOGIN_TIMEOUT_SEC,
        help=f"Login wait timeout in seconds (default {DEFAULT_LOGIN_TIMEOUT_SEC})",
    )
    return parser


def main(argv: list[str] | None = None):
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    parser = _build_parser()
    args = parser.parse_args(argv)

    command = args.command
    platform = args.platform

    if command == "capture":
        ok = capture_session(platform, timeout_sec=int(args.timeout))
        sys.exit(0 if ok else 1)

    if command == "setup":
        # Advanced paths (Playwright / CDP). Prefer `capture` for normal use.
        ok = setup_auth(
            platform,
            chrome_profile=bool(args.chrome_profile),
            user_data_dir=args.user_data_dir,
            cdp_url=args.cdp,
            manual_confirm=bool(args.manual),
            timeout_sec=int(args.timeout),
            sync_chrome_profile=not bool(args.no_sync_chrome),
        )
        sys.exit(0 if ok else 1)

    if command == "status":
        info = session_status(platform)
        if not info["exists"]:
            print(f"No saved {info['platform']} session.")
            print(f"Run: python -m app.scraper.auth capture {platform}")
        elif info.get("corrupt"):
            print(f"Session file is corrupt: {info['path']}")
            print(
                f"Run: python -m app.scraper.auth clear {platform} && "
                f"python -m app.scraper.auth capture {platform}"
            )
        else:
            print(f"Platform: {info['platform']}")
            print(f"Session saved at: {info['saved_at']}")
            print(f"Cookies: {info['cookie_count']}")
            print(f"File: {info['path']}")
        return

    if command == "clear":
        if clear_session(platform):
            print("Session cleared.")
        else:
            print("No session file to clear.")
        return


if __name__ == "__main__":
    main()
