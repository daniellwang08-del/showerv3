"""
Google Sheets integration service.

Reads/writes to user-configured Google Spreadsheets via a service account.
All gspread (sync) calls are wrapped in asyncio.to_thread to stay non-blocking.
Failures are logged but never propagate - sheet operations must not break the
main job pipeline.

Tab groups: tabs are organized into groups (e.g. [["CHELL","Victor"], ["Adekunle","Elsie"]]).
Jobs round-robin between groups. All tabs within a group receive the same URL.
"""

from __future__ import annotations

import asyncio
import re
import threading
import time
from datetime import datetime
from pathlib import Path

import gspread
from google.oauth2.service_account import Credentials

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.logging import get_logger
from app.models.database import GoogleSheetsConfig, Job
from app.storage.database import get_session

logger = get_logger(__name__)

_SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.readonly",
]

_SPREADSHEET_ID_RE = re.compile(r"/spreadsheets/d/([a-zA-Z0-9_-]+)")

_gc: gspread.Client | None = None

# ---------------------------------------------------------------------------
# Caches – avoid redundant Google API calls within short time windows
# ---------------------------------------------------------------------------
_TAB_CACHE_TTL = 60  # seconds
_SPREADSHEET_OBJ_TTL = 120  # seconds

_tab_cache: dict[str, tuple[list[str], float]] = {}
_tab_cache_lock = threading.Lock()

_spreadsheet_cache: dict[str, tuple[gspread.Spreadsheet, float]] = {}
_spreadsheet_cache_lock = threading.Lock()

# Throttle: minimum gap (seconds) between consecutive Google API calls.
_API_CALL_GAP = 0.35
_last_api_call_time = 0.0
_throttle_lock = threading.Lock()


def _throttle() -> None:
    """Enforce minimum spacing between Google API calls to stay under quota."""
    global _last_api_call_time
    with _throttle_lock:
        now = time.monotonic()
        wait = _API_CALL_GAP - (now - _last_api_call_time)
        if wait > 0:
            time.sleep(wait)
        _last_api_call_time = time.monotonic()


def _extract_spreadsheet_id(url: str) -> str | None:
    m = _SPREADSHEET_ID_RE.search(url)
    return m.group(1) if m else None


def _credentials_path() -> Path:
    settings = get_settings()
    creds_path = Path(settings.google_sheets_credentials_path)
    if not creds_path.is_absolute():
        creds_path = Path(__file__).resolve().parent.parent.parent / creds_path
    return creds_path


def get_service_account_email() -> str | None:
    """Return service account email from credentials JSON, if configured."""
    creds_path = _credentials_path()
    if not creds_path.exists():
        return None
    try:
        import json

        data = json.loads(creds_path.read_text(encoding="utf-8"))
        email = data.get("client_email")
        return email if isinstance(email, str) and email.strip() else None
    except Exception as e:
        logger.warning("google_sheets_read_credentials_email_failed", error=str(e))
        return None


def get_server_status() -> dict:
    """Server-side readiness for Google Sheets (no spreadsheet URL required)."""
    creds_path = _credentials_path()
    configured = creds_path.exists()
    return {
        "server_configured": configured,
        "service_account_email": get_service_account_email() if configured else None,
    }


class SpreadsheetAccessError(Exception):
    """Raised when a spreadsheet URL cannot be accessed."""

    def __init__(self, message: str, *, code: str = "access_denied"):
        super().__init__(message)
        self.code = code


