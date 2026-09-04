import time
from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from app.core.logging import (
    bind_logging_context,
    clear_logging_context,
    get_logger,
    new_request_id,
    set_request_id,
)

logger = get_logger(__name__)

# Paths that still get a request_id header but skip start/complete log noise.
_QUIET_PATHS = frozenset(
    {
        "/api/v1/health",
        "/favicon.ico",
        "/docs",
        "/openapi.json",
        "/redoc",
    }
)


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        request_id = request.headers.get("x-request-id") or new_request_id()
        set_request_id(request_id)

        client_ip = request.client.host if request.client else None
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            client_ip = forwarded.split(",")[0].strip() or client_ip

        user_agent = (request.headers.get("user-agent") or "")[:200] or None
        content_length = request.headers.get("content-length")
        try:
            request_bytes = int(content_length) if content_length else None
        except ValueError:
            request_bytes = None

        bind_logging_context(
            request_id=request_id,
            method=request.method,
            path=request.url.path,
            query=request.url.query or None,
            client_ip=client_ip,
            category="http",
            service="api",
        )
        start_time = time.perf_counter()
        quiet = request.url.path in _QUIET_PATHS
        if not quiet:
            logger.info(
                "http_request_started",
                user_agent=user_agent,
                request_bytes=request_bytes,
                content_type=request.headers.get("content-type"),
            )
        try:
            response = await call_next(request)
            response.headers["x-request-id"] = request_id

            duration_ms = round((time.perf_counter() - start_time) * 1000, 2)
            # Best-effort user id from auth middleware / route dependency stash.
            user_id = getattr(request.state, "user_id", None)

            if not quiet:
                logger.info(
                    "http_request_completed",
                    status_code=response.status_code,
                    duration_ms=duration_ms,
                    user_id=user_id,
                    response_content_type=response.headers.get("content-type"),
                )
            return response
        except Exception as e:
            duration_ms = round((time.perf_counter() - start_time) * 1000, 2)
            logger.error(
                "http_request_failed",
                status_code=500,
                duration_ms=duration_ms,
                error=str(e),
                exc_info=True,
            )
            raise
        finally:
            clear_logging_context()


class ErrorHandlerMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        try:
            return await call_next(request)
        except Exception as e:
            logger.error(
                "unhandled_exception",
                error=str(e),
                path=request.url.path,
                method=request.method,
                category="http",
                exc_info=True,
            )
            clear_logging_context()
            raise
