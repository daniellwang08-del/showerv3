"""
FastAPI app. Set Windows event loop policy before any asyncio use.
Uvicorn reload spawns a child process that imports this module; the policy
must be set here so the child gets it (start_server.py runs only in parent).
"""
import warnings

# Before any transitive `import requests` (e.g. tldextract): chardet 7+ fails
# requests' bundled compatibility check; pin chardet<6 in requirements.txt.
warnings.filterwarnings("ignore", message="doesn't match a supported version")

import asyncio
import os
import sys

if sys.platform == "win32":
    try:
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    except Exception:
        pass

# Load .env into os.environ BEFORE any app imports.  Third-party SDKs like
# Langfuse read credentials from os.environ at import time; pydantic-settings
# only populates its own model and never writes to os.environ.
from pathlib import Path as _Path
from dotenv import load_dotenv as _load_dotenv
_load_dotenv(_Path(__file__).resolve().parent.parent / ".env")

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from app.api.routes import router
from app.api.scraper_routes import scraper_router
from app.api.assistant_routes import assistant_router
from app.api.websocket import ws_router, manager as ws_manager
from app.api.middleware import RequestLoggingMiddleware, ErrorHandlerMiddleware
from app.storage.database import init_database, close_database
from app.services.http_client import init_http_client, close_http_client
from app.extractors.browser_extractor import init_browser_pool, close_browser_pool
from app.services.extraction_cache import init_redis_pool, close_redis_pool
from app.tasks.worker import close_shared_pools
from app.core.config import get_settings
from app.core.logging import setup_logging, get_logger

logger = get_logger(__name__)


def _install_windows_accept_noise_filter() -> None:
    """Suppress benign WinError 64 noise when clients drop TCP during accept (Windows)."""
    if sys.platform != "win32":
        return

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return

    previous = loop.get_exception_handler()

    def handler(inner_loop: asyncio.AbstractEventLoop, context: dict) -> None:
        exc = context.get("exception")
        if isinstance(exc, OSError) and getattr(exc, "winerror", None) == 64:
            return
        message = context.get("message", "")
        if "Accept failed on a socket" in message:
            return
        if previous is not None:
            previous(inner_loop, context)
        else:
            inner_loop.default_exception_handler(context)

    loop.set_exception_handler(handler)


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    _install_windows_accept_noise_filter()
    logger.info("application_starting")

    try:
        await init_database()
    except Exception as e:
        logger.error("database_init_failed", error=str(e))
        raise

    # Clean up stale scrape_runs left in 'running' state from a previous
    # process that was killed before it could call PostgresPipeline.close_spider().
    # Without this, GET /scraper/sync/status returns "running" forever after
    # a hard app restart, keeping the sync button stuck in the loading state.
    try:
        from app.storage.database import get_session
        from sqlalchemy import text as _sa_text
        async with get_session() as _sess:
            result = await _sess.execute(
                _sa_text(
                    "UPDATE scrape_runs "
                    "SET status = 'interrupted', "
                    "    finished_at = now() "
                    "WHERE status = 'running'"
                )
            )
            rows = result.rowcount
            await _sess.commit()
            if rows:
                logger.warning(
                    "startup_stale_runs_cleaned",
                    count=rows,
                    reason="Runs were left in 'running' state from a previous process restart",
                )
    except Exception as e:
        logger.warning("startup_stale_runs_cleanup_failed", error=str(e))

    try:
        await init_redis_pool()
    except Exception as e:
        logger.warning("redis_pool_init_failed", error=str(e))

    try:
        await init_http_client()
    except Exception as e:
        logger.error("http_client_init_failed", error=str(e))

    try:
        # Visibility: on Windows the loop MUST be ProactorEventLoop for
        # Playwright to spawn its Node driver. If this log shows
        # SelectorEventLoop, uvicorn's WindowsSelectorEventLoopPolicy
        # override has re-broken things (start_server.py passes loop="none"
        # specifically to prevent that). See start_server.py docstring.
        _loop = asyncio.get_running_loop()
        logger.info(
            "asyncio_loop_in_use",
            loop_type=type(_loop).__name__,
            platform=sys.platform,
        )
        await init_browser_pool()
    except Exception as e:
        err_msg = str(e) or f"{type(e).__name__}"
        logger.warning("browser_pool_init_failed", error=err_msg)

    redis_ok = False
    try:
        from app.tasks.worker import get_extraction_pool
        pool = await get_extraction_pool()
        await pool.ping()
        redis_ok = True
    except Exception:
        pass
    if redis_ok:
        await ws_manager.start_redis_subscriber()
        logger.info(
            "application_started",
            redis_connected=True,
            worker_required="Run 'python run_worker.py extraction' and 'python run_worker.py analysis' in separate terminals",
        )
    else:
        logger.info(
            "application_started",
            redis_connected=False,
            worker_required="Jobs use in-process fallback. For async queues: start Memurai/Redis and run both workers",
        )

    yield

    logger.info("application_stopping")

    try:
        from langfuse import get_client  # type: ignore[import-unresolved]
        get_client().flush()
    except Exception:
        pass

    try:
        await ws_manager.stop_redis_subscriber()
    except Exception:
        pass

    try:
        await close_browser_pool()
    except Exception:
        pass

    try:
        await close_http_client()
    except Exception:
        pass

    try:
        await close_shared_pools()
    except Exception:
        pass

    try:
        await close_redis_pool()
    except Exception:
        pass

    try:
        await close_database()
    except Exception:
        pass

    logger.info("application_stopped")


def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title=settings.app_name,
        version=settings.app_version,
        lifespan=lifespan,
        docs_url="/docs" if settings.debug else None,
        redoc_url="/redoc" if settings.debug else None,
    )

    # When `allow_credentials=True`, `allow_origins` must not be ['*'] or browsers will block cookies.
    origins = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ]
    extra_origins = os.environ.get("CORS_EXTRA_ORIGINS", "")
    if extra_origins:
        origins.extend(o.strip().rstrip("/") for o in extra_origins.split(",") if o.strip())

    frontend_url = os.environ.get("FRONTEND_URL")
    if frontend_url:
        origins.append(frontend_url.rstrip("/"))

    # Local dev: allow any private-LAN origin (e.g. http://172.20.1.140:5173) and
    # browser-extension origins (chrome-extension://, moz-extension://) so the
    # job-assistant extension can call the API during development. In production,
    # extension origins must be added explicitly via CORS_EXTRA_ORIGINS.
    allow_origin_regex = None
    if settings.app_env == "local" or settings.debug:
        allow_origin_regex = (
            r"(?:https?://"
            r"(localhost|127\.0\.0\.1|\[::1\]|"
            r"(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3})"
            r"(?::\d+)?"
            r"|(?:chrome-extension|moz-extension)://[a-zA-Z0-9]+)"
        )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_origin_regex=allow_origin_regex,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.add_middleware(ErrorHandlerMiddleware)
    app.add_middleware(RequestLoggingMiddleware)

    # Add root route
    @app.get("/")
    async def root():
        return JSONResponse({
            "message": "Job Scraper API",
            "version": settings.app_version,
            "docs": "/docs",
            "health": "/api/v1/health"
        })

    # Add favicon route to prevent 500 errors
    @app.get("/favicon.ico")
    async def favicon():
        from fastapi.responses import Response
        return Response(status_code=204)

    app.include_router(router, prefix="/api/v1")
    app.include_router(scraper_router, prefix="/api/v1")
    app.include_router(assistant_router, prefix="/api/v1")
    app.include_router(ws_router, prefix="/api/v1")

    return app


app = create_app()
