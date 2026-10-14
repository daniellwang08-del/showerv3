"""Gmail read-only integration: OAuth connect + inbox search."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

from app.api.routes import get_current_user, require_applicant
from app.core.logging import get_logger
from app.services import gmail_service
from app.storage.database import get_session

logger = get_logger(__name__)

router = APIRouter(prefix="/gmail", tags=["gmail"])


class GmailEnabledRequest(BaseModel):
    is_enabled: bool


class GmailSearchRequest(BaseModel):
    q: str = Field(..., min_length=1, max_length=500)
    max_results: int = Field(default=15, ge=1, le=25)


def _http_error(exc: gmail_service.GmailError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=str(exc))


def _request_base_url(request: Request) -> str:
    # Prefer proxy-forwarded URL when present (production behind nginx).
    forwarded_proto = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip()
    forwarded_host = (request.headers.get("x-forwarded-host") or "").split(",")[0].strip()
    if forwarded_proto and forwarded_host:
        return f"{forwarded_proto}://{forwarded_host}"
    return str(request.base_url).rstrip("/")


@router.get("/status", dependencies=[Depends(require_applicant)])
async def get_gmail_status():
    return gmail_service.get_server_status()


@router.get("/config", dependencies=[Depends(require_applicant)])
async def get_gmail_config(current_user: dict = Depends(get_current_user)):
    user_id = current_user["user_id"]
    async with get_session() as session:
        row = await gmail_service.get_connection(session, user_id)
    return gmail_service.connection_public(row)


@router.get("/connect")
async def connect_gmail(request: Request, current_user: dict = Depends(require_applicant)):
    """Start Google OAuth. Browser navigates here; response is a redirect."""
    try:
        redirect_uri = gmail_service.resolve_redirect_uri(_request_base_url(request))
        url = gmail_service.build_authorize_url(
            user_id=current_user["user_id"],
            redirect_uri=redirect_uri,
        )
    except gmail_service.GmailError as e:
        raise _http_error(e) from e
    return RedirectResponse(url=url, status_code=status.HTTP_302_FOUND)


@router.get("/callback")
async def gmail_oauth_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
):
    """Google redirects here. Always bounce back to the SPA with a status flag."""
    if error:
        return RedirectResponse(
            gmail_service.frontend_integrations_url(gmail="error", reason=error),
            status_code=status.HTTP_302_FOUND,
        )
    if not code or not state:
        return RedirectResponse(
            gmail_service.frontend_integrations_url(gmail="error", reason="missing_code"),
            status_code=status.HTTP_302_FOUND,
        )
    try:
        user_id = gmail_service.verify_oauth_state(state)
        redirect_uri = gmail_service.resolve_redirect_uri(_request_base_url(request))
        tokens = await gmail_service.exchange_code(code, redirect_uri=redirect_uri)
        async with get_session() as session:
            await gmail_service.upsert_connection(
                session,
                user_id=user_id,
                google_email=tokens["google_email"],
                refresh_token=tokens["refresh_token"],
                access_token=tokens["access_token"],
                expires_in=int(tokens["expires_in"]),
                scopes=str(tokens["scope"]),
            )
    except gmail_service.GmailError as e:
        logger.warning("gmail_oauth_callback_failed", code=e.code, error=str(e))
        return RedirectResponse(
            gmail_service.frontend_integrations_url(gmail="error", reason=e.code),
            status_code=status.HTTP_302_FOUND,
        )
    except Exception as e:
        logger.error("gmail_oauth_callback_unexpected", error=str(e))
        return RedirectResponse(
            gmail_service.frontend_integrations_url(gmail="error", reason="unexpected"),
            status_code=status.HTTP_302_FOUND,
        )
    return RedirectResponse(
        gmail_service.frontend_integrations_url(gmail="connected"),
        status_code=status.HTTP_302_FOUND,
    )


@router.patch("/config/enabled", dependencies=[Depends(require_applicant)])
async def patch_gmail_enabled(
    body: GmailEnabledRequest,
    current_user: dict = Depends(get_current_user),
):
    user_id = current_user["user_id"]
    try:
        async with get_session() as session:
            row = await gmail_service.set_enabled(session, user_id, body.is_enabled)
    except gmail_service.GmailError as e:
        raise _http_error(e) from e
    return {"success": True, **gmail_service.connection_public(row)}


@router.delete("/config", dependencies=[Depends(require_applicant)])
async def disconnect_gmail(current_user: dict = Depends(get_current_user)):
    user_id = current_user["user_id"]
    async with get_session() as session:
        deleted = await gmail_service.delete_connection(session, user_id)
    return {"success": True, "disconnected": deleted}


async def _access_token_for_user(user_id: str):
    async with get_session() as session:
        row = await gmail_service.get_connection(session, user_id)
        if row is None:
            raise gmail_service.GmailError(
                "Connect Gmail before searching",
                code="not_connected",
                status_code=404,
            )
        return await gmail_service.get_valid_access_token(session, row)


@router.post("/search", dependencies=[Depends(require_applicant)])
async def search_gmail(
    body: GmailSearchRequest,
    current_user: dict = Depends(get_current_user),
):
    try:
        access_token = await _access_token_for_user(current_user["user_id"])
        return await gmail_service.search_messages(
            access_token,
            query=body.q,
            max_results=body.max_results,
        )
    except gmail_service.GmailError as e:
        raise _http_error(e) from e


@router.get("/search", dependencies=[Depends(require_applicant)])
async def search_gmail_get(
    q: str = Query(..., min_length=1, max_length=500),
    max_results: int = Query(default=15, ge=1, le=25),
    current_user: dict = Depends(get_current_user),
):
    """GET alias for quick probing / bookmarks; same as POST /gmail/search."""
    try:
        access_token = await _access_token_for_user(current_user["user_id"])
        return await gmail_service.search_messages(
            access_token,
            query=q,
            max_results=max_results,
        )
    except gmail_service.GmailError as e:
        raise _http_error(e) from e


@router.get("/messages/{message_id}", dependencies=[Depends(require_applicant)])
async def get_gmail_message(
    message_id: str,
    current_user: dict = Depends(get_current_user),
):
    try:
        access_token = await _access_token_for_user(current_user["user_id"])
        return await gmail_service.get_message_detail(access_token, message_id)
    except gmail_service.GmailError as e:
        raise _http_error(e) from e
