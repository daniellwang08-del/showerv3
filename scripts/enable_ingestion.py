"""Turn ingestion back on in shadow mode, on a daily cadence.

Two settings, changed together because they serve one goal:

  match_engine = shadow    The LLM stays authoritative and the vector engine
                           scores the same pair alongside it, storing both in
                           match_engine_comparisons. That table has never had a
                           row, which is why "is the vector engine as accurate
                           as the LLM" has never had a direct answer -- the two
                           have never scored the same job. Costs LLM spend on
                           every analysis, which is the price of the answer.

  schedule enabled, daily  The schedule has been off since 2 August. It was
                           configured for hourly syncs across four platforms;
                           daily first, because the last run has been stuck at
                           status "queued" for five weeks and a full run should
                           be seen to complete before committing to 24x the
                           volume.

Goes through save_schedule and upsert_settings rather than writing the rows
directly, so the same validation and normalisation the admin UI relies on
applies here.

Defaults to a dry run. Pass --apply to write.

Usage:
    python -m scripts.enable_ingestion
    python -m scripts.enable_ingestion --apply
"""

from __future__ import annotations

import argparse
import asyncio
import json

from sqlalchemy import text

from app.services.job_sync_schedule_service import (
    SCHEDULE_KEY,
    get_schedule,
    save_schedule,
    schedule_public_view,
)
from app.services.system_settings_service import upsert_settings
from app.storage.database import close_database, get_session, init_database


async def _run(apply_changes: bool) -> None:
    await init_database()
    try:
        async with get_session() as session:
            before = await get_schedule(session)
            engine_row = (
                await session.execute(
                    text("SELECT value FROM system_settings WHERE key = 'match_engine'")
                )
            ).scalar()
            comparisons = (
                await session.execute(
                    text("SELECT count(*) FROM match_engine_comparisons")
                )
            ).scalar()

            print()
            print("Before")
            print(f"  match_engine          {engine_row or '(unset, config default)'}")
            print(f"  shadow comparisons    {comparisons}")
            print(f"  schedule enabled      {before.get('enabled')}")
            print(f"  cadence               {before.get('cadence')}")
            print(f"  interval_hours        {before.get('interval_hours')}")
            print(f"  daily_time            {before.get('daily_time')} {before.get('timezone')}")
            print(f"  last_run_at           {before.get('last_run_at')}")
            print(f"  last_run_status       {before.get('last_run_status')}")
            print(f"  spiders               {before.get('spider_names')}")

            if not apply_changes:
                print()
                print("Would change")
                print("  match_engine          -> shadow")
                print("  schedule enabled      -> True")
                print("  cadence               -> daily")
                print()
                print("  dry run, nothing written. Pass --apply to commit.")
                print()
                return

            await upsert_settings(
                session, {"match_engine": "shadow"}, updated_by_user_id=None
            )
            # updated_by_user_id is left None deliberately: save_schedule
            # overwrites run_as_user_id when it is supplied, and the existing
            # value is the account the sync is meant to run as.
            after = await save_schedule(
                session,
                {"enabled": True, "cadence": "daily"},
                updated_by_user_id=None,
            )
            await session.commit()

            view = schedule_public_view(after)
            print()
            print("After")
            print("  match_engine          shadow")
            print(f"  schedule enabled      {after.get('enabled')}")
            print(f"  cadence               {after.get('cadence')}")
            print(f"  daily_time            {after.get('daily_time')} {after.get('timezone')}")
            print(f"  next_run_at           {view.get('next_run_at')}")
            print(f"  run_as_user_id        {after.get('run_as_user_id')}")
            print()
            stored = (
                await session.execute(
                    text("SELECT value FROM system_settings WHERE key = :k"),
                    {"k": SCHEDULE_KEY},
                )
            ).scalar()
            print("  stored schedule row")
            print(f"    {json.dumps(json.loads(stored), sort_keys=True)}")
            print()
    finally:
        await close_database()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="write the changes")
    args = parser.parse_args()
    asyncio.run(_run(args.apply))


if __name__ == "__main__":
    main()
