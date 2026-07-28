#!/usr/bin/env python3
"""
Worker startup script.

Usage:
    python run_worker.py extraction   # HTTP/browser scraping
    python run_worker.py analysis     # Phase A match scoring
    python run_worker.py tailoring    # Phase B resume tailoring
    python run_worker.py save         # post-analysis persistence + auto-post
    python run_worker.py resume       # DOCX/PDF generation
    python run_worker.py scraper      # Scrapy crawl runs

All workers share the same Redis instance but listen on independent queues
so they can be scaled and deployed separately.
"""
import argparse
import asyncio
import sys
from pathlib import Path

# Load .env into os.environ BEFORE any app imports.  Third-party SDKs like
# Langfuse read credentials from os.environ at import time.
from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parent / ".env")

from app.core.logging import setup_logging

setup_logging()

if sys.platform == "win32":
    try:
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    except Exception:
        pass

from arq import run_worker
from arq import func
from app.tasks.worker import (
    ExtractionWorkerSettings,
    AnalysisWorkerSettings,
    TailoringWorkerSettings,
    SaveWorkerSettings,
    ResumeBuildWorkerSettings,
    ScraperWorkerSettings,
    extract_job,
    analyze_job_match,
    generate_tailored_content,
    _forward_phase_b_to_tailoring_queue,
    save_analyzed_job,
    build_resume_task,
    run_scraper_task,
)
from app.storage.database import init_database, close_database
from app.services.http_client import init_http_client, close_http_client
from app.extractors.browser_extractor import (
    init_browser_pool,
    close_browser_pool,
)
from app.core.logging import get_logger

logger = get_logger(__name__)

# System Settings key that controls each worker's arq max_jobs.
MODE_MAX_JOBS_SETTING = {
    "extraction": "extraction_worker_max_jobs",
    "analysis": "analysis_worker_max_jobs",
    "tailoring": "tailoring_worker_max_jobs",
    "save": "save_worker_max_jobs",
    "resume": "resume_worker_max_jobs",
    "scraper": "scraper_worker_max_jobs",
}


# ── Extraction worker lifecycle ────────────────────────────────────────────

async def extraction_startup(ctx):
    logger.info("extraction_worker_startup_begin")
    await init_database()
    await init_http_client()
    await init_browser_pool()
    logger.info("extraction_worker_startup_complete")


async def extraction_shutdown(ctx):
    logger.info("extraction_worker_shutdown_begin")
    await close_browser_pool()
    await close_http_client()
    await close_database()
    logger.info("extraction_worker_shutdown_complete")


# ── Analysis worker lifecycle (no browser/HTTP needed) ─────────────────────

async def analysis_startup(ctx):
    logger.info("analysis_worker_startup_begin")
    await init_database()
    from app.services.pipeline_health import heal_stale_pipeline_state
    await heal_stale_pipeline_state()
    logger.info("analysis_worker_startup_complete")


async def analysis_shutdown(ctx):
    logger.info("analysis_worker_shutdown_begin")
    await close_database()
    logger.info("analysis_worker_shutdown_complete")


async def tailoring_startup(ctx):
    logger.info("tailoring_worker_startup_begin")
    await init_database()
    from app.services.pipeline_health import heal_stale_pipeline_state
    await heal_stale_pipeline_state()
    logger.info("tailoring_worker_startup_complete")


async def tailoring_shutdown(ctx):
    logger.info("tailoring_worker_shutdown_begin")
    await close_database()
    logger.info("tailoring_worker_shutdown_complete")


# ── arq config classes ─────────────────────────────────────────────────────
# arq's get_kwargs reads __dict__ (own attrs only), so every setting used
# by the Worker must appear directly on the concrete config class.

class ExtractionWorkerConfig(ExtractionWorkerSettings):
    on_startup = extraction_startup
    on_shutdown = extraction_shutdown
    functions = [extract_job]
    queue_name = ExtractionWorkerSettings.queue_name
    job_timeout = ExtractionWorkerSettings.job_timeout
    max_jobs = ExtractionWorkerSettings.max_jobs
    max_tries = ExtractionWorkerSettings.max_tries
    redis_settings = ExtractionWorkerSettings.redis_settings()


