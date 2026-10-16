"""Share a read-only interview and application report with invited people."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from app.api.rate_limit import enforce_auth_rate_limit
from app.api.routes import get_current_user, require_applicant
from app.models.database import User
from app.services import report_share
from app.storage.database import get_session

router = APIRouter(prefix="/report-shares", tags=["report-shares"])
public_router = APIRouter(prefix="/shared-reports", tags=["report-shares"])


class ShareCreate(BaseModel):
    emails: list[str] = Field(..., min_length=1, max_length=report_share.MAX_EMAILS_PER_REQUEST)
    expires_in_days: int | None = 30
    include_notes: bool = False
    message: str | None = Field(default=None, max_length=500)


class ShareUpdate(BaseModel):
    expires_in_days: int | None = None
    include_notes: bool | None = None
    reset_link: bool = False


def _bad_request(e: report_share.ShareError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share not found")


@router.get("", dependencies=[Depends(require_applicant)])
async def list_report_shares(current_user: dict = Depends(get_current_user)):
    async with get_session() as session:
        shares = await report_share.list_shares(session, current_user["user_id"])
    return {
        "shares": [report_share.share_public(s) for s in shares],
        "max_shares": report_share.MAX_SHARES,
        "expiry_choices": list(report_share.EXPIRY_CHOICES),
    }


@router.post("", status_code=status.HTTP_201_CREATED, dependencies=[Depends(require_applicant)])
async def create_report_shares(body: ShareCreate, current_user: dict = Depends(get_current_user)):
    async with get_session() as session:
        owner = await session.get(User, current_user["user_id"])
        try:
            shares = await report_share.share_with(
                session,
                owner,
                body.emails,
                expires_in_days=body.expires_in_days,
                include_notes=body.include_notes,
                message=body.message,
            )
        except report_share.ShareError as e:
            raise _bad_request(e) from e
        await session.commit()
        return {"shares": [report_share.share_public(s) for s in shares]}


@router.patch("/{share_id}", dependencies=[Depends(require_applicant)])
async def update_report_share(share_id: str, body: ShareUpdate, current_user: dict = Depends(get_current_user)):
    async with get_session() as session:
        try:
            share = await report_share.update_share(
                session, current_user["user_id"], share_id, body.model_dump(exclude_unset=True)
            )
        except report_share.ShareError as e:
            raise _bad_request(e) from e
        except report_share.ShareNotFound as e:
            raise _not_found() from e
        await session.commit()
        return report_share.share_public(share)


@router.delete("/{share_id}", dependencies=[Depends(require_applicant)])
async def delete_report_share(share_id: str, current_user: dict = Depends(get_current_user)):
    async with get_session() as session:
        try:
            await report_share.delete_share(session, current_user["user_id"], share_id)
        except report_share.ShareNotFound as e:
            raise _not_found() from e
        await session.commit()
    return {"success": True}


@router.get("/preview", dependencies=[Depends(require_applicant)])
async def preview_report(
    include_notes: bool = Query(False),
    timezone_name: str | None = Query(None, alias="timezone", max_length=64),
    current_user: dict = Depends(get_current_user),
):
    """The report exactly as an invited person sees it."""
    async with get_session() as session:
        report = await report_share.build_report(
            session, current_user["user_id"], include_notes=include_notes, tz_name=timezone_name
        )
    return {"share": None, "report": report}


@router.get("/incoming")
async def incoming_report_shares(current_user: dict = Depends(get_current_user)):
    async with get_session() as session:
        user = await session.get(User, current_user["user_id"])
        items = await report_share.incoming(session, user.email if user else None, current_user["user_id"])
    return {"shares": items}


@public_router.get("/{token}")
async def view_shared_report(
    token: str,
    request: Request,
    timezone_name: str | None = Query(None, alias="timezone", max_length=64),
):
    """Public: anyone holding an active link sees the owner's report, read only."""
    await enforce_auth_rate_limit(request, scope="shared_report", per_ip=120, per_ip_window=300)
    async with get_session() as session:
        share, expired = await report_share.find_active(session, token)
        if share is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="This link was removed or never existed.")
        if expired:
            raise HTTPException(
                status_code=status.HTTP_410_GONE,
                detail="This link has expired. Ask the person who shared it for a new one.",
            )
        report_share.record_view(share)
        await session.commit()
        report = await report_share.build_report(
            session, share.owner_id, include_notes=bool(share.include_notes), tz_name=timezone_name
        )
        return {
            "share": {
                "email": share.email,
                "expires_at": report_share.share_public(share)["expires_at"],
                "message": share.message,
            },
            "report": report,
        }
