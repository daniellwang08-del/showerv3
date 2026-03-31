"""
FastAPI app. Set Windows event loop policy before any asyncio use.
Uvicorn reload spawns a child process that imports this module; the policy
must be set here so the child gets it (start_server.py runs only in parent).
"""
import asyncio
import os
import sys

if sys.platform == "win32":
    try:
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    except Exception:
        pass

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from prometheus_client import make_asgi_app
from app.api.routes import router
from app.api.middleware import MetricsMiddleware, ErrorHandlerMiddleware
from app.storage.database import init_database, close_database
from app.services.http_client import init_http_client, close_http_client
from app.services.ai_parser import init_ai_parser
from app.extractors.browser_extractor import init_browser_pool, close_browser_pool
from app.core.config import get_settings
from app.core.logging import setup_logging, get_logger

logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    logger.info("application_starting")

    try:
        await init_database()
    except Exception as e:
        logger.error("database_init_failed", error=str(e))
        raise

    try:
        await init_http_client()
    except Exception as e:
        logger.error("http_client_init_failed", error=str(e))

    try:
        await init_ai_parser()
    except Exception as e:
        logger.warning("ai_parser_init_skipped", error=str(e))

    try:
        await init_browser_pool()
    except Exception as e:
        err_msg = str(e) or f"{type(e).__name__}"
        logger.warning("browser_pool_init_failed", error=err_msg)

    redis_ok = False
    try:
        from app.tasks.worker import get_redis_pool
        pool = await get_redis_pool()
        await pool.ping()
        redis_ok = True
        await pool.close()
    except Exception:
        pass
    if redis_ok:
        logger.info(
            "application_started",
            redis_connected=True,
            worker_required="Run 'python run_worker.py' in another terminal to process jobs",
        )
    else:
        logger.info(
            "application_started",
            redis_connected=False,
            worker_required="Jobs use in-process fallback. For async queue: start Memurai/Redis and run 'python run_worker.py'",
        )

    yield

    logger.info("application_stopping")

    try:
        await close_browser_pool()
    except Exception:
        pass

    try:
        await close_http_client()
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
    frontend_url = os.environ.get("FRONTEND_URL")
    if frontend_url:
        origins.append(frontend_url.rstrip("/"))

    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.add_middleware(ErrorHandlerMiddleware)
    app.add_middleware(MetricsMiddleware)

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

    metrics_app = make_asgi_app()
    app.mount("/metrics", metrics_app)

    return app


app = create_app()
