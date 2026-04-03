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


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        request_id = request.headers.get("x-request-id") or new_request_id()
        set_request_id(request_id)
        bind_logging_context(
            request_id=request_id,
            method=request.method,
            path=request.url.path,
            query=request.url.query or None,
            client_ip=request.client.host if request.client else None,
        )
        start_time = time.perf_counter()
        logger.info("http_request_started")
        try:
            response = await call_next(request)
            response.headers["x-request-id"] = request_id

            duration = time.perf_counter() - start_time
            logger.info(
                "http_request_completed",
                status_code=response.status_code,
                duration_ms=round(duration * 1000, 2),
            )
            return response
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
                exc_info=True,
            )
            clear_logging_context()
            raise
