import logging
import re
import sys
from contextvars import ContextVar
from uuid import uuid4

import structlog

from app.core.config import get_settings


class FlushingStreamHandler(logging.StreamHandler):
    """StreamHandler that flushes after every emit so logs appear immediately."""

    def emit(self, record):
        super().emit(record)
        self.flush()


_request_id_ctx: ContextVar[str | None] = ContextVar("request_id", default=None)

_SENSITIVE_KEYWORDS = (
    "password",
    "passwd",
    "token",
    "secret",
    "authorization",
    "cookie",
    "api_key",
    "access_key",
    "refresh_token",
)
_BEARER_RE = re.compile(r"(?i)bearer\s+[A-Za-z0-9\-._~+/]+=*")


def _mask_value(value):
    if value is None:
        return None
    if isinstance(value, str):
        if _BEARER_RE.search(value):
            return _BEARER_RE.sub("Bearer [REDACTED]", value)
        return value
    return value


def _redact_sensitive_fields(_, __, event_dict):
    for key in list(event_dict.keys()):
        lowered = key.lower()
        if any(word in lowered for word in _SENSITIVE_KEYWORDS):
            event_dict[key] = "[REDACTED]"
            continue
        event_dict[key] = _mask_value(event_dict[key])
    return event_dict


def _add_request_id(_, __, event_dict):
    request_id = _request_id_ctx.get()
    if request_id and "request_id" not in event_dict:
        event_dict["request_id"] = request_id
    return event_dict


def _normalize_event_name(_, __, event_dict):
    event = event_dict.get("event")
    if isinstance(event, str):
        event_dict["event"] = event.strip().lower()
    return event_dict


def _normalize_exceptions(_, __, event_dict):
    exc = event_dict.get("exception")
    if exc is not None and "error" not in event_dict:
        event_dict["error"] = str(exc)
    return event_dict


def setup_logging() -> None:
    settings = get_settings()
    log_stream = sys.stderr
    use_json = not settings.debug
    log_level = getattr(logging, settings.log_level)

    # Use stdlib logging as backend so we control handlers and flushing
    # This ensures logs appear during async job execution (arq worker)
    root_logger = logging.getLogger()
    root_logger.setLevel(log_level)
    root_logger.handlers.clear()

    handler = FlushingStreamHandler(log_stream)
    handler.setLevel(log_level)
    handler.setFormatter(logging.Formatter("%(message)s"))
    root_logger.addHandler(handler)

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            _add_request_id,
            structlog.processors.add_log_level,
            structlog.stdlib.add_logger_name,
            structlog.processors.StackInfoRenderer(),
            structlog.dev.set_exc_info,
            _normalize_exceptions,
            _normalize_event_name,
            _redact_sensitive_fields,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer()
            if use_json
            else structlog.dev.ConsoleRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(log_level),
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=False,
    )

    logging.basicConfig(
        level=log_level,
        format="%(message)s",
        handlers=[handler],
        force=True,
    )

    # Suppress SQLAlchemy SQL echo so app logs are visible.
    # echo=True (set by debug mode) creates a child logger at
    # "sqlalchemy.engine.Engine" with DEBUG level, so we must suppress both.
    logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)
    logging.getLogger("sqlalchemy.engine.Engine").setLevel(logging.WARNING)


def get_logger(name: str) -> structlog.BoundLogger:
    return structlog.get_logger(name)


def new_request_id() -> str:
    return str(uuid4())


def set_request_id(request_id: str | None) -> None:
    _request_id_ctx.set(request_id)


def clear_logging_context() -> None:
    structlog.contextvars.clear_contextvars()
    _request_id_ctx.set(None)


def bind_logging_context(**kwargs) -> None:
    clean = {k: v for k, v in kwargs.items() if v is not None}
    if clean:
        structlog.contextvars.bind_contextvars(**clean)
