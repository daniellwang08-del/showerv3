"""Issue reports: users describe a problem and attach screenshots or files; admins triage them.

Attachments are checked by their content, not by the name or type the browser
claims, and are always served back with a safe content type.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import urlsplit

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import undefer

from app.core.logging import get_logger
from app.models.database import IssueReport, IssueReportAttachment, User

logger = get_logger(__name__)

CATEGORIES = {
    "bug": "Something is broken",
    "autofill": "Autofill or applying",
    "jobs": "Jobs and matching",
    "resume": "Resume or cover letter",
    "account": "Account, credits, or billing",
    "other": "Something else",
}
STATUSES = ("open", "in_progress", "resolved", "closed")

TITLE_MAX = 160
DESCRIPTION_MIN = 10
DESCRIPTION_MAX = 10_000
NOTE_MAX = 5_000
MAX_ATTACHMENTS = 10
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_TOTAL_BYTES = 25 * 1024 * 1024
REPORTS_PER_HOUR = 20
PAGE = 50

_IMAGE_TYPES = {"png": "image/png", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"}
_TEXT_EXTENSIONS = {"txt", "log", "csv", "json", "md", "har", "xml", "yaml", "yml"}
_OFFICE_ZIP = {
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "zip": "application/zip",
}
_OLE = {"doc": "application/msword", "xls": "application/vnd.ms-excel"}
ALLOWED_FILES = "images (PNG, JPG, GIF, WebP), PDF, Word, Excel, ZIP, RTF, or text files (TXT, LOG, CSV, JSON)"


class IssueError(Exception):
    """A request the user can fix; the message is shown as is."""


class IssueNotFound(Exception):
    pass


@dataclass(frozen=True)
class Upload:
    filename: str
    data: bytes


@dataclass(frozen=True)
class Checked:
    kind: str
    filename: str
    content_type: str


def _ext(name: str) -> str:
    return PurePosixPath(name).suffix.lower().lstrip(".")


def clean_filename(raw: str | None, fallback: str = "attachment") -> str:
    name = PurePosixPath(str(raw or "").replace("\\", "/")).name
    name = re.sub(r"[\x00-\x1f\x7f\"<>|:*?]+", "", name).strip(" .")
    if not name:
        name = fallback
    if len(name) > 200:
        stem, dot, ext = name.rpartition(".")
        name = f"{stem[:190]}.{ext[:8]}" if dot and len(ext) <= 8 else name[:200]
    return name


def image_type(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def _looks_like_text(data: bytes) -> bool:
    sample = data[:65536]
    if b"\x00" in sample:
        return False
    try:
        sample.decode("utf-8")
        return True
    except UnicodeDecodeError as e:
        # A multi-byte character cut by the sample boundary is still text.
        return e.start >= len(sample) - 3


def check_attachment(filename: str | None, data: bytes) -> Checked:
    """What this upload really is. Raises IssueError for empty, oversized, or unsupported files."""
    name = clean_filename(filename)
    if not data:
        raise IssueError(f"{name} is empty.")
    if len(data) > MAX_FILE_BYTES:
        raise IssueError(f"{name} is larger than {MAX_FILE_BYTES // (1024 * 1024)} MB.")
    img = image_type(data)
    if img:
        if _ext(name) not in {"png", "jpg", "jpeg", "gif", "webp"}:
            name = f"{PurePosixPath(name).stem or 'screenshot'}.{'jpg' if img == 'jpeg' else img}"
        return Checked("image", name, _IMAGE_TYPES[img])
    ext = _ext(name)
    if data.startswith(b"%PDF-"):
        return Checked("file", name if ext == "pdf" else f"{name}.pdf", "application/pdf")
    if data.startswith(b"PK\x03\x04") and ext in _OFFICE_ZIP:
        return Checked("file", name, _OFFICE_ZIP[ext])
    if data.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1") and ext in _OLE:
        return Checked("file", name, _OLE[ext])
    if data.startswith(b"{\\rtf") and ext == "rtf":
        return Checked("file", name, "application/rtf")
    if ext in _TEXT_EXTENSIONS and _looks_like_text(data):
        return Checked("file", name, "text/plain; charset=utf-8")
    raise IssueError(f"{name} is not a supported file. Attach {ALLOWED_FILES}.")


def _clean_text(value: str | None, limit: int) -> str:
    text = (value or "").replace("\r\n", "\n").replace("\x00", "").strip()
    return text[:limit]


def _clean_url(value: str | None) -> str | None:
    url = (value or "").strip()
    if not url:
        return None
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return None
    return url[:2048]


def _clean_context(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    out: dict[str, Any] = {}
    for key, value in list(raw.items())[:20]:
        k = re.sub(r"[^a-z0-9_]", "", str(key).lower())[:40]
        if not k:
            continue
        if isinstance(value, bool) or value is None or isinstance(value, (int, float)):
            out[k] = value
        else:
            out[k] = str(value)[:500]
    return out or None


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() + "Z" if dt else None


def _person(user: User | None) -> dict[str, Any] | None:
    if user is None:
        return None
    from app.services.report_share import display_name

    return {"id": user.id, "name": display_name(user), "email": user.email}


def attachment_public(a: IssueReportAttachment) -> dict[str, Any]:
    return {
        "id": a.id,
        "kind": a.kind,
        "filename": a.filename,
        "content_type": a.content_type,
        "byte_size": int(a.byte_size or 0),
    }


def report_public(
    r: IssueReport,
    attachments: list[IssueReportAttachment],
    *,
    reporter: User | None = None,
    changed_by: User | None = None,
    admin: bool = False,
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": r.id,
        "number": int(r.number) if r.number is not None else None,
        "category": r.category,
        "title": r.title,
        "description": r.description,
        "status": r.status,
        "source": r.source,
        "page_url": r.page_url,
        "page_title": r.page_title,
        "attachments": [attachment_public(a) for a in attachments],
        "created_at": _iso(r.created_at),
        "updated_at": _iso(r.updated_at),
        "status_changed_at": _iso(r.status_changed_at),
    }
    if admin:
        out.update(
            {
                "context": r.context or {},
                "admin_note": r.admin_note,
                "reporter": _person(reporter),
                "status_changed_by": _person(changed_by),
            }
        )
    return out


async def _attachments_by_report(session: AsyncSession, ids: list[str]) -> dict[str, list[IssueReportAttachment]]:
    out: dict[str, list[IssueReportAttachment]] = {i: [] for i in ids}
    if not ids:
        return out
    rows = await session.execute(
        select(IssueReportAttachment)
        .where(IssueReportAttachment.report_id.in_(ids))
        .order_by(IssueReportAttachment.position, IssueReportAttachment.created_at)
    )
    for a in rows.scalars():
        out.setdefault(a.report_id, []).append(a)
    return out


async def _people(session: AsyncSession, ids: set[str | None]) -> dict[str, User]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    rows = await session.execute(select(User).where(User.id.in_(ids)))
    return {u.id: u for u in rows.scalars()}


def validate_report(
    *,
    title: str | None,
    description: str | None,
    category: str | None,
    uploads: list[Upload],
) -> tuple[str, str, str, list[tuple[Checked, bytes]]]:
    """Clean fields and check attachments. Raises IssueError with a message for the user."""
    desc = _clean_text(description, DESCRIPTION_MAX + 1)
    if len(desc) < DESCRIPTION_MIN:
        raise IssueError("Describe what happened in a few words (at least 10 characters).")
    if len(desc) > DESCRIPTION_MAX:
        raise IssueError(f"Keep the description under {DESCRIPTION_MAX:,} characters.")
    cat = (category or "bug").strip().lower()
    if cat not in CATEGORIES:
        raise IssueError("Pick what the issue is about.")
    clean_title = " ".join(_clean_text(title, TITLE_MAX * 2).split())[:TITLE_MAX]
    if not clean_title:
        first = desc.split("\n", 1)[0].strip()
        clean_title = first[: TITLE_MAX - 3].rstrip() + "..." if len(first) > TITLE_MAX else first
    if len(uploads) > MAX_ATTACHMENTS:
        raise IssueError(f"Attach at most {MAX_ATTACHMENTS} files.")
    total = sum(len(u.data) for u in uploads)
    if total > MAX_TOTAL_BYTES:
        raise IssueError(f"Attachments add up to more than {MAX_TOTAL_BYTES // (1024 * 1024)} MB. Remove some and try again.")
    checked = [(check_attachment(u.filename, u.data), u.data) for u in uploads]
    return clean_title, desc, cat, checked


async def create_report(
    session: AsyncSession,
    user_id: str,
    *,
    title: str | None,
    description: str | None,
    category: str | None,
    page_url: str | None = None,
    page_title: str | None = None,
    context: Any = None,
    source: str = "extension",
    uploads: list[Upload] | None = None,
) -> dict[str, Any]:
    clean_title, desc, cat, checked = validate_report(
        title=title, description=description, category=category, uploads=uploads or []
    )
    since = datetime.utcnow() - timedelta(hours=1)
    recent = (
        await session.execute(
            select(func.count())
            .select_from(IssueReport)
            .where(IssueReport.user_id == user_id, IssueReport.created_at >= since)
        )
    ).scalar_one()
    if int(recent or 0) >= REPORTS_PER_HOUR:
        raise IssueError("You've sent a lot of reports in the last hour. Please wait a bit and try again.")

    report = IssueReport(
        id=str(uuid.uuid4()),
        user_id=user_id,
        category=cat,
        title=clean_title,
        description=desc,
        status="open",
        source=(source or "extension")[:16],
        page_url=_clean_url(page_url),
        page_title=_clean_text(page_title, 300) or None,
        context=_clean_context(context),
    )
    session.add(report)
    await session.flush()
    attachments = [
        IssueReportAttachment(
            id=str(uuid.uuid4()),
            report_id=report.id,
            kind=c.kind,
            filename=c.filename,
            content_type=c.content_type,
            byte_size=len(data),
            position=i,
            data=data,
        )
        for i, (c, data) in enumerate(checked)
    ]
    session.add_all(attachments)
    await session.flush()
    await session.refresh(report)
    logger.info(
        "issue_report_created",
        report_id=report.id,
        number=report.number,
        user_id=user_id,
        category=cat,
        attachments=len(attachments),
        bytes=sum(a.byte_size for a in attachments),
    )
    return report_public(report, attachments)


async def my_reports(session: AsyncSession, user_id: str, *, limit: int = 20) -> list[dict[str, Any]]:
    rows = await session.execute(
        select(IssueReport)
        .where(IssueReport.user_id == user_id)
        .order_by(IssueReport.created_at.desc())
        .limit(max(1, min(limit, 100)))
    )
    reports = list(rows.scalars())
    files = await _attachments_by_report(session, [r.id for r in reports])
    return [report_public(r, files.get(r.id, [])) for r in reports]


async def admin_list(
    session: AsyncSession,
    *,
    status: str | None = None,
    category: str | None = None,
    q: str | None = None,
    offset: int = 0,
    limit: int = PAGE,
) -> dict[str, Any]:
    stmt = select(IssueReport).join(User, User.id == IssueReport.user_id)
    clauses = []
    if status in STATUSES:
        clauses.append(IssueReport.status == status)
    if category in CATEGORIES:
        clauses.append(IssueReport.category == category)
    term = (q or "").strip().lower()
    if term:
        like = f"%{term}%"
        text_match = [
            func.lower(IssueReport.title).like(like),
            func.lower(IssueReport.description).like(like),
            func.lower(User.email).like(like),
            func.lower(func.coalesce(User.name, "")).like(like),
            func.lower(func.coalesce(IssueReport.page_url, "")).like(like),
        ]
        number = term.lstrip("#")
        if number.isdigit() and len(number) < 10:
            text_match.append(IssueReport.number == int(number))
        clauses.append(or_(*text_match))
    if clauses:
        stmt = stmt.where(*clauses)
    total = (await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = await session.execute(
        stmt.order_by(IssueReport.created_at.desc(), IssueReport.id.desc())
        .offset(max(0, offset))
        .limit(max(1, min(limit, 200)))
    )
    reports = list(rows.scalars())
    files = await _attachments_by_report(session, [r.id for r in reports])
    people = await _people(session, {r.user_id for r in reports} | {r.status_changed_by_user_id for r in reports})
    counts_rows = await session.execute(select(IssueReport.status, func.count()).group_by(IssueReport.status))
    counts = {s: 0 for s in STATUSES}
    for s, n in counts_rows.all():
        counts[s] = int(n)
    return {
        "total": int(total or 0),
        "counts": counts,
        "items": [
            report_public(
                r,
                files.get(r.id, []),
                reporter=people.get(r.user_id),
                changed_by=people.get(r.status_changed_by_user_id or ""),
                admin=True,
            )
            for r in reports
        ],
    }


async def admin_get(session: AsyncSession, report_id: str) -> dict[str, Any]:
    report = await session.get(IssueReport, report_id)
    if report is None:
        raise IssueNotFound()
    files = await _attachments_by_report(session, [report.id])
    people = await _people(session, {report.user_id, report.status_changed_by_user_id})
    return report_public(
        report,
        files.get(report.id, []),
        reporter=people.get(report.user_id),
        changed_by=people.get(report.status_changed_by_user_id or ""),
        admin=True,
    )


async def admin_update(
    session: AsyncSession,
    admin_id: str,
    report_id: str,
    *,
    status: str | None = None,
    admin_note: str | None = None,
) -> dict[str, Any]:
    report = await session.get(IssueReport, report_id)
    if report is None:
        raise IssueNotFound()
    if status is not None:
        if status not in STATUSES:
            raise IssueError("Unknown status.")
        if status != report.status:
            report.status = status
            report.status_changed_at = datetime.utcnow()
            report.status_changed_by_user_id = admin_id
    if admin_note is not None:
        report.admin_note = _clean_text(admin_note, NOTE_MAX) or None
    report.updated_at = datetime.utcnow()
    await session.flush()
    logger.info("issue_report_updated", report_id=report_id, admin_id=admin_id, status=report.status)
    return await admin_get(session, report_id)


async def attachment_for(
    session: AsyncSession, report_id: str, attachment_id: str, *, user_id: str, is_admin: bool
) -> IssueReportAttachment:
    """The attachment with its bytes, for the reporter or an admin."""
    report = await session.get(IssueReport, report_id)
    if report is None or (not is_admin and report.user_id != user_id):
        raise IssueNotFound()
    row = (
        await session.execute(
            select(IssueReportAttachment)
            .options(undefer(IssueReportAttachment.data))
            .where(IssueReportAttachment.id == attachment_id, IssueReportAttachment.report_id == report_id)
        )
    ).scalar_one_or_none()
    if row is None:
        raise IssueNotFound()
    return row