def classify_spreadsheet_error(exc: Exception, *, service_account_email: str | None = None) -> SpreadsheetAccessError:
    """Map Google/gspread failures to user-facing SpreadsheetAccessError."""
    if isinstance(exc, SpreadsheetAccessError):
        return exc

    msg = str(exc).lower()
    share_hint = (
        f" Share the spreadsheet with {service_account_email} (Editor access)."
        if service_account_email
        else " Share the spreadsheet with the service account email shown in Settings."
    )

    if isinstance(exc, gspread.exceptions.SpreadsheetNotFound):
        return SpreadsheetAccessError(
            "Spreadsheet not found. Check the URL or sharing permissions." + share_hint,
            code="not_found",
        )

    if isinstance(exc, gspread.exceptions.APIError):
        status = exc.response.status_code if hasattr(exc, "response") and exc.response else None
        if status in (403, 404):
            return SpreadsheetAccessError(
                "Cannot access spreadsheet." + share_hint,
                code="permission_denied" if status == 403 else "not_found",
            )
        if status == 429:
            return SpreadsheetAccessError(
                "Google Sheets rate limit reached. Try again in a minute.",
                code="rate_limited",
            )

    if "permission" in msg or "403" in msg or "forbidden" in msg:
        return SpreadsheetAccessError("Cannot access spreadsheet." + share_hint, code="permission_denied")
    if "not found" in msg or "404" in msg:
        return SpreadsheetAccessError(
            "Spreadsheet not found. Check the URL." + share_hint,
            code="not_found",
        )

    return SpreadsheetAccessError(f"Could not read spreadsheet: {exc}", code="unknown")


def _get_client() -> gspread.Client:
    global _gc
    if _gc is not None:
        return _gc

    creds_path = _credentials_path()
    if not creds_path.exists():
        raise FileNotFoundError(f"Google credentials file not found: {creds_path}")

    creds = Credentials.from_service_account_file(str(creds_path), scopes=_SCOPES)
    _gc = gspread.authorize(creds)
    return _gc


def _api_call_with_retry(fn, *args, max_retries: int = 3, **kwargs):
    """Execute a Google API call with throttle + exponential backoff on 429."""
    for attempt in range(max_retries):
        _throttle()
        try:
            return fn(*args, **kwargs)
        except gspread.exceptions.APIError as e:
            status = e.response.status_code if hasattr(e, "response") else None
            if status == 429 and attempt < max_retries - 1:
                backoff = 2 ** attempt * 5  # 5s, 10s, 20s
                logger.warning(
                    "google_sheets_rate_limited",
                    attempt=attempt + 1,
                    backoff=backoff,
                )
                time.sleep(backoff)
                continue
            raise
    raise RuntimeError("max retries exhausted")


def _open_spreadsheet(spreadsheet_id: str) -> gspread.Spreadsheet:
    """Open a spreadsheet, reusing a cached object when possible."""
    now = time.monotonic()
    with _spreadsheet_cache_lock:
        cached = _spreadsheet_cache.get(spreadsheet_id)
        if cached and (now - cached[1]) < _SPREADSHEET_OBJ_TTL:
            return cached[0]

    gc = _get_client()
    sh = _api_call_with_retry(gc.open_by_key, spreadsheet_id)

    with _spreadsheet_cache_lock:
        _spreadsheet_cache[spreadsheet_id] = (sh, time.monotonic())
    return sh


def _normalize_tab_key(name: str) -> str:
    """Normalize tab title for fuzzy comparison (trim, collapse spaces, casefold)."""
    return " ".join(str(name).strip().split()).casefold()


def _resolve_worksheet_name(tab_name: str, available_titles: list[str]) -> str | None:
    """Map a configured tab name to the exact worksheet title in the spreadsheet."""
    if tab_name in available_titles:
        return tab_name
    stripped = tab_name.strip()
    if stripped in available_titles:
        return stripped
    norm_map = {_normalize_tab_key(title): title for title in available_titles}
    return norm_map.get(_normalize_tab_key(tab_name))


def _resolve_worksheet(tab_name: str, ws_map: dict[str, gspread.Worksheet]) -> gspread.Worksheet | None:
    canonical = _resolve_worksheet_name(tab_name, list(ws_map.keys()))
    if canonical is None:
        return None
    return ws_map.get(canonical)


