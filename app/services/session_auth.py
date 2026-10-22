"""Single source of truth for "is this token allowed in?".

Used by the HTTP dependency (`get_current_user`) and the WebSocket handshake so
both enforce the same rules: valid signature, not revoked, issued after the
user's session cutoff, account active, and not blocked by an admin.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timezone

from app.core.logging import get_logger
from app.models.database import User
from app.services.auth_service import AuthService
from app.services.signup_approval_service import APPROVAL_REJECTED, is_blocked
from app.storage.database import get_session
from app.storage.user_repository import UserRepository

logger = get_logger(__name__)

AUTH_STATUS_HEADER = "X-Auth-Status"
REJECTED_DETAIL = "This account has been blocked. Contact an administrator."


@dataclass
class SessionAuthError(Exception):
    status_code: int
    detail: str
    reason: str
    auth_status: str | None = None


@dataclass
class ResolvedSession:
    payload: dict
    user: User


def issued_before_cutoff(payload: dict, user: User) -> bool:
    cutoff = getattr(user, "sessions_valid_after", None)
    if cutoff is None:
        return False
    iat = payload.get("iat")
    if not isinstance(iat, (int, float)):
        return True
    return int(iat) < int(cutoff.replace(tzinfo=timezone.utc).timestamp())


async def resolve_session(token: str | None) -> ResolvedSession:
    """Validate `token` against the DB. Raises SessionAuthError; never fails open."""
    if not token:
        raise SessionAuthError(401, "Not authenticated", "missing_token")
    payload = AuthService.verify_token(token)
    if not payload:
        raise SessionAuthError(401, "Invalid token", "invalid_token")

    from app.services.token_denylist import is_jti_revoked

    if await is_jti_revoked(payload.get("jti")):
        raise SessionAuthError(401, "Token revoked", "revoked_token")

    uid = payload.get("user_id")
    sub = payload.get("sub")
    async with get_session() as session:
        repo = UserRepository(session)
        if uid is not None and str(uid).strip():
            user = await repo.get_by_id(str(uid).strip())
        elif isinstance(sub, str) and sub.strip():
            user = await repo.get_by_email(sub.lower().strip())
        else:
            user = None

    if user is None or not user.is_active:
        raise SessionAuthError(401, "Account disabled", "inactive_user")
    if issued_before_cutoff(payload, user):
        raise SessionAuthError(401, "Session expired. Please sign in again.", "session_cutoff")

    if is_blocked(user):
        # Blocked accounts hold no usable session: clients treat this as signed out.
        raise SessionAuthError(401, REJECTED_DETAIL, "approval_rejected", auth_status=APPROVAL_REJECTED)

    return ResolvedSession(payload=payload, user=user)
