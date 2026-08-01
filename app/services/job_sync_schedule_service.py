"""Admin-configurable scheduled job sync (interval or daily).

Stored as JSON in ``system_settings`` under key ``job_sync_schedule``.
The scraper worker ticks every minute and enqueues ``run_scraper_task`` when due.
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any, Literal
from zoneinfo import ZoneInfo

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.models.database import SystemSetting
from app.scraper.runner import SPIDER_META

logger = get_logger(__name__)

SCHEDULE_KEY = "job_sync_schedule"

Cadence = Literal["interval", "daily"]
SyncMode = Literal["incremental", "date_backfill"]

ALLOWED_TIMEZONES: tuple[str, ...] = (
    "America/Los_Angeles",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "UTC",
)

_TIME_RE = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")


def default_schedule() -> dict[str, Any]:
    return {
        "enabled": False,
        "cadence": "daily",
        "interval_hours": 4,
        "daily_time": "04:30",
        "timezone": "America/Los_Angeles",
        "sync_mode": "incremental",
        "lookback_days": 2,
        "spider_names": None,
        "run_as_user_id": None,
        "last_run_at": None,
        "last_run_status": None,
        "last_run_message": None,
    }


def _parse_daily_time(value: str) -> tuple[int, int]:
    match = _TIME_RE.match((value or "").strip())
    if not match:
        raise ValueError("daily_time must be HH:MM (24h)")
    return int(match.group(1)), int(match.group(2))


def _resolve_tz(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except Exception as exc:
        raise ValueError(f"Invalid timezone: {name}") from exc


def _parse_iso_utc(value: str | None) -> datetime | None:
    if not value:
        return None
    raw = value.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    dt = datetime.fromisoformat(raw)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _iso_utc(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def normalize_schedule(raw: dict[str, Any] | None) -> dict[str, Any]:
    """Validate and coerce a schedule payload (partial updates allowed)."""
    base = default_schedule()
    if not raw:
        return base

    enabled = bool(raw.get("enabled", base["enabled"]))
    cadence = str(raw.get("cadence", base["cadence"])).strip().lower()
    if cadence not in ("interval", "daily"):
        raise ValueError("cadence must be 'interval' or 'daily'")

    try:
        interval_hours = int(raw.get("interval_hours", base["interval_hours"]))
    except (TypeError, ValueError) as exc:
        raise ValueError("interval_hours must be an integer") from exc
    if not 1 <= interval_hours <= 168:
        raise ValueError("interval_hours must be between 1 and 168")

    daily_time_raw = str(raw.get("daily_time", base["daily_time"])).strip()
    daily_h, daily_m = _parse_daily_time(daily_time_raw)
    daily_time = f"{daily_h:02d}:{daily_m:02d}"

    timezone_name = str(raw.get("timezone", base["timezone"])).strip()
    if timezone_name not in ALLOWED_TIMEZONES:
        raise ValueError(
            f"timezone must be one of: {', '.join(ALLOWED_TIMEZONES)}"
        )
    # Allowlist is authoritative for API validation. ZoneInfo may need the
    # ``tzdata`` package on Windows; runtime resolution happens at tick time.

    sync_mode = str(raw.get("sync_mode", base["sync_mode"])).strip().lower()
    if sync_mode not in ("incremental", "date_backfill"):
        raise ValueError("sync_mode must be 'incremental' or 'date_backfill'")

    try:
        lookback_days = int(raw.get("lookback_days", base["lookback_days"]))
    except (TypeError, ValueError) as exc:
        raise ValueError("lookback_days must be an integer") from exc
    if not 1 <= lookback_days <= 90:
        raise ValueError("lookback_days must be between 1 and 90")

    spider_names = raw.get("spider_names", base["spider_names"])
    if spider_names is not None:
        if not isinstance(spider_names, list) or not spider_names:
            raise ValueError("spider_names must be a non-empty list or null")
        unknown = [n for n in spider_names if n not in SPIDER_META]
        if unknown:
            raise ValueError(f"Unknown spider(s): {unknown}")

    run_as_user_id = raw.get("run_as_user_id", base["run_as_user_id"])
    if run_as_user_id is not None:
        run_as_user_id = str(run_as_user_id).strip() or None

    # Preserve runtime status fields when present (or from DB merge).
    last_run_at = raw.get("last_run_at", base["last_run_at"])
    last_run_status = raw.get("last_run_status", base["last_run_status"])
    last_run_message = raw.get("last_run_message", base["last_run_message"])
    if last_run_at is not None:
        last_run_at = _iso_utc(_parse_iso_utc(str(last_run_at)))

    return {
        "enabled": enabled,
        "cadence": cadence,
        "interval_hours": interval_hours,
        "daily_time": daily_time,
        "timezone": timezone_name,
        "sync_mode": sync_mode,
        "lookback_days": lookback_days,
        "spider_names": spider_names,
        "run_as_user_id": run_as_user_id,
        "last_run_at": last_run_at,
        "last_run_status": last_run_status,
        "last_run_message": last_run_message,
    }


def compute_next_run_at(
    schedule: dict[str, Any],
    *,
    now: datetime | None = None,
) -> datetime | None:
    if not schedule.get("enabled"):
        return None

    now_utc = now or datetime.now(timezone.utc)
    if now_utc.tzinfo is None:
        now_utc = now_utc.replace(tzinfo=timezone.utc)

    last = _parse_iso_utc(schedule.get("last_run_at"))
    cadence = schedule.get("cadence") or "daily"

    if cadence == "interval":
        hours = max(1, int(schedule.get("interval_hours") or 4))
        if last is None:
            return now_utc
        return last + timedelta(hours=hours)

    hour, minute = _parse_daily_time(str(schedule.get("daily_time") or "04:30"))
    tz = _resolve_tz(str(schedule.get("timezone") or "UTC"))
    local_now = now_utc.astimezone(tz)
    target_local = local_now.replace(hour=hour, minute=minute, second=0, microsecond=0)

    if last is not None:
        last_local = last.astimezone(tz)
        if last_local >= target_local:
            target_local = target_local + timedelta(days=1)
    elif local_now >= target_local:
        target_local = target_local + timedelta(days=1)

    return target_local.astimezone(timezone.utc)


def is_schedule_due(schedule: dict[str, Any], *, now: datetime | None = None) -> bool:
    next_at = compute_next_run_at(schedule, now=now)
    if next_at is None:
        return False
    now_utc = now or datetime.now(timezone.utc)
    if now_utc.tzinfo is None:
        now_utc = now_utc.replace(tzinfo=timezone.utc)
    return now_utc >= next_at


def schedule_public_view(schedule: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
    view = dict(schedule)
    next_at = compute_next_run_at(schedule, now=now)
    view["next_run_at"] = _iso_utc(next_at)
    view["allowed_timezones"] = list(ALLOWED_TIMEZONES)
    return view


async def get_schedule(session: AsyncSession) -> dict[str, Any]:
    result = await session.execute(
        select(SystemSetting).where(SystemSetting.key == SCHEDULE_KEY)
    )
    row = result.scalar_one_or_none()
    if not row or not row.value:
        return default_schedule()
    try:
        raw = json.loads(row.value)
    except json.JSONDecodeError:
        logger.warning("job_sync_schedule_corrupt_json")
        return default_schedule()
    if not isinstance(raw, dict):
        return default_schedule()
    try:
        return normalize_schedule({**default_schedule(), **raw})
    except ValueError:
        logger.warning("job_sync_schedule_invalid_stored")
        return default_schedule()


async def save_schedule(
    session: AsyncSession,
    payload: dict[str, Any],
    *,
    updated_by_user_id: str | None,
) -> dict[str, Any]:
    current = await get_schedule(session)
    merged = {
        **current,
        **payload,
        # Keep runtime fields unless explicitly provided.
        "last_run_at": payload.get("last_run_at", current.get("last_run_at")),
        "last_run_status": payload.get("last_run_status", current.get("last_run_status")),
        "last_run_message": payload.get("last_run_message", current.get("last_run_message")),
    }
    if updated_by_user_id:
        merged["run_as_user_id"] = updated_by_user_id

    # Saving config should not wipe next-run math incorrectly: if cadence/time
    # changed, keep last_run so we don't immediately re-fire unless interval is due.
    schedule = normalize_schedule(merged)
    now = datetime.now(timezone.utc)
    result = await session.execute(
        select(SystemSetting).where(SystemSetting.key == SCHEDULE_KEY)
    )
    row = result.scalar_one_or_none()
    serialized = json.dumps(schedule, separators=(",", ":"), sort_keys=True)
    if row:
        row.value = serialized
        row.updated_at = now.replace(tzinfo=None)
        row.updated_by_user_id = updated_by_user_id
    else:
        session.add(
            SystemSetting(
                key=SCHEDULE_KEY,
                value=serialized,
                updated_at=now.replace(tzinfo=None),
                updated_by_user_id=updated_by_user_id,
            )
        )
    await session.flush()
    logger.info(
        "job_sync_schedule_saved",
        enabled=schedule["enabled"],
        cadence=schedule["cadence"],
        updated_by=updated_by_user_id,
    )
    return schedule


async def mark_schedule_run(
    session: AsyncSession,
    *,
    status: str,
    message: str,
    ran_at: datetime | None = None,
) -> dict[str, Any]:
    schedule = await get_schedule(session)
    when = ran_at or datetime.now(timezone.utc)
    schedule["last_run_at"] = _iso_utc(when)
    schedule["last_run_status"] = status
    schedule["last_run_message"] = (message or "")[:500]
    schedule = normalize_schedule(schedule)

    result = await session.execute(
        select(SystemSetting).where(SystemSetting.key == SCHEDULE_KEY)
    )
    row = result.scalar_one_or_none()
    serialized = json.dumps(schedule, separators=(",", ":"), sort_keys=True)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if row:
        row.value = serialized
        row.updated_at = now
    else:
        session.add(
            SystemSetting(
                key=SCHEDULE_KEY,
                value=serialized,
                updated_at=now,
            )
        )
    await session.flush()
    return schedule


async def is_scrape_running(session: AsyncSession) -> bool:
    result = await session.execute(
        text(
            "SELECT 1 FROM scrape_runs WHERE status = 'running' "
            "AND started_at >= now() - INTERVAL '31 minutes' LIMIT 1"
        )
    )
    return result.first() is not None


def build_sync_args(schedule: dict[str, Any]) -> dict[str, Any]:
    """Args for enqueueing ``run_scraper_task`` from a schedule."""
    sync_mode: SyncMode = schedule.get("sync_mode") or "incremental"
    spider_names = schedule.get("spider_names")
    posted_since = None
    posted_until = None
    if sync_mode == "date_backfill":
        days = max(1, int(schedule.get("lookback_days") or 2))
        until = date.today()
        posted_since = (until - timedelta(days=days - 1)).isoformat()
        posted_until = until.isoformat()

    spider = "all"
    if spider_names and len(spider_names) == 1:
        spider = spider_names[0]
    elif spider_names:
        spider = "all"

    return {
        "spider_name": spider,
        "sync_mode": sync_mode,
        "posted_since": posted_since,
        "posted_until": posted_until,
        "spider_names": spider_names,
        "user_id": str(schedule.get("run_as_user_id") or "system"),
    }