def _canonicalize_tab_groups(
    tab_groups: list[list[str]], available_titles: list[str]
) -> tuple[list[list[str]], list[str]]:
    """Rewrite tab group names to exact spreadsheet titles; return warnings for unknown tabs."""
    warnings: list[str] = []
    canonical_groups: list[list[str]] = []
    for group in tab_groups:
        canon_group: list[str] = []
        for tab in group:
            resolved = _resolve_worksheet_name(tab, available_titles)
            if resolved is None:
                warnings.append(
                    f"Tab '{tab}' was not found in the spreadsheet. "
                    f"Available tabs: {available_titles}"
                )
                canon_group.append(tab)
            elif resolved != tab:
                warnings.append(f"Tab '{tab}' matched spreadsheet tab '{resolved}'.")
                canon_group.append(resolved)
            else:
                canon_group.append(tab)
        canonical_groups.append(canon_group)
    return canonical_groups, warnings


def _fetch_worksheet_map(sh: gspread.Spreadsheet) -> dict[str, gspread.Worksheet]:
    """Fetch all worksheets in a single API call, return {title: Worksheet}."""
    all_ws = _api_call_with_retry(sh.worksheets)
    return {ws.title: ws for ws in all_ws}


def _sync_get_all_tabs(spreadsheet_id: str) -> list[str]:
    now = time.monotonic()
    with _tab_cache_lock:
        cached = _tab_cache.get(spreadsheet_id)
        if cached and (now - cached[1]) < _TAB_CACHE_TTL:
            return list(cached[0])

    sh = _open_spreadsheet(spreadsheet_id)
    ws_map = _fetch_worksheet_map(sh)
    tabs = list(ws_map.keys())

    with _tab_cache_lock:
        _tab_cache[spreadsheet_id] = (tabs, time.monotonic())
    return tabs


def _sync_get_tab_states(
    spreadsheet_id: str, tab_names: list[str]
) -> dict[str, tuple[int, set[str]]]:
    """Read column C for multiple tabs.

    Fetches the worksheet list once (1 API call), then reads each tab's
    column C.  Tabs that don't exist in the spreadsheet are logged and skipped.
    """
    sh = _open_spreadsheet(spreadsheet_id)
    ws_map = _fetch_worksheet_map(sh)

    results: dict[str, tuple[int, set[str]]] = {}
    for tab_name in tab_names:
        ws = _resolve_worksheet(tab_name, ws_map)
        if ws is None:
            logger.error(
                "google_sheets_tab_not_found",
                tab=tab_name,
                available_tabs=list(ws_map.keys()),
            )
            continue
        try:
            col_c_values = _api_call_with_retry(ws.col_values, 3)
            existing_urls = {v.strip() for v in col_c_values if v.strip()}
            next_row = max(len(col_c_values) + 1, 3)
            results[tab_name] = (next_row, existing_urls)
        except Exception as e:
            logger.error("google_sheets_read_tab_failed", tab=tab_name, error=str(e))
    return results


def _quote_sheet_range(tab_title: str, a1: str) -> str:
    escaped = tab_title.replace("'", "''")
    return f"'{escaped}'!{a1}"


_WRITE_BATCH_SIZE = 50


