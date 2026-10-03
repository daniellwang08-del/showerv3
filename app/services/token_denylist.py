"""Fail-open JWT revocation denylist (Redis broker DB).

Logout adds the token's ``jti`` here until its natural expiry; the auth
dependency and the WebSocket handshake reject revoked ids. Any Redis error
fails OPEN (the token is treated as valid) so a cache outage never logs every
user out, revocation is defense-in-depth, not a hard availability gate.
"""

from __future__ import annotations

from app.core.logging import get_logger

logger = get_logger(__name__)

_PREFIX = "jwt:revoked:"


async def revoke_jti(jti: str | None, ttl_seconds: int) -> None:
    """Deny a token id until ``ttl_seconds`` from now (its remaining lifetime)."""
    if not jti or ttl_seconds <= 0:
        return
    try:
        from app.core.redis_support import get_broker_redis

        await get_broker_redis().set(f"{_PREFIX}{jti}", "1", ex=int(ttl_seconds))
    except Exception as e:
        logger.warning("token_revoke_failed", error=str(e))


async def is_jti_revoked(jti: str | None) -> bool:
    """True only if the id is positively known to be revoked. Fail-open."""
    if not jti:
        return False
    try:
        from app.core.redis_support import get_broker_redis

        return bool(await get_broker_redis().exists(f"{_PREFIX}{jti}"))
    except Exception as e:
        logger.warning("token_revocation_check_unavailable", error=str(e))
        return False