class AnalysisWorkerConfig(AnalysisWorkerSettings):
    on_startup = analysis_startup
    on_shutdown = analysis_shutdown
    functions = [
        analyze_job_match,
        func(_forward_phase_b_to_tailoring_queue, name="generate_tailored_content"),
    ]
    queue_name = AnalysisWorkerSettings.queue_name
    job_timeout = AnalysisWorkerSettings.job_timeout
    max_jobs = AnalysisWorkerSettings.max_jobs
    max_tries = AnalysisWorkerSettings.max_tries
    redis_settings = AnalysisWorkerSettings.redis_settings()


class TailoringWorkerConfig(TailoringWorkerSettings):
    on_startup = tailoring_startup
    on_shutdown = tailoring_shutdown
    functions = [generate_tailored_content]
    queue_name = TailoringWorkerSettings.queue_name
    job_timeout = TailoringWorkerSettings.job_timeout
    max_jobs = TailoringWorkerSettings.max_jobs
    max_tries = TailoringWorkerSettings.max_tries
    redis_settings = TailoringWorkerSettings.redis_settings()


async def save_startup(ctx):
    logger.info("save_worker_startup_begin")
    await init_database()
    logger.info("save_worker_startup_complete")


async def save_shutdown(ctx):
    logger.info("save_worker_shutdown_begin")
    await close_database()
    logger.info("save_worker_shutdown_complete")


class SaveWorkerConfig(SaveWorkerSettings):
    on_startup = save_startup
    on_shutdown = save_shutdown
    functions = [save_analyzed_job]
    queue_name = SaveWorkerSettings.queue_name
    job_timeout = SaveWorkerSettings.job_timeout
    max_jobs = SaveWorkerSettings.max_jobs
    max_tries = SaveWorkerSettings.max_tries
    redis_settings = SaveWorkerSettings.redis_settings()


# ── Resume build worker lifecycle (DB only, no browser/HTTP) ───────────────

async def resume_build_startup(ctx):
    logger.info("resume_build_worker_startup_begin")
    await init_database()
    logger.info("resume_build_worker_startup_complete")


async def resume_build_shutdown(ctx):
    logger.info("resume_build_worker_shutdown_begin")
    await close_database()
    logger.info("resume_build_worker_shutdown_complete")


class ResumeBuildWorkerConfig(ResumeBuildWorkerSettings):
    on_startup = resume_build_startup
    on_shutdown = resume_build_shutdown
    functions = [build_resume_task]
    queue_name = ResumeBuildWorkerSettings.queue_name
    job_timeout = ResumeBuildWorkerSettings.job_timeout
    max_jobs = ResumeBuildWorkerSettings.max_jobs
    max_tries = ResumeBuildWorkerSettings.max_tries
    redis_settings = ResumeBuildWorkerSettings.redis_settings()


# ── Scraper worker lifecycle (DB only - spiders run as subprocesses) ───────

async def scraper_startup(ctx):
    logger.info("scraper_worker_startup_begin")
    await init_database()
    logger.info("scraper_worker_startup_complete")


async def scraper_shutdown(ctx):
    logger.info("scraper_worker_shutdown_begin")
    await close_database()
    logger.info("scraper_worker_shutdown_complete")


class ScraperWorkerConfig(ScraperWorkerSettings):
    on_startup = scraper_startup
    on_shutdown = scraper_shutdown
    functions = [run_scraper_task]
    queue_name = ScraperWorkerSettings.queue_name
    job_timeout = ScraperWorkerSettings.job_timeout
    max_jobs = ScraperWorkerSettings.max_jobs
    max_tries = ScraperWorkerSettings.max_tries
    redis_settings = ScraperWorkerSettings.redis_settings()


WORKER_CONFIGS = {
    "extraction": ExtractionWorkerConfig,
    "analysis": AnalysisWorkerConfig,
    "tailoring": TailoringWorkerConfig,
    "save": SaveWorkerConfig,
    "resume": ResumeBuildWorkerConfig,
    "scraper": ScraperWorkerConfig,
}


# Owned by the worker process so we never call deprecated
# ``asyncio.get_event_loop()`` when no loop is set (Python 3.12+ warning).
_MAIN_EVENT_LOOP: asyncio.AbstractEventLoop | None = None


def _install_main_event_loop() -> asyncio.AbstractEventLoop:
    """Ensure MainThread has an open loop for arq.

    arq ``Worker.__init__`` calls ``asyncio.get_event_loop()``. On Python 3.12+
    that warns/raises if no loop is set. ``asyncio.run()`` also closes its loop
    when finished, so any pre-start async work must leave a live loop installed
    via ``set_event_loop`` — without calling the deprecated getter first.
    """
    global _MAIN_EVENT_LOOP
    try:
        return asyncio.get_running_loop()
    except RuntimeError:
        pass
    if _MAIN_EVENT_LOOP is not None and not _MAIN_EVENT_LOOP.is_closed():
        asyncio.set_event_loop(_MAIN_EVENT_LOOP)
        return _MAIN_EVENT_LOOP
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    _MAIN_EVENT_LOOP = loop
    return loop


