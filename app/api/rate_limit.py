"""Fail-open auth rate limiting backed by Redis (broker DB).

Protects unauthenticated endpoints (login/signup) from brute-force. If Redis is
unavailable, requests are ALLOWED (fail-open) so a cache outage never locks real
users out, brute-force protection is best-effort defense-in-depth, not a hard
availability gate.
"""

from __future__ import annotations

from fastapi import HTTPException, Request, status

from app.core.logging import get_logger

logger = get_logger(__name__)


def _client_ip(request: Request) -> str:
    """Best-effort client IP. Behind nginx the real client is the first hop of
    X-Forwarded-For; fall back to the socket peer for direct connections."""
    xff = request.headers.get("x-forwarded-for")
    if xff:
        first = xff.split(",")[0].strip()
        if first:
            return first
    return request.client.host if request.client else "unknown"


async def _hit(key: str, limit: int, window_seconds: int) -> tuple[bool, int]:
    """Increment a fixed-window counter. Returns (allowed, retry_after_seconds).

    Fail-open: any Redis error returns (True, 0)."""
    try:
        from app.core.redis_support import get_broker_redis

        r = get_broker_redis()
        count = await r.incr(key)
        if count == 1:
            await r.expire(key, window_seconds)
        if count > limit:
            ttl = await r.ttl(key)
            return False, max(1, int(ttl if ttl and ttl > 0 else window_seconds))
        return True, 0
    except Exception as e:
        logger.warning("auth_rate_limit_unavailable", key=key, error=str(e))
        return True, 0


async def enforce_auth_rate_limit(
    request: Request,
    *,
    scope: str = "login",
    email: str | None = None,
    per_ip: int = 30,
    per_ip_window: int = 300,
    per_identity: int = 8,
    per_identity_window: int = 300,
) -> None:
    """Raise HTTP 429 when an IP (or IP+identity) exceeds the attempt budget.

    Defaults: 30 attempts / 5 min per IP, 8 attempts / 5 min per email, generous
    for humans, punishing for credential-stuffing.
    """
    ip = _client_ip(request)
    allowed, retry = await _hit(f"rl:{scope}:ip:{ip}", per_ip, per_ip_window)
    if allowed and email:
        ident = email.lower().strip()
        if ident:
            allowed_id, retry_id = await _hit(
                f"rl:{scope}:id:{ident}", per_identity, per_identity_window
            )
            allowed = allowed and allowed_id
            retry = max(retry, retry_id)
    if not allowed:
        logger.warning("auth_rate_limited", scope=scope, ip=ip)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many attempts. Please wait a moment and try again.",
            headers={"Retry-After": str(retry)},
        )
