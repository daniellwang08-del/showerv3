#!/usr/bin/env python3
"""
Worker startup script. Applies Windows Python 3.13 subprocess fix
before any asyncio use.
"""
import asyncio
import sys

# Setup logging first so all output is visible (stderr, unbuffered)
from app.core.logging import setup_logging

setup_logging()

if sys.platform == "win32":
    try:
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    except Exception:
        pass

from arq import run_worker
from app.tasks.worker import WorkerSettings, extract_job, analyze_job_match
from app.storage.database import init_database, close_database
from app.services.http_client import init_http_client, close_http_client
from app.services.ai_parser import init_ai_parser
from app.extractors.browser_extractor import (
    init_browser_pool,
    close_browser_pool,
)
from app.core.logging import setup_logging, get_logger

logger = get_logger(__name__)


async def startup(ctx):
    logger.info("worker_startup_begin")
    await init_database()
    await init_http_client()
    await init_ai_parser()
    await init_browser_pool()
    logger.info("worker_startup_complete")


async def shutdown(ctx):
    logger.info("worker_shutdown_begin")
    await close_browser_pool()
    await close_http_client()
    await close_database()
    logger.info("worker_shutdown_complete")


class WorkerConfig(WorkerSettings):
    on_startup = startup
    on_shutdown = shutdown
    functions = [extract_job, analyze_job_match]
    # arq's get_kwargs uses __dict__ (own attrs only, not inherited).
    # We must redeclare these so they appear in WorkerConfig.__dict__,
    # otherwise the Worker falls back to arq defaults.
    queue_name = WorkerSettings.queue_name
    job_timeout = WorkerSettings.job_timeout
    max_tries = WorkerSettings.max_tries
    redis_settings = WorkerSettings.redis_settings()


if __name__ == "__main__":
    run_worker(WorkerConfig)
