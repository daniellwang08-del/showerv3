"""Subprocess-based spider runner.

Scrapy runs on Twisted which conflicts with asyncio, so each spider is
executed as a subprocess via ``python -m scrapy crawl <name>``.  This is
the same pattern used by the original scheduler/tasks.py.
"""

import asyncio
import logging
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parents[2]

ALL_SPIDERS: list[tuple[str, dict[str, str]]] = [
    ("remoterocketship", {
        "pages": "100",
        "job_titles": (
            "Software Engineer,Backend Engineer,Frontend Engineer,"
            "Application Engineer,AI Engineer,Data Engineer,"
            "Artificial Intelligence,Cloud Engineer,"
            "Implementation Specialist,Computer Vision Engineer,"
            "DevOps Engineer,Infrastructure Engineer,"
            "Solutions Engineer,IT Support"
        ),
        "locations": "United States",
        "min_salary": "140000",
        "sort": "DateAdded",
    }),
    ("welcometothejungle", {"pages": "5"}),
    ("ziprecruiter", {"query": "software engineer", "pages": "3"}),
    ("indeed", {"query": "software engineer", "pages": "3"}),
    ("glassdoor", {"query": "software engineer", "pages": "3"}),
    ("adzuna", {"pages": "3"}),
    ("jobright", {"pages": "5"}),
]

SPIDER_META: dict[str, dict] = {
    "adzuna": {"label": "Adzuna", "requires_auth": False, "auth_platform": None},
    "remoterocketship": {"label": "RemoteRocketship", "requires_auth": True, "auth_platform": "rrs"},
    "jobright": {"label": "Jobright", "requires_auth": True, "auth_platform": "jobright"},
    "welcometothejungle": {"label": "Welcome to the Jungle", "requires_auth": False, "auth_platform": None},
    "ziprecruiter": {"label": "ZipRecruiter", "requires_auth": False, "auth_platform": None},
    "indeed": {"label": "Indeed", "requires_auth": False, "auth_platform": None},
    "glassdoor": {"label": "Glassdoor", "requires_auth": False, "auth_platform": None},
}


def check_spider_auth(spider_name: str) -> dict:
    """Check whether a spider's auth requirements are met.

    Returns dict with keys: ok, requires_auth, auth_configured, auth_saved_at,
    auth_setup_command.
    """
    from app.scraper.auth import session_status, PLATFORMS

    meta = SPIDER_META.get(spider_name, {})
    if not meta.get("requires_auth"):
        return {"ok": True, "requires_auth": False, "auth_configured": False,
                "auth_saved_at": None, "auth_setup_command": None}

    platform_key = meta.get("auth_platform")
    if not platform_key or platform_key not in PLATFORMS:
        return {"ok": True, "requires_auth": True, "auth_configured": False,
                "auth_saved_at": None, "auth_setup_command": None}

    status = session_status(platform_key)
    configured = status.get("exists", False) and not status.get("corrupt", False)
    saved_at = status.get("saved_at") if configured else None
    cmd = f"python -m app.scraper.auth setup {platform_key}"

    return {
        "ok": configured,
        "requires_auth": True,
        "auth_configured": configured,
        "auth_saved_at": saved_at,
        "auth_setup_command": cmd,
    }


def get_available_spiders() -> list[dict]:
    """Return metadata about every registered spider, including live auth status."""
    result = []
    for name, meta in SPIDER_META.items():
        entry = {"name": name, "label": meta["label"], "requires_auth": meta["requires_auth"]}
        auth = check_spider_auth(name)
        entry["auth_configured"] = auth["auth_configured"]
        entry["auth_saved_at"] = auth["auth_saved_at"]
        entry["auth_setup_command"] = auth["auth_setup_command"]
        result.append(entry)
    return result


def _running_scrape_run_stats(spider_name: str, started_after: datetime) -> dict | None:
    """Return live counters for the in-progress scrape_runs row, if any."""
    try:
        from app.scraper.models.db import get_engine, ScrapeRun
        from sqlalchemy.orm import sessionmaker

        if started_after.tzinfo is not None:
            started_after = started_after.astimezone(timezone.utc).replace(tzinfo=None)
        cutoff = started_after - timedelta(seconds=15)

        engine = get_engine()
        session = sessionmaker(bind=engine)()
        try:
            row = (
                session.query(ScrapeRun)
                .filter(
                    ScrapeRun.spider_name == spider_name,
                    ScrapeRun.status == "running",
                    ScrapeRun.started_at >= cutoff,
                )
                .order_by(ScrapeRun.started_at.desc())
                .first()
            )
            if not row:
                return None
            return {
                "scrape_run_id": row.id,
                "spider_name": row.spider_name,
                "items_scraped": row.items_scraped or 0,
                "items_new": row.items_new or 0,
                "items_updated": row.items_updated or 0,
                "started_at": row.started_at,
            }
        finally:
            session.close()
    except Exception as e:
        logger.warning("scrape_run_stats_lookup_failed: %s", e)
        return None


