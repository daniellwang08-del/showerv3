#!/usr/bin/env python3
"""
Worker startup script.

Usage:
    python run_worker.py extraction   # start the extraction worker (HTTP/browser scraping)
    python run_worker.py analysis     # start the analysis worker  (OpenAI match scoring)
    python run_worker.py resume       # start the resume build worker (DOCX/PDF generation)

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
from app.tasks.worker import (
    ExtractionWorkerSettings,
    AnalysisWorkerSettings,
    SaveWorkerSettings,
    ResumeBuildWorkerSettings,
    ScraperWorkerSettings,
    extract_job,
    analyze_job_match,
    generate_tailored_content,
    analyze_resume_template,
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
    logger.info("analysis_worker_startup_complete")


async def analysis_shutdown(ctx):
    logger.info("analysis_worker_shutdown_begin")
    await close_database()
    logger.info("analysis_worker_shutdown_complete")


# ── arq config classes ─────────────────────────────────────────────────────
# arq's get_kwargs reads __dict__ (own attrs only), so every setting used
# by the Worker must appear directly on the concrete config class.

class ExtractionWorkerConfig(ExtractionWorkerSettings):
    on_startup = extraction_startup
    on_shutdown = extraction_shutdown
    functions = [extract_job]
    queue_name = ExtractionWorkerSettings.queue_name
    job_timeout = ExtractionWorkerSettings.job_timeout
    max_tries = ExtractionWorkerSettings.max_tries
    redis_settings = ExtractionWorkerSettings.redis_settings()


class AnalysisWorkerConfig(AnalysisWorkerSettings):
    on_startup = analysis_startup
    on_shutdown = analysis_shutdown
    functions = [analyze_job_match, generate_tailored_content, analyze_resume_template]
    queue_name = AnalysisWorkerSettings.queue_name
    job_timeout = AnalysisWorkerSettings.job_timeout
    max_jobs = AnalysisWorkerSettings.max_jobs
    max_tries = AnalysisWorkerSettings.max_tries
    redis_settings = AnalysisWorkerSettings.redis_settings()


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
    max_tries = ResumeBuildWorkerSettings.max_tries
    redis_settings = ResumeBuildWorkerSettings.redis_settings()


# ── Scraper worker lifecycle (DB only — spiders run as subprocesses) ───────

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
    max_tries = ScraperWorkerSettings.max_tries
    redis_settings = ScraperWorkerSettings.redis_settings()


WORKER_CONFIGS = {
    "extraction": ExtractionWorkerConfig,
    "analysis": AnalysisWorkerConfig,
    "save": SaveWorkerConfig,
    "resume": ResumeBuildWorkerConfig,
    "scraper": ScraperWorkerConfig,
}


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
# plus a str arg — both trivially importable in the spawned child.
def _watchfiles_worker_target(mode: str) -> None:
    config = WORKER_CONFIGS[mode]
    logger.info(
        "worker_process_starting",
        mode=mode,
        queue=config.queue_name,
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
        help="Which pipeline to run: 'extraction' (scraping), 'analysis' (OpenAI Phase A + B), or 'resume' (document builder).",
    )
    args = parser.parse_args()
    config = WORKER_CONFIGS[args.mode]
    logger.info("worker_launching", mode=args.mode, queue=config.queue_name)

    from app.core.dev_reload import worker_reload_enabled

    if worker_reload_enabled():
        from watchfiles import run_process
        from watchfiles.filters import PythonFilter

        watch_path = str(Path(__file__).resolve().parent / "app")
        print(
            f"[reload] Watching {watch_path} — {args.mode} worker restarts on .py changes "
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
            f"(hot-reload off; set WORKER_RELOAD=1 to watch app/)"
        )
        run_worker(config)
