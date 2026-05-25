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


async def run_spider(spider_name: str, **kwargs: str) -> dict:
    """Run a single spider in a subprocess. Returns run stats dict (including
    ``scrape_run_id`` when the run reached the DB pipeline)."""
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

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(PROJECT_ROOT),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=1800)

        success = proc.returncode == 0
        scrape_run_id = await asyncio.to_thread(
            _latest_scrape_run_id, spider_name, started_at
        )

        result = {
            "spider": spider_name,
            "success": success,
            "return_code": proc.returncode,
            "scrape_run_id": scrape_run_id,
            "stdout_tail": (stdout or b"").decode(errors="replace")[-2000:],
            "stderr_tail": (stderr or b"").decode(errors="replace")[-2000:],
        }

        if success:
            logger.info(
                "Spider '%s' completed successfully (scrape_run_id=%s)",
                spider_name, scrape_run_id,
            )
        else:
            stderr_text = (stderr or b"").decode(errors="replace")[-3000:]
            logger.error(
                "Spider '%s' failed (rc=%d)\n--- stderr ---\n%s",
                spider_name, proc.returncode, stderr_text,
            )

        return result

    except asyncio.TimeoutError:
        logger.error("Spider '%s' timed out after 1800s", spider_name)
        return {"spider": spider_name, "success": False, "error": "timeout"}
    except Exception as e:
        logger.exception("Spider '%s' crashed: %s", spider_name, e)
        return {"spider": spider_name, "success": False, "error": str(e)}


async def run_all_spiders(
    on_progress=None,
) -> list[dict]:
    """Run all spiders sequentially, calling on_progress(spider, index, total) after each."""
    results = []
    total = len(ALL_SPIDERS)

    for i, (name, kwargs) in enumerate(ALL_SPIDERS):
        result = await run_spider(name, **kwargs)
        results.append(result)
        if on_progress:
            await on_progress(name, i + 1, total, result)

    return results