def _sync_write_rows(
    spreadsheet_id: str, writes: list[tuple[str, int, str]]
) -> list[tuple[str, int, bool]]:
    """Write rows using batched values updates to reduce API quota usage.

    *writes* is a list of (tab_name, row, url) tuples.
    Returns (tab_name, row, success) for each.
    """
    sh = _open_spreadsheet(spreadsheet_id)
    ws_map = _fetch_worksheet_map(sh)

    date_str = datetime.utcnow().strftime("%Y-%m-%d %H:%M")
    outcomes: list[tuple[str, int, bool]] = []
    resolved_writes: list[tuple[str, str, int, str]] = []

    for tab_name, row, url in writes:
        ws = _resolve_worksheet(tab_name, ws_map)
        if ws is None:
            logger.error(
                "google_sheets_tab_not_found_for_write",
                tab=tab_name,
                available_tabs=list(ws_map.keys()),
            )
            outcomes.append((tab_name, row, False))
            continue
        resolved_writes.append((tab_name, ws.title, row, url))

    for batch_start in range(0, len(resolved_writes), _WRITE_BATCH_SIZE):
        chunk = resolved_writes[batch_start : batch_start + _WRITE_BATCH_SIZE]
        payload = {
            "valueInputOption": "USER_ENTERED",
            "data": [
                {
                    "range": _quote_sheet_range(title, f"B{row}:C{row}"),
                    "values": [[date_str, url]],
                }
                for _tab_name, title, row, url in chunk
            ],
        }
        try:
            _api_call_with_retry(sh.values_batch_update, payload)
            for tab_name, _title, row, _url in chunk:
                outcomes.append((tab_name, row, True))
        except Exception as e:
            logger.error("google_sheets_batch_write_failed", error=str(e), batch_size=len(chunk))
            for tab_name, _title, row, _url in chunk:
                outcomes.append((tab_name, row, False))
        if batch_start + _WRITE_BATCH_SIZE < len(resolved_writes):
            time.sleep(_API_CALL_GAP)

    return outcomes


async def verify_spreadsheet(spreadsheet_url: str) -> dict:
    """Validate spreadsheet access and return tab metadata."""
    spreadsheet_id = _extract_spreadsheet_id(spreadsheet_url)
    if not spreadsheet_id:
        raise ValueError(f"Could not extract spreadsheet ID from URL: {spreadsheet_url}")

    creds_path = _credentials_path()
    if not creds_path.exists():
        raise FileNotFoundError(f"Google credentials file not found: {creds_path}")

    service_email = get_service_account_email()
    try:
        tabs = await asyncio.to_thread(_sync_get_all_tabs, spreadsheet_id)
    except Exception as e:
        raise classify_spreadsheet_error(e, service_account_email=service_email) from e

    return {
        "tabs": tabs,
        "tab_count": len(tabs),
        "spreadsheet_id": spreadsheet_id,
    }


async def get_all_tabs(spreadsheet_url: str) -> list[str]:
    """Fetch all tab names from a Google Spreadsheet URL."""
    result = await verify_spreadsheet(spreadsheet_url)
    return result["tabs"]


async def get_all_tabs_by_id(spreadsheet_id: str) -> list[str]:
    return await asyncio.to_thread(_sync_get_all_tabs, spreadsheet_id)


async def get_user_config(user_id: str, session: AsyncSession | None = None) -> GoogleSheetsConfig | None:
    async def _fetch(s: AsyncSession) -> GoogleSheetsConfig | None:
        r = await s.execute(
            select(GoogleSheetsConfig).where(GoogleSheetsConfig.user_id == user_id)
        )
        return r.scalar_one_or_none()

    if session:
        return await _fetch(session)
    async with get_session() as s:
        return await _fetch(s)


async def delete_user_config(user_id: str) -> bool:
    """Remove the user's Google Sheets integration config."""
    async with get_session() as session:
        r = await session.execute(
            select(GoogleSheetsConfig).where(GoogleSheetsConfig.user_id == user_id)
        )
        config = r.scalar_one_or_none()
        if not config:
            return False
        await session.delete(config)
        return True


