"""Issue reports: users send them (with screenshots and files); admins triage them."""

from __future__ import annotations

import json
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile, status
from pydantic import BaseModel, Field

from app.api.routes import get_current_user, require_admin
from app.services import issue_service
from app.storage.database import get_session

router = APIRouter(prefix="/issues", tags=["issues"])
_admin = [Depends(require_admin)]


class IssueUpdate(BaseModel):
    status: str | None = Field(default=None, max_length=16)
    admin_note: str | None = Field(default=None, max_length=issue_service.NOTE_MAX)


def _bad_request(e: Exception) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Issue not found")


async def _read_uploads(files: list[UploadFile]) -> list[issue_service.Upload]:
    if len(files) > issue_service.MAX_ATTACHMENTS:
        raise issue_service.IssueError(f"Attach at most {issue_service.MAX_ATTACHMENTS} files.")
    out: list[issue_service.Upload] = []
    total = 0
    for f in files:
        data = await f.read(issue_service.MAX_FILE_BYTES + 1)
        name = issue_service.clean_filename(f.filename)
        if len(data) > issue_service.MAX_FILE_BYTES:
            raise issue_service.IssueError(
                f"{name} is larger than {issue_service.MAX_FILE_BYTES // (1024 * 1024)} MB."
            )
        total += len(data)
        if total > issue_service.MAX_TOTAL_BYTES:
            raise issue_service.IssueError(
                f"Attachments add up to more than {issue_service.MAX_TOTAL_BYTES // (1024 * 1024)} MB. "
                "Remove some and try again."
            )
        out.append(issue_service.Upload(filename=name, data=data))
    return out


@router.get("/options")
async def issue_options(_current_user: dict = Depends(get_current_user)):
    """Categories and limits, so clients show the same rules the server enforces."""
    return {
        "categories": [{"value": k, "label": v} for k, v in issue_service.CATEGORIES.items()],
        "max_attachments": issue_service.MAX_ATTACHMENTS,
        "max_file_bytes": issue_service.MAX_FILE_BYTES,
        "max_total_bytes": issue_service.MAX_TOTAL_BYTES,
        "allowed": issue_service.ALLOWED_FILES,
    }


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_issue(
    description: str = Form(..., max_length=issue_service.DESCRIPTION_MAX + 100),
    title: str = Form(default="", max_length=issue_service.TITLE_MAX * 2),
    category: str = Form(default="bug", max_length=24),
    page_url: str = Form(default="", max_length=4096),
    page_title: str = Form(default="", max_length=600),
    context: str = Form(default="", max_length=8000),
    source: str = Form(default="extension", max_length=16),
    files: list[UploadFile] = File(default=[]),
    current_user: dict = Depends(get_current_user),
):
    try:
        uploads = await _read_uploads(files)
        try:
            ctx = json.loads(context) if context else None
        except ValueError:
            ctx = None
        async with get_session() as session:
            report = await issue_service.create_report(
                session,
                current_user["user_id"],
                title=title,
                description=description,
                category=category,
                page_url=page_url,
                page_title=page_title,
                context=ctx,
                source=source if source in ("extension", "web") else "extension",
                uploads=uploads,
            )
            await session.commit()
    except issue_service.IssueError as e:
        raise _bad_request(e) from e
    return report


@router.get("")
async def list_my_issues(
    limit: int = Query(20, ge=1, le=100),
    current_user: dict = Depends(get_current_user),
):
    async with get_session() as session:
        return {"items": await issue_service.my_reports(session, current_user["user_id"], limit=limit)}


@router.get("/admin", dependencies=_admin)
async def admin_list_issues(
    status_: str | None = Query(None, alias="status", max_length=16),
    category: str | None = Query(None, max_length=24),
    q: str | None = Query(None, max_length=200),
    offset: int = Query(0, ge=0),
    limit: int = Query(issue_service.PAGE, ge=1, le=200),
):
    async with get_session() as session:
        return await issue_service.admin_list(
            session, status=status_, category=category, q=q, offset=offset, limit=limit
        )


@router.get("/admin/{report_id}", dependencies=_admin)
async def admin_get_issue(report_id: str):
    async with get_session() as session:
        try:
            return await issue_service.admin_get(session, report_id)
        except issue_service.IssueNotFound as e:
            raise _not_found() from e


@router.patch("/admin/{report_id}", dependencies=_admin)
async def admin_update_issue(report_id: str, body: IssueUpdate, current_user: dict = Depends(get_current_user)):
    async with get_session() as session:
        try:
            data = await issue_service.admin_update(
                session, current_user["user_id"], report_id, status=body.status, admin_note=body.admin_note
            )
        except issue_service.IssueNotFound as e:
            raise _not_found() from e
        except issue_service.IssueError as e:
            raise _bad_request(e) from e
        await session.commit()
    return data


@router.get("/{report_id}/attachments/{attachment_id}")
async def get_attachment(
    report_id: str,
    attachment_id: str,
    download: bool = Query(False),
    current_user: dict = Depends(get_current_user),
):
    async with get_session() as session:
        try:
            att = await issue_service.attachment_for(
                session,
                report_id,
                attachment_id,
                user_id=current_user["user_id"],
                is_admin=bool(current_user.get("is_admin")),
            )
        except issue_service.IssueNotFound as e:
            raise _not_found() from e
    inline = att.kind == "image" and not download
    ascii_name = att.filename.encode("ascii", "ignore").decode() or "attachment"
    ascii_name = ascii_name.replace('"', "")
    disposition = (
        f'{"inline" if inline else "attachment"}; filename="{ascii_name}"; '
        f"filename*=UTF-8''{quote(att.filename)}"
    )
    return Response(
        content=att.data,
        media_type=att.content_type,
        headers={
            "Content-Disposition": disposition,
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
            "Cache-Control": "private, max-age=3600",
        },
    )