def _mark_scrape_run_interrupted(spider_name: str, started_after: datetime) -> None:
    """Mark the active scrape_runs row interrupted when the subprocess is killed."""
    try:
        from app.scraper.models.db import get_engine, ScrapeRun, utcnow_naive
        from sqlalchemy.orm import sessionmaker

        if started_after.tzinfo is not None:
            started_after = started_after.astimezone(timezone.utc).replace(tzinfo=None)
        cutoff = started_after - timedelta(seconds=15)

        engine = get_engine()
        session = sessionmaker(bind=engine)()
        try:
            row = (
                session.query(ScrapeRun)
                .filter(
                    ScrapeRun.spider_name == spider_name,
                    ScrapeRun.status == "running",
                    ScrapeRun.started_at >= cutoff,
                )
                .order_by(ScrapeRun.started_at.desc())
                .first()
            )
            if row:
                row.status = "interrupted"
                row.finished_at = utcnow_naive()
                session.commit()
        finally:
            session.close()
    except Exception as e:
        logger.warning("scrape_run_interrupt_mark_failed: %s", e)


def _latest_scrape_run_id(spider_name: str, started_after: datetime) -> str | None:
    """Read the scrape_runs row for the subprocess that just finished.

    ``started_after`` is UTC-naive (captured just before launching Scrapy).
    Uses the sync scraper engine so this can be called from the async runner
    without crossing into the running event loop.
    """
    try:
        from app.scraper.models.db import get_engine, ScrapeRun
        from sqlalchemy.orm import sessionmaker

        if started_after.tzinfo is not None:
            started_after = started_after.astimezone(timezone.utc).replace(tzinfo=None)
        cutoff = started_after - timedelta(seconds=15)

        engine = get_engine()
        session = sessionmaker(bind=engine)()
        try:
            row = (
                session.query(ScrapeRun)
                .filter(
                    ScrapeRun.spider_name == spider_name,
                    ScrapeRun.started_at >= cutoff,
                )
                .order_by(ScrapeRun.started_at.desc())
                .first()
            )
            if row:
                return row.id

            # Fallback: legacy rows may store local wall time (aware UTC converted
            # by psycopg2 into timestamp without time zone). After a successful
            # subprocess there should be a fresh success row for this spider.
            row = (
                session.query(ScrapeRun)
                .filter(
                    ScrapeRun.spider_name == spider_name,
                    ScrapeRun.status == "success",
                    ScrapeRun.finished_at.isnot(None),
                )
                .order_by(ScrapeRun.finished_at.desc())
                .first()
            )
            if row:
                logger.info(
                    "scrape_run_lookup_used_fallback spider=%s run_id=%s",
                    spider_name,
                    row.id,
                )
                return row.id
            return None
        finally:
            session.close()
    except Exception as e:
        logger.warning("scrape_run_lookup_failed: %s", e)
        return None


