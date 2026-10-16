"""Mail connection through Nylas hosted auth (powers the Interviews page)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import RedirectResponse

from app.api.routes import get_current_user, require_applicant
from app.core.logging import get_logger
from app.services import nylas_service
from app.storage.database import get_session

logger = get_logger(__name__)

router = APIRouter(prefix="/mail", tags=["mail"])


def _request_base_url(request: Request) -> str:
    forwarded_proto = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip()
    forwarded_host = (request.headers.get("x-forwarded-host") or "").split(",")[0].strip()
    if forwarded_proto and forwarded_host:
        return f"{forwarded_proto}://{forwarded_host}"
    return str(request.base_url).rstrip("/")


def _redirect(**params: str) -> RedirectResponse:
    return RedirectResponse(nylas_service.frontend_interviews_url(**params), status_code=status.HTTP_302_FOUND)


@router.get("/status", dependencies=[Depends(require_applicant)])
async def get_mail_status():
    return nylas_service.server_status()


@router.get("/config", dependencies=[Depends(require_applicant)])
async def get_mail_config(current_user: dict = Depends(get_current_user)):
    async with get_session() as session:
        row = await nylas_service.get_connection(session, current_user["user_id"])
    return nylas_service.connection_public(row)


@router.get("/connect")
async def connect_mail(request: Request, current_user: dict = Depends(require_applicant)):
    """Start Nylas hosted sign-in. The browser navigates here and is redirected."""
    try:
        url = nylas_service.build_authorize_url(
            user_id=current_user["user_id"],
            redirect_uri=nylas_service.resolve_redirect_uri(_request_base_url(request)),
        )
    except nylas_service.MailError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e)) from e
    return RedirectResponse(url=url, status_code=status.HTTP_302_FOUND)


@router.get("/callback")
async def mail_oauth_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    error_description: str | None = None,
):
    """Nylas returns here after sign-in. Always bounce back to the Interviews page."""
    if error:
        return _redirect(mail="error", reason=error_description or error)
    if not code or not state:
        return _redirect(mail="error", reason="missing_code")
    try:
        user_id = nylas_service.verify_oauth_state(state)
        grant = await nylas_service.exchange_code(
            code, redirect_uri=nylas_service.resolve_redirect_uri(_request_base_url(request))
        )
        async with get_session() as session:
            await nylas_service.upsert_connection(session, user_id=user_id, **grant)
    except nylas_service.MailError as e:
        logger.warning("mail_oauth_callback_failed", code=e.code, error=str(e))
        return _redirect(mail="error", reason=e.code)
    except Exception as e:
        logger.error("mail_oauth_callback_unexpected", error=str(e))
        return _redirect(mail="error", reason="unexpected")
    return _redirect(mail="connected")


@router.delete("/config", dependencies=[Depends(require_applicant)])
async def disconnect_mail(current_user: dict = Depends(get_current_user)):
    async with get_session() as session:
        deleted = await nylas_service.delete_connection(session, current_user["user_id"])
    return {"success": True, "disconnected": deleted}
