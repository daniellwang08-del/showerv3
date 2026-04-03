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
    ResumeBuildWorkerSettings,
    extract_job,
    analyze_job_match,
    build_resume_task,
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
    functions = [analyze_job_match]
    queue_name = AnalysisWorkerSettings.queue_name
    job_timeout = AnalysisWorkerSettings.job_timeout
    max_tries = AnalysisWorkerSettings.max_tries
    redis_settings = AnalysisWorkerSettings.redis_settings()


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


WORKER_CONFIGS = {
    "extraction": ExtractionWorkerConfig,
    "analysis": AnalysisWorkerConfig,
    "resume": ResumeBuildWorkerConfig,
}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Start an arq worker for one pipeline.",
    )
    parser.add_argument(
        "mode",
        choices=list(WORKER_CONFIGS.keys()),
        help="Which pipeline to run: 'extraction' (scraping), 'analysis' (OpenAI match), or 'resume' (document builder).",
    )
    args = parser.parse_args()
    logger.info("worker_launching", mode=args.mode)
    run_worker(WORKER_CONFIGS[args.mode])
