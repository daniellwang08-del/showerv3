"""The résumé file a user imported, kept byte for byte.

"My original resume" mode uploads this file to job applications as it is and
fills application answers from its text. Nothing here re-renders the résumé
through a Resume Studio theme.
"""

from __future__ import annotations

import asyncio
import re
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import structlog
from sqlalchemy import delete, select
from sqlalchemy.orm import undefer

from app.models.database import UserOriginalResume
from app.storage.database import get_session

logger = structlog.get_logger(__name__)

PDF_MIME = "application/pdf"
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
MAX_TEXT_CHARS = 60_000


@dataclass(frozen=True)
class OriginalResumeMeta:
    filename: str
    kind: str
    byte_size: int
    uploaded_at: datetime | None
    has_text: bool


@dataclass(frozen=True)
class OriginalResumeFile:
    content: bytes
    filename: str
    media_type: str


def _clean_filename(filename: str, kind: str) -> str:
    name = Path(str(filename or "").replace("\\", "/")).name
    name = re.sub(r"[\x00-\x1f\"]", "", name).strip()
    stem = Path(name).stem.strip() or "Resume"
    return f"{stem[:200]}.{kind}"


def extract_resume_text(raw: bytes, kind: str) -> str:
    from app.services.resume_parse_service import docx_to_plain_text, pdf_to_plain_text_any

    try:
        text = pdf_to_plain_text_any(raw) if kind == "pdf" else docx_to_plain_text(raw)
    except Exception as exc:  # noqa: BLE001 - the file is still worth keeping
        logger.warning("original_resume_text_failed", kind=kind, error=str(exc)[:200])
        return ""
    text = re.sub(r"[ \t]+\n", "\n", text or "")
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text[:MAX_TEXT_CHARS]


async def save_original_resume(user_id: str, raw: bytes, filename: str) -> OriginalResumeMeta:
    """Replace the user's stored résumé with this upload. Raises ``ValueError`` on bad input."""
    from app.services.resume_parse_service import MAX_RESUME_BYTES, detect_resume_kind

    if not raw:
        raise ValueError("Empty file")
    if len(raw) > MAX_RESUME_BYTES:
        raise ValueError(f"File too large (max {MAX_RESUME_BYTES // (1024 * 1024)} MB).")
    kind = detect_resume_kind(raw, filename)
    text = await asyncio.to_thread(extract_resume_text, raw, kind)
    name = _clean_filename(filename, kind)

    async with get_session() as session:
        await session.execute(delete(UserOriginalResume).where(UserOriginalResume.user_id == user_id))
        row = UserOriginalResume(
            user_id=user_id,
            filename=name,
            kind=kind,
            byte_size=len(raw),
            file_bytes=raw,
            pdf_bytes=raw if kind == "pdf" else None,
            text=text or None,
            uploaded_at=datetime.utcnow(),
        )
        session.add(row)
        await session.commit()
    logger.info("original_resume_saved", user_id=user_id, kind=kind, bytes=len(raw), text_chars=len(text))
    return OriginalResumeMeta(name, kind, len(raw), row.uploaded_at, bool(text))


async def get_original_resume_meta(user_id: str) -> OriginalResumeMeta | None:
    async with get_session() as session:
        row = (
            await session.execute(
                select(
                    UserOriginalResume.filename,
                    UserOriginalResume.kind,
                    UserOriginalResume.byte_size,
                    UserOriginalResume.uploaded_at,
                    UserOriginalResume.text.isnot(None),
                ).where(UserOriginalResume.user_id == user_id)
            )
        ).first()
    if not row:
        return None
    return OriginalResumeMeta(row[0], row[1], int(row[2] or 0), row[3], bool(row[4]))


async def get_original_resume_text(user_id: str) -> str:
    async with get_session() as session:
        text = await session.scalar(
            select(UserOriginalResume.text).where(UserOriginalResume.user_id == user_id)
        )
    return str(text or "").strip()


async def delete_original_resume(user_id: str) -> bool:
    async with get_session() as session:
        result = await session.execute(delete(UserOriginalResume).where(UserOriginalResume.user_id == user_id))
        await session.commit()
    return bool(result.rowcount)


def _docx_to_pdf_bytes(raw: bytes) -> bytes:
    from app.services.resume_builder_service import convert_docx_to_pdf

    with tempfile.TemporaryDirectory(prefix="nao_original_") as tmp:
        src = Path(tmp) / "resume.docx"
        dst = Path(tmp) / "resume.pdf"
        src.write_bytes(raw)
        convert_docx_to_pdf(src, dst)
        return dst.read_bytes()


async def get_original_resume_file(user_id: str, file_type: str) -> OriginalResumeFile | None:
    """The stored upload as ``resume_pdf`` or ``resume_docx``.

    A PDF upload has no Word version, so ``resume_docx`` returns None for it. A
    DOCX upload is converted to PDF once (cached) for PDF-only forms.
    """
    want = "pdf" if file_type.endswith("_pdf") else "docx"
    async with get_session() as session:
        row = (
            await session.execute(
                select(UserOriginalResume)
                .options(undefer(UserOriginalResume.file_bytes), undefer(UserOriginalResume.pdf_bytes))
                .where(UserOriginalResume.user_id == user_id)
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        stem = Path(row.filename).stem or "Resume"
        if want == row.kind:
            return OriginalResumeFile(bytes(row.file_bytes), row.filename, PDF_MIME if want == "pdf" else DOCX_MIME)
        if want == "docx":
            return None
        if row.pdf_bytes:
            return OriginalResumeFile(bytes(row.pdf_bytes), f"{stem}.pdf", PDF_MIME)
        raw = bytes(row.file_bytes)

    try:
        pdf = await asyncio.to_thread(_docx_to_pdf_bytes, raw)
    except Exception as exc:  # noqa: BLE001 - the DOCX itself is still available
        logger.warning("original_resume_pdf_convert_failed", user_id=user_id, error=str(exc)[:200])
        return None
    async with get_session() as session:
        row = await session.get(UserOriginalResume, user_id)
        if row is not None:
            row.pdf_bytes = pdf
            await session.commit()
    return OriginalResumeFile(pdf, f"{stem}.pdf", PDF_MIME)