async def run_spider(
    spider_name: str,
    progress_callback=None,
    **kwargs: str,
) -> dict:
    """Run a single spider in a subprocess. Returns run stats dict (including
    ``scrape_run_id`` when the run reached the DB pipeline).

    When ``progress_callback`` is provided it is awaited every ~10 s with live
    scrape_runs counters while the subprocess is still running.
    """
    auth_check = check_spider_auth(spider_name)
    if auth_check["requires_auth"] and not auth_check["ok"]:
        cmd = auth_check["auth_setup_command"]
        logger.error(
            "Spider '%s' requires authentication but no session found. Run: %s",
            spider_name, cmd,
        )
        return {
            "spider": spider_name,
            "success": False,
            "error": "auth_required",
            "message": f"Authentication required. Run: {cmd}",
        }

    env = os.environ.copy()
    env["SCRAPY_SETTINGS_MODULE"] = "app.scraper.settings"

    cmd = [sys.executable, "-m", "scrapy", "crawl", spider_name]
    for key, value in kwargs.items():
        cmd.extend(["-a", f"{key}={value}"])

    logger.info("Starting spider '%s': %s", spider_name, " ".join(cmd))
    started_at = datetime.now(timezone.utc).replace(tzinfo=None)
    stop_monitor = asyncio.Event()

    async def _stream_lines(stream, label: str) -> None:
        if stream is None:
            return
        while True:
            line = await stream.readline()
            if not line:
                break
            text = line.decode(errors="replace").rstrip()
            if text:
                logger.info("[%s][%s] %s", spider_name, label, text)

    async def _monitor_progress() -> None:
        while not stop_monitor.is_set():
            try:
                await asyncio.wait_for(stop_monitor.wait(), timeout=10.0)
                break
            except asyncio.TimeoutError:
                pass
            stats = await asyncio.to_thread(
                _running_scrape_run_stats, spider_name, started_at
            )
            elapsed = int((datetime.now(timezone.utc).replace(tzinfo=None) - started_at).total_seconds())
            if stats:
                logger.info(
                    "Spider '%s' progress: %d scraped (%d new, %d updated) elapsed=%ds",
                    spider_name,
                    stats["items_scraped"],
                    stats["items_new"],
                    stats["items_updated"],
                    elapsed,
                )
                if progress_callback:
                    payload = dict(stats)
                    payload["elapsed_seconds"] = elapsed
                    await progress_callback(payload)
            else:
                logger.info(
                    "Spider '%s' still running (no scrape_runs row yet) elapsed=%ds",
                    spider_name,
                    elapsed,
                )

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(PROJECT_ROOT),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout_task = asyncio.create_task(_stream_lines(proc.stdout, "stdout"))
        stderr_task = asyncio.create_task(_stream_lines(proc.stderr, "stderr"))
        monitor_task = asyncio.create_task(_monitor_progress())

        try:
            await asyncio.wait_for(proc.wait(), timeout=1800)
        except asyncio.TimeoutError:
            logger.error("Spider '%s' timed out after 1800s - killing subprocess", spider_name)
            proc.kill()
            await proc.wait()
            await asyncio.to_thread(_mark_scrape_run_interrupted, spider_name, started_at)
            return {"spider": spider_name, "success": False, "error": "timeout"}
        finally:
            stop_monitor.set()
            await asyncio.gather(monitor_task, stdout_task, stderr_task, return_exceptions=True)

        success = proc.returncode == 0
        scrape_run_id = await asyncio.to_thread(
            _latest_scrape_run_id, spider_name, started_at
        )

        result = {
            "spider": spider_name,
            "success": success,
            "return_code": proc.returncode,
            "scrape_run_id": scrape_run_id,
        }

        if success:
            logger.info(
                "Spider '%s' completed successfully (scrape_run_id=%s)",
                spider_name, scrape_run_id,
            )
        else:
            logger.error(
                "Spider '%s' failed (rc=%d)",
                spider_name, proc.returncode,
            )

        return result

    except Exception as e:
        logger.exception("Spider '%s' crashed: %s", spider_name, e)
        return {"spider": spider_name, "success": False, "error": str(e)}
    finally:
        stop_monitor.set()


async def run_all_spiders(
    on_progress=None,
    spider_names: list[str] | None = None,
    spider_kwargs: dict[str, str] | None = None,
) -> list[dict]:
    """Run spiders sequentially, calling on_progress(spider, index, total) after each."""
    extra = dict(spider_kwargs or {})
    if spider_names is None:
        targets = list(ALL_SPIDERS)
    else:
        defaults = {name: kwargs for name, kwargs in ALL_SPIDERS}
        targets = [(name, defaults.get(name, {})) for name in spider_names]

    results = []
    total = len(targets)

    for i, (name, kwargs) in enumerate(targets):
        merged = {**kwargs, **extra}
        result = await run_spider(name, **merged)
        results.append(result)
        if on_progress:
            await on_progress(name, i + 1, total, result)

    return results


async def run_spiders_from_plan(
    plan: list[tuple[str, dict[str, str]]],
    on_progress=None,
    on_spider_start=None,
    spider_progress_callback=None,
) -> list[dict]:
    """Run an explicit list of (spider_name, scrapy_kwargs) pairs."""
    results = []
    total = len(plan)

    for i, (name, kwargs) in enumerate(plan):
        if on_spider_start:
            await on_spider_start(name, i + 1, total)
        result = await run_spider(
            name,
            progress_callback=spider_progress_callback,
            **kwargs,
        )
        results.append(result)
        if on_progress:
            await on_progress(name, i + 1, total, result)

    return results
