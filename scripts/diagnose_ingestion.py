"""Why no new jobs are arriving.

Accuracy work on the match engine has run out of road: every remaining
improvement measures 1-2 AUC points and the 354 existing labels cannot resolve
a difference that small. More labels only accumulate if jobs are being
ingested, so this establishes which of the ingestion paths is idle and why.

There are two, both cron-driven from ScraperWorkerSettings:

  admin schedule    check_job_sync_schedule_task ticks every minute and runs a
                    platform sync when the configured cadence is due. Governed
                    by a single system_settings row, which defaults to disabled.
  per-user sources  cron_sync_user_job_sources runs at :05 and :35 over every
                    enabled row in user_job_sources past its interval. No rows
                    means the pass is a no-op.

Neither failing is loud: a disabled schedule returns "disabled" and an empty
source table returns success having done nothing, so the pipeline can sit idle
indefinitely while every component reports healthy.

Read-only; no writes.

Usage:
    python -m scripts.diagnose_ingestion
"""

from __future__ import annotations

import asyncio
import json

from sqlalchemy import text

from app.services.job_sync_schedule_service import (
    SCHEDULE_KEY,
    default_schedule,
    schedule_public_view,
)
from app.storage.database import close_database, get_session, init_database


async def _scalar(session, sql: str, **params):
    return (await session.execute(text(sql), params)).scalar()


async def _run() -> None:
    await init_database()
    try:
        async with get_session() as session:
            raw = await _scalar(
                session,
                "SELECT value FROM system_settings WHERE key = :k",
                k=SCHEDULE_KEY,
            )
            print()
            print("Admin sync schedule")
            if not raw:
                print("  no system_settings row; falling back to the default")
                schedule = default_schedule()
            else:
                try:
                    schedule = json.loads(raw)
                except json.JSONDecodeError:
                    print("  row present but not valid JSON")
                    schedule = default_schedule()
            view = schedule_public_view(schedule)
            for key in (
                "enabled",
                "cadence",
                "interval_hours",
                "daily_time",
                "timezone",
                "sync_mode",
                "next_run_at",
                "last_run_at",
                "last_run_status",
                "last_run_message",
            ):
                print(f"  {key:<20} {view.get(key)}")

            print()
            print("Per-user job sources")
            for label, sql in (
                ("rows", "SELECT count(*) FROM user_job_sources"),
                (
                    "enabled",
                    "SELECT count(*) FROM user_job_sources WHERE enabled IS TRUE",
                ),
            ):
                try:
                    print(f"  {label:<20} {await _scalar(session, sql)}")
                except Exception as exc:  # table/column may not exist
                    print(f"  {label:<20} unavailable ({type(exc).__name__})")

            print()
            print("Job-site connections")
            try:
                print(
                    f"  rows                 "
                    f"{await _scalar(session, 'SELECT count(*) FROM user_job_site_connections')}"
                )
            except Exception as exc:
                print(f"  rows                 unavailable ({type(exc).__name__})")

            print()
            print("Jobs ingested by day (last 14 days)")
            rows = (
                await session.execute(
                    text(
                        """
                        SELECT created_at::date AS day, count(*) AS n
                        FROM jobs
                        WHERE created_at > now() - interval '14 days'
                        GROUP BY 1 ORDER BY 1 DESC
                        """
                    )
                )
            ).all()
            if not rows:
                newest = await _scalar(session, "SELECT max(created_at) FROM jobs")
                total = await _scalar(session, "SELECT count(*) FROM jobs")
                print(f"  none in 14 days. newest job {newest}, {total} total")
            else:
                for day, count in rows:
                    print(f"  {day}   {count}")

            # Enabling the schedule is pointless if the spiders it would run
            # cannot authenticate: the tick fails with auth_required and marks
            # the schedule failed without ingesting anything.
            print()
            print("Spider auth readiness for the configured sync")
            try:
                from app.scraper.runner import check_spider_auth
                from app.services.job_sync_schedule_service import build_sync_args
                from app.services.scraper_sync_service import build_run_plan

                from datetime import date as date_cls

                args = build_sync_args(schedule)
                plan = build_run_plan(
                    spider_name=args["spider_name"],
                    spider_names=args.get("spider_names"),
                    sync_mode=args["sync_mode"],
                    posted_since=(
                        date_cls.fromisoformat(args["posted_since"])
                        if args.get("posted_since")
                        else None
                    ),
                    posted_until=(
                        date_cls.fromisoformat(args["posted_until"])
                        if args.get("posted_until")
                        else None
                    ),
                )
                for name, _kwargs in plan:
                    auth = check_spider_auth(name)
                    state = "ready" if auth.get("ok") else "BLOCKED"
                    extra = ""
                    if auth.get("token_expired"):
                        extra = "  token expired"
                    elif auth.get("requires_auth") and not auth.get("auth_configured"):
                        extra = f"  run: {auth.get('auth_setup_command')}"
                    print(f"  {name:<22} {state}{extra}")
            except Exception as exc:
                print(f"  could not evaluate ({type(exc).__name__}: {exc})")

            print()
            print("Recent scheduler/sync log events")
            events = (
                await session.execute(
                    text(
                        """
                        SELECT created_at, event, message
                        FROM system_log_events
                        WHERE event LIKE 'job_sync%%'
                           OR event LIKE 'sync_user_job%%'
                           OR event LIKE '%%scraper%%'
                        ORDER BY created_at DESC
                        LIMIT 15
                        """
                    )
                )
            ).all()
            if not events:
                print("  none recorded")
            for created, event, message in events:
                print(f"  {created}  {event}  {str(message or '')[:70]}")
            print()
    finally:
        await close_database()


if __name__ == "__main__":
    asyncio.run(_run())