def _apply_effective_max_jobs(mode: str, config_cls: type) -> int:
    """Load System Settings override for max_jobs before arq Worker starts."""
    setting_key = MODE_MAX_JOBS_SETTING[mode]

    async def _load() -> int:
        await init_database()
        try:
            from app.services.system_settings_service import (
                get_effective_value,
                invalidate_system_settings_cache,
            )

            invalidate_system_settings_cache()
            value = await get_effective_value(setting_key)
            return max(1, int(value))
        finally:
            await close_database()

    # Use a persistent loop (do not asyncio.run): arq needs get_event_loop()
    # immediately after this returns.
    loop = _install_main_event_loop()
    try:
        max_jobs = loop.run_until_complete(_load())
    except Exception as exc:
        max_jobs = max(1, int(getattr(config_cls, "max_jobs", 10) or 10))
        logger.warning(
            "worker_max_jobs_settings_load_failed",
            mode=mode,
            setting=setting_key,
            fallback=max_jobs,
            error=str(exc),
        )
    # Belt-and-suspenders: if anything closed the loop during load, reinstall.
    _install_main_event_loop()
    config_cls.max_jobs = max_jobs
    logger.info(
        "worker_max_jobs_applied",
        mode=mode,
        setting=setting_key,
        max_jobs=max_jobs,
    )
    return max_jobs


# IMPORTANT: this function MUST stay at module scope.
#
# `watchfiles.run_process` uses ``multiprocessing.get_context('spawn').Process``,
# which is the only available start method on Windows. ``spawn`` pickles the
# target callable by ``(module, qualname)``; the child re-imports the module
# (as ``__mp_main__``) and looks the function up by name on that module.
#
# A function defined inside ``if __name__ == "__main__":`` is never bound on
# ``__mp_main__`` (the guard is False during the spawn re-import), so unpickling
# fails with::
#
#     AttributeError: Can't get attribute '<func>' on
#     <module '__mp_main__' from 'run_worker.py'>
#
# Keep this defined at module level and accept the worker mode as a plain
# string so pickling stores just ``(run_worker, _watchfiles_worker_target)``
# plus a str arg - both trivially importable in the spawned child.
def _watchfiles_worker_target(mode: str) -> None:
    config = WORKER_CONFIGS[mode]
    _apply_effective_max_jobs(mode, config)
    _install_main_event_loop()
    logger.info(
        "worker_process_starting",
        mode=mode,
        queue=config.queue_name,
        max_jobs=config.max_jobs,
    )
    run_worker(config)


if __name__ == "__main__":
    from pathlib import Path

    parser = argparse.ArgumentParser(
        description="Start an arq worker for one pipeline.",
    )
    parser.add_argument(
        "mode",
        choices=list(WORKER_CONFIGS.keys()),
        help=(
            "Which pipeline to run: extraction | analysis | tailoring | "
            "save | resume | scraper."
        ),
    )
    args = parser.parse_args()
    config = WORKER_CONFIGS[args.mode]
    max_jobs = _apply_effective_max_jobs(args.mode, config)
    logger.info(
        "worker_launching",
        mode=args.mode,
        queue=config.queue_name,
        max_jobs=max_jobs,
    )

    from app.core.dev_reload import worker_reload_enabled

    if worker_reload_enabled():
        from watchfiles import run_process
        from watchfiles.filters import PythonFilter

        watch_path = str(Path(__file__).resolve().parent / "app")
        print(
            f"[reload] Watching {watch_path} - {args.mode} worker restarts on .py changes "
            f"(debounced). Set WORKER_RELOAD=0 for a stable worker."
        )
        run_process(
            watch_path,
            target=_watchfiles_worker_target,
            args=(args.mode,),
            watch_filter=PythonFilter(),
            debounce=5_000,
            grace_period=3.0,
        )
    else:
        print(
            f"[worker] {args.mode} on queue '{config.queue_name}' "
            f"max_jobs={max_jobs} "
            f"(hot-reload off; set WORKER_RELOAD=1 to watch app/)"
        )
        _install_main_event_loop()
        run_worker(config)