async def save_config(
    user_id: str,
    spreadsheet_url: str,
    tab_groups: list[list[str]],
    auto_post_threshold: int = 75,
) -> GoogleSheetsConfig:
    """Create or update the user's Google Sheets config."""
    spreadsheet_id = _extract_spreadsheet_id(spreadsheet_url)
    if not spreadsheet_id:
        raise ValueError("Invalid Google Sheets URL")

    async with get_session() as session:
        r = await session.execute(
            select(GoogleSheetsConfig).where(GoogleSheetsConfig.user_id == user_id)
        )
        config = r.scalar_one_or_none()

        if config:
            config.spreadsheet_url = spreadsheet_url
            config.spreadsheet_id = spreadsheet_id
            config.tab_groups = tab_groups
            config.auto_post_threshold = _clamp_auto_post_threshold(auto_post_threshold)
        else:
            import uuid
            config = GoogleSheetsConfig(
                id=str(uuid.uuid4()),
                user_id=user_id,
                spreadsheet_url=spreadsheet_url,
                spreadsheet_id=spreadsheet_id,
                tab_groups=tab_groups,
                round_robin_index=0,
                auto_post_threshold=_clamp_auto_post_threshold(auto_post_threshold),
            )
            session.add(config)

        await session.flush()
        return config


def _clamp_auto_post_threshold(value: int) -> int:
    return max(0, min(100, int(value)))


async def update_auto_post_threshold(user_id: str, auto_post_threshold: int) -> GoogleSheetsConfig:
    """Update only the auto-post threshold for an existing integration."""
    threshold = _clamp_auto_post_threshold(auto_post_threshold)
    async with get_session() as session:
        r = await session.execute(
            select(GoogleSheetsConfig).where(GoogleSheetsConfig.user_id == user_id)
        )
        config = r.scalar_one_or_none()
        if not config:
            raise ValueError("Google Sheets integration is not configured")
        config.auto_post_threshold = threshold
        await session.flush()
        return config


