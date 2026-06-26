"""One-time browser authentication for job platforms.

Usage:
    python -m app.scraper.auth setup <platform>   # Opens browser, you log in, cookies saved
    python -m app.scraper.auth status <platform>  # Check if saved session exists / is valid
    python -m app.scraper.auth clear <platform>   # Delete saved session

Supported platforms: rrs (RemoteRocketship), jobright

Sessions are stored in data/<platform>_session.json and reused
automatically by spiders / resolvers on every run.
"""

import json
import logging
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

SESSION_DIR = Path(__file__).resolve().parents[2] / "data"

# ── Platform configs ────────────────────────────────────────────────
PLATFORMS = {
    "rrs": {
        "label": "RemoteRocketship",
        "session_file": SESSION_DIR / "rrs_session.json",
        "login_url": "https://www.remoterocketship.com/log-in/",
        "done_markers": ["__NEXT_DATA__", "Find Your Dream", "Remote Jobs"],
        "login_markers": ["Sign in", "Log in", "Login", "sign in with", "Enter your email"],
        "login_paths": ["/log-in", "/login", "/signin"],
    },
    "jobright": {
        "label": "Jobright.ai",
        "session_file": SESSION_DIR / "jobright_session.json",
        "login_url": "https://jobright.ai/",
        "done_markers": [],
        "done_cookies": ["jwt", "token", "session", "auth"],
        "done_urls": ["jobright.ai/jobs/"],
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


# ── Core auth functions ─────────────────────────────────────────────

def setup_auth(platform_key: str) -> bool:
    """Open a headed browser so the user can log in manually. Save cookies on success."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        logger.error("Playwright not installed. Run: pip install playwright && playwright install chromium")
        return False

    cfg = _get_platform(platform_key)

    print(f"\n=== {cfg['label']} Authentication Setup ===")
    print("A browser window will open. Please log in to your account.")
    print("You can use any method: Google, email/password, magic link, etc.")
    print("Once you are logged in, the browser will close automatically.\n")

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=False,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--no-sandbox",
                ],
            )

            context = browser.new_context(
                viewport={"width": 1440, "height": 900},
                locale="en-US",
                timezone_id="America/New_York",
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/125.0.0.0 Safari/537.36"
                ),
            )

            context.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
            """)

            page = context.new_page()
            login_url = cfg["login_url"]
            try:
                page.goto(login_url, wait_until="commit", timeout=90000)
            except Exception:
                print(f"Direct navigation to {login_url} timed out.")
                print("The browser is open - please navigate to the site manually.")
                print(f"Go to: {login_url}\n")

            print("Waiting for you to log in...")
            success = _wait_for_login(page, cfg, timeout_sec=300)

            if not success:
                print("\nLogin timed out (5 minutes). Please try again.")
                browser.close()
                return False

            cookies = context.cookies()
            _save_session(cookies, cfg["session_file"])

            browser.close()

            print(f"\nSession saved successfully! ({len(cookies)} cookies)")
            print(f"Location: {cfg['session_file']}")
            print("You can now use the scraper / resolver without logging in again.\n")
            return True

    except Exception as e:
        logger.error("Auth setup failed: %s", e)
        return False


def _wait_for_login(page, cfg: dict, timeout_sec: int = 300) -> bool:
    """Wait until the user completes login.

    Detection strategies (any is enough):
      A. Content-based: done_markers appear in page AND login_markers disappear.
      B. Cookie-based: a new cookie whose name *contains* any done_cookies
         keyword appears after startup.
      C. Two-phase: saw a login form, then it disappeared.
      D. URL-based: current URL contains any of done_urls patterns.
    """
    start = time.time()
    last_url = ""
    saw_login_form = False
    consecutive_done = 0
    required_done = 3
    done_markers = cfg.get("done_markers", [])
    login_markers = cfg.get("login_markers", [])
    login_paths = cfg.get("login_paths", [])
    done_cookie_keywords = cfg.get("done_cookies", [])
    done_urls = cfg.get("done_urls", [])

    context = page.context
    initial_cookie_names = {c["name"] for c in context.cookies()}

    while time.time() - start < timeout_sec:
        try:
            url = page.url
            if url != last_url:
                elapsed = int(time.time() - start)
                print(f"  [{elapsed}s] Current URL: {url}")
                last_url = url
                consecutive_done = 0

            logged_in = False

            # Strategy D: URL-based (e.g. jobright.ai/jobs/ means logged in)
            if done_urls:
                for pattern in done_urls:
                    if pattern in url:
                        logged_in = True
                        break

            # Strategy B: cookie-based (substring match on cookie names)
            if not logged_in and done_cookie_keywords:
                current_cookie_names = {c["name"] for c in context.cookies()}
                new_cookies = current_cookie_names - initial_cookie_names
                for new_name in new_cookies:
                    name_lower = new_name.lower()
                    if any(kw in name_lower for kw in done_cookie_keywords):
                        logged_in = True
                        break

            content = page.content()
            has_login_form = any(m.lower() in content.lower() for m in login_markers) if login_markers else False
            on_login_path = any(lp in url for lp in login_paths)

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


def session_status(platform_key: str) -> dict:
    """Return info about the saved session."""
    cfg = _get_platform(platform_key)
    session_file = cfg["session_file"]

    if not session_file.exists():
        return {"exists": False, "platform": cfg["label"]}

    try:
        data = json.loads(session_file.read_text(encoding="utf-8"))
        cookies = data.get("cookies", [])
        return {
            "exists": True,
            "platform": cfg["label"],
            "saved_at": data.get("saved_at", "unknown"),
            "cookie_count": len(cookies),
            "path": str(session_file),
        }
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


def main():
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    if len(sys.argv) < 3:
        print("Usage: python -m app.scraper.auth <command> <platform>")
        print("Commands: setup, status, clear")
        print(f"Platforms: {', '.join(PLATFORMS.keys())}")
        sys.exit(1)

    command = sys.argv[1].lower()
    platform = sys.argv[2].lower()

    if command == "setup":
        ok = setup_auth(platform)
        sys.exit(0 if ok else 1)

    elif command == "status":
        info = session_status(platform)
        if not info["exists"]:
            print(f"No saved {info['platform']} session.")
            print(f"Run: python -m app.scraper.auth setup {platform}")
        elif info.get("corrupt"):
            print(f"Session file is corrupt: {info['path']}")
            print(f"Run: python -m app.scraper.auth clear {platform} && python -m app.scraper.auth setup {platform}")
        else:
            print(f"Platform: {info['platform']}")
            print(f"Session saved at: {info['saved_at']}")
            print(f"Cookies: {info['cookie_count']}")
            print(f"File: {info['path']}")

    elif command == "clear":
        if clear_session(platform):
            print("Session cleared.")
        else:
            print("No session file to clear.")

    else:
        print(f"Unknown command: {command}")
        print("Commands: setup, status, clear")
        sys.exit(1)


if __name__ == "__main__":
    main()
