"""Typed fetch failures so the sync scheduler can tell 'reconnect' from 'wait'."""

from __future__ import annotations

from datetime import datetime


class ConnectionConfigError(ValueError):
    """Credentials are missing or the site cannot be used; the user must act."""


class SessionExpired(PermissionError):
    """The board rejected the stored session or key; the user must reconnect."""


class RateLimited(Exception):
    """Temporary throttle. ``retry_after_seconds`` comes from the board when known."""

    def __init__(self, message: str, retry_after_seconds: float | None = None) -> None:
        super().__init__(message)
        self.retry_after_seconds = retry_after_seconds


class QuotaExhausted(Exception):
    """Plan quota used up. ``resets_at`` (naive UTC) is None when it never resets."""

    def __init__(self, message: str, resets_at: datetime | None = None) -> None:
        super().__init__(message)
        self.resets_at = resets_at