async def distribute_jobs(user_id: str, job_ids: list[str]) -> dict:
    """
    Post job URLs to the configured Google Sheet using tab groups + round-robin.

    Deduplication is based on the **actual sheet content** - if a URL already
    exists in any configured tab, it is skipped.  The local ``sheet_posted_at``
    flag is set/synced but never used as the skip criterion.

    Returns a summary dict with posted, skipped_already_in_sheet, and
    skipped_not_found counts.
    """
    summary: dict = {
        "posted": [],
        "partial": [],
        "failed": [],
        "skipped_already_in_sheet": 0,
        "skipped_not_found": 0,
    }

    async with get_session() as session:
        config = await get_user_config(user_id, session)
        if not config or not config.tab_groups:
            logger.warning("google_sheets_no_config", user_id=user_id)
            return summary

        groups: list[list[str]] = config.tab_groups
        if not groups or all(len(g) == 0 for g in groups):
            logger.warning("google_sheets_empty_groups", user_id=user_id)
            return summary

        idx = config.round_robin_index or 0

        # Read ALL configured tabs in one thread call (single Spreadsheet object).
        all_tab_names = list({t for g in groups for t in g})
        tab_next_row: dict[str, int] = {}
        tab_urls: dict[str, set[str]] = {}

        try:
            tab_states = await asyncio.to_thread(
                _sync_get_tab_states, config.spreadsheet_id, all_tab_names
            )
            for tab_name, (next_row, existing) in tab_states.items():
                tab_next_row[tab_name] = next_row
                tab_urls[tab_name] = existing
        except Exception as e:
            logger.error("google_sheets_read_tabs_failed", error=str(e))

        # Fill defaults for tabs that weren't successfully read (missing or errored).
        for tab_name in all_tab_names:
            tab_next_row.setdefault(tab_name, 3)
            tab_urls.setdefault(tab_name, set())

        all_existing_urls: set[str] = set()
        for urls in tab_urls.values():
            all_existing_urls.update(urls)

        # Collect all writes, then execute them in a single thread call.
        pending_writes: list[tuple[str, int, str]] = []  # (tab, row, url)
        # Each plan entry: (job_id, group_index, [(tab, row), ...])
        job_write_plan: list[tuple[str, int, list[tuple[str, int]]]] = []

        for job_id in job_ids:
            r = await session.execute(
                select(Job).where(Job.id == job_id)
            )
            job = r.scalar_one_or_none()
            if not job:
                logger.warning("google_sheets_job_not_found", job_id=job_id)
                summary["skipped_not_found"] += 1
                continue

            url = (job.source_url or "").strip()
            if url in all_existing_urls:
                logger.info("google_sheets_url_already_in_sheet", job_id=job_id, url=url)
                summary["skipped_already_in_sheet"] += 1
                if not job.sheet_posted_at:
                    job.sheet_posted_at = datetime.utcnow()
                continue

            group_idx = idx % len(groups)
            group = groups[group_idx]
            job_tabs: list[tuple[str, int]] = []
            for tab_name in group:
                row = tab_next_row[tab_name]
                pending_writes.append((tab_name, row, url))
                job_tabs.append((tab_name, row))
                tab_next_row[tab_name] = row + 1

            job_write_plan.append((job_id, group_idx, job_tabs))
            all_existing_urls.add(url)
            idx += 1

        # Execute all writes in one threaded batch (single Spreadsheet object).
        write_outcomes: dict[tuple[str, int], bool] = {}
        if pending_writes:
            results = await asyncio.to_thread(
                _sync_write_rows, config.spreadsheet_id, pending_writes
            )
            for tab_name, row, ok in results:
                write_outcomes[(tab_name, row)] = ok

        for job_id, group_idx, job_tabs in job_write_plan:
            expected_tabs = [t for t, _r in job_tabs]
            posted_tabs = [t for t, r in job_tabs if write_outcomes.get((t, r), False)]
            posted_rows = [r for t, r in job_tabs if write_outcomes.get((t, r), False)]
            failed_tabs = [t for t in expected_tabs if t not in posted_tabs]

            if len(posted_tabs) == len(expected_tabs):
                r = await session.execute(
                    select(Job).where(Job.id == job_id)
                )
                job = r.scalar_one_or_none()
                if job:
                    job.sheet_posted_at = datetime.utcnow()

                summary["posted"].append({
                    "job_id": job_id,
                    "group_index": group_idx,
                    "tabs": posted_tabs,
                    "rows": posted_rows,
                })
                logger.info(
                    "google_sheets_job_posted",
                    job_id=job_id,
                    tabs=posted_tabs,
                )
            elif posted_tabs:
                summary["partial"].append({
                    "job_id": job_id,
                    "group_index": group_idx,
                    "tabs": posted_tabs,
                    "rows": posted_rows,
                    "failed_tabs": failed_tabs,
                })
                logger.warning(
                    "google_sheets_job_partially_posted",
                    job_id=job_id,
                    tabs=posted_tabs,
                    failed_tabs=failed_tabs,
                )
            else:
                summary["failed"].append({
                    "job_id": job_id,
                    "group_index": group_idx,
                    "failed_tabs": failed_tabs,
                })
                logger.error(
                    "google_sheets_job_post_failed",
                    job_id=job_id,
                    failed_tabs=failed_tabs,
                )

        config.round_robin_index = idx
        return summary


async def auto_post_if_eligible(user_id: str, job_id: str, match_score: int) -> None:
    """
    Called after match analysis. If score meets threshold and user has sheets
    configured, post the job URL automatically.
    """
    try:
        config = await get_user_config(user_id)
        if not config or not config.tab_groups:
            return
        if match_score < (config.auto_post_threshold or 75):
            logger.info(
                "google_sheets_auto_post_below_threshold",
                job_id=job_id,
                score=match_score,
                threshold=config.auto_post_threshold,
            )
            return
        result = await distribute_jobs(user_id, [job_id])
        if result["posted"]:
            logger.info("google_sheets_auto_posted", job_id=job_id, result=result["posted"][0])
    except Exception as e:
        logger.warning(
            "google_sheets_auto_post_failed",
            job_id=job_id,
            error=str(e),
        )
