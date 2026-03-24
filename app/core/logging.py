import structlog
import logging
import sys
from app.core.config import get_settings


class FlushingStreamHandler(logging.StreamHandler):
    """StreamHandler that flushes after every emit so logs appear immediately."""

    def emit(self, record):
        super().emit(record)
        self.flush()


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
            structlog.processors.add_log_level,
            structlog.processors.StackInfoRenderer(),
            structlog.dev.set_exc_info,
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
