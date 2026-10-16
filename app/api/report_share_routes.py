"""Share a read-only interview and application report with other NAO accounts."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.api.routes import get_current_user, require_applicant
from app.models.database import User
from app.services import report_share
from app.storage.database import get_session

router = APIRouter(prefix="/report-shares", tags=["report-shares"])
_owner_only = [Depends(require_applicant)]


class ShareCreate(BaseModel):
    emails: list[str] = Field(..., min_length=1, max_length=report_share.MAX_EMAILS_PER_REQUEST)
    expires_in_days: int | None = None
    include_notes: bool = False
    message: str | None = Field(default=None, max_length=500)


class ShareUpdate(BaseModel):
    expires_in_days: int | None = None
    include_notes: bool | None = None


def _bad_request(e: report_share.ShareError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


def _not_found(detail: str = "Share not found") -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)


@router.get("", dependencies=_owner_only)
async def list_report_shares(current_user: dict = Depends(get_current_user)):
    async with get_session() as session:
        rows = await report_share.list_shares(session, current_user["user_id"])
    return {
        "shares": [report_share.share_public(share, viewer) for share, viewer in rows],
        "max_shares": report_share.MAX_SHARES,
        "expiry_choices": list(report_share.EXPIRY_CHOICES),
    }


@router.post("", status_code=status.HTTP_201_CREATED, dependencies=_owner_only)
async def create_report_shares(body: ShareCreate, current_user: dict = Depends(get_current_user)):
    async with get_session() as session:
        owner = await session.get(User, current_user["user_id"])
        try:
            rows = await report_share.share_with(
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
        return {"shares": [report_share.share_public(share, viewer) for share, viewer in rows]}


@router.patch("/{share_id}", dependencies=_owner_only)
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
        return report_share.share_public(share, await session.get(User, share.viewer_id))


@router.delete("/{share_id}", dependencies=_owner_only)
async def delete_report_share(share_id: str, current_user: dict = Depends(get_current_user)):
    async with get_session() as session:
        try:
            await report_share.delete_share(session, current_user["user_id"], share_id)
        except report_share.ShareNotFound as e:
            raise _not_found() from e
        await session.commit()
    return {"success": True}


@router.get("/preview", dependencies=_owner_only)
async def preview_report(
    include_notes: bool = Query(False),
    timezone_name: str | None = Query(None, alias="timezone", max_length=64),
    current_user: dict = Depends(get_current_user),
):
    """The report exactly as the people you share with see it."""
    async with get_session() as session:
        report = await report_share.build_report(
            session, current_user["user_id"], include_notes=include_notes, tz_name=timezone_name
        )
    return {"share": None, "report": report}


@router.get("/incoming")
async def incoming_report_shares(current_user: dict = Depends(get_current_user)):
    """Reports other people shared with you. Open to admins too, who can receive but not share."""
    async with get_session() as session:
        items = await report_share.incoming(session, current_user["user_id"])
    return {"shares": items}


@router.get("/incoming/{share_id}")
async def view_incoming_report(
    share_id: str,
    timezone_name: str | None = Query(None, alias="timezone", max_length=64),
    current_user: dict = Depends(get_current_user),
):
    async with get_session() as session:
        try:
            share, owner = await report_share.viewer_share(session, current_user["user_id"], share_id)
        except report_share.ShareNotFound as e:
            raise _not_found("This report is no longer shared with you.") from e
        report_share.record_view(share)
        await session.commit()
        report = await report_share.build_report(
            session, share.owner_id, include_notes=bool(share.include_notes), tz_name=timezone_name
        )
        return {"share": report_share.incoming_public(share, owner), "report": report}
