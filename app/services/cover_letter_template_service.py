"""Per-user cover letter template upload, validation, and lifecycle."""

from __future__ import annotations

import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from docx import Document

from app.core.config import get_settings
from app.core.logging import get_logger
from app.models.cover_letter_template_schemas import (
    CoverLetterPlaceholderSpec,
    CoverLetterTemplateRequirements,
    CoverLetterTemplateStatusResponse,
)
from app.models.database import User
from app.services.docx_structure import find_tags_in_document
from app.services.resume_builder_service import fill_cover_letter_template
from app.services.resume_template_service import user_template_dir
from app.storage.database import get_session

logger = get_logger(__name__)

REQUIRED_BODY_TAG = "{{COVER_LETTER_BODY}}"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def get_cover_letter_requirements() -> CoverLetterTemplateRequirements:
    settings = get_settings()
    return CoverLetterTemplateRequirements(
        max_bytes=settings.resume_template_max_bytes,
        required_tags=[
            CoverLetterPlaceholderSpec(
                tag=REQUIRED_BODY_TAG,
                description="AI-generated cover letter body (multi-paragraph). Required.",
                required=True,
            ),
        ],
        optional_tags=[],
        layout_example=(
            "Your Name\n"
            "your.email@example.com | (555) 555-5555\n\n"
            "May 22, 2026\n\n"
            "Dear Hiring Manager,\n\n"
            "{{COVER_LETTER_BODY}}\n\n"
            "Sincerely,\n"
            "Your Name"
        ),
        notes=[
            "Upload a .docx with your own layout, fonts, and header/footer styling.",
            "Put your name, contact details, date, greeting, and signature as fixed text in the template.",
            "Only {{COVER_LETTER_BODY}} is filled per job — the AI writes the letter body paragraphs.",
            "Place {{COVER_LETTER_BODY}} in the main document body (not a floating text box).",
            "Uploading copies your template exactly; headers, graphics, and layout are preserved.",
        ],
    )


def user_cover_letter_template_dir(user_id: str) -> Path:
    path = user_template_dir(user_id) / "cover_letter"
    path.mkdir(parents=True, exist_ok=True)
    return path


def user_cover_letter_template_ready(user: User | None) -> bool:
    """True when the user has an uploaded, validated cover letter template on disk."""
    return user_cover_letter_template_ready_for_build(user)


def user_cover_letter_template_ready_for_build(user: User | None) -> bool:
    if not user:
        return False
    status = getattr(user, "cover_letter_template_status", None) or "missing"
    if status != "ready":
        return False
    working = getattr(user, "cover_letter_template_working_path", None)
    if not working:
        return False
    return Path(working).exists()


def validate_cover_letter_template_docx(source_path: Path) -> tuple[list[str], list[str], list[str]]:
    """Return (errors, warnings, detected_tags)."""
    errors: list[str] = []
    warnings: list[str] = []
    try:
        doc = Document(str(source_path))
    except Exception as e:
        return [f"Could not open DOCX: {e}"], warnings, []

    detected = find_tags_in_document(doc)
    if REQUIRED_BODY_TAG not in detected:
        errors.append(
            f"Missing required placeholder {REQUIRED_BODY_TAG}. "
            "Add it where the AI-generated letter body should appear."
        )

    other_tags = [tag for tag in detected if tag != REQUIRED_BODY_TAG]
    if other_tags:
        warnings.append(
            "Only {{COVER_LETTER_BODY}} is filled automatically. "
            f"These placeholders will appear literally unless you replace them with fixed text: "
            f"{', '.join(other_tags)}."
        )

    return errors, warnings, detected


def resolve_cover_letter_template_path(user: User | None) -> Path | None:
    """Return the user's validated working template path, or None if not ready."""
    if not user_cover_letter_template_ready_for_build(user):
        return None
    return Path(getattr(user, "cover_letter_template_working_path"))  # type: ignore[arg-type]


def template_status_payload(user: User | None) -> dict[str, Any]:
    requirements = get_cover_letter_requirements()
    if not user:
        return CoverLetterTemplateStatusResponse(requirements=requirements).model_dump(mode="json")

    status = getattr(user, "cover_letter_template_status", None) or "missing"
    detected = getattr(user, "cover_letter_template_detected_tags", None) or []
    if not isinstance(detected, list):
        detected = []

    validation_errors: list[str] = []
    validation_warnings: list[str] = []
    if status == "failed" and getattr(user, "cover_letter_template_error", None):
        validation_errors = [str(user.cover_letter_template_error)]

    return CoverLetterTemplateStatusResponse(
        cover_letter_template_status=status,  # type: ignore[arg-type]
        cover_letter_template_source_filename=getattr(user, "cover_letter_template_source_filename", None),
        cover_letter_template_error=getattr(user, "cover_letter_template_error", None),
        cover_letter_template_analyzed_at=getattr(user, "cover_letter_template_analyzed_at", None),
        cover_letter_template_ready=user_cover_letter_template_ready(user),
        detected_tags=[str(t) for t in detected],
        validation_errors=validation_errors,
        validation_warnings=validation_warnings,
        requirements=requirements,
    ).model_dump(mode="json")


async def save_uploaded_cover_letter_template(user_id: str, raw: bytes, filename: str) -> dict[str, Any]:
    settings = get_settings()
    if len(raw) > settings.resume_template_max_bytes:
        raise ValueError(f"File exceeds maximum size of {settings.resume_template_max_bytes} bytes.")
    if not filename.lower().endswith(".docx"):
        raise ValueError("Only .docx files are supported.")

    dest_dir = user_cover_letter_template_dir(user_id)
    safe_name = re.sub(r"[^\w.\- ]", "_", filename)[:200] or "cover_letter_template.docx"
    source_path = dest_dir / safe_name
    source_path.write_bytes(raw)

    errors, warnings, detected = validate_cover_letter_template_docx(source_path)
    working_path = dest_dir / "working.docx"

    async with get_session() as session:
        from app.storage.user_repository import UserRepository

        repo = UserRepository(session)
        user = await repo.get_by_id(user_id)
        if not user:
            raise ValueError("User not found")

        user.cover_letter_template_source_path = str(source_path)
        user.cover_letter_template_source_filename = safe_name
        user.cover_letter_template_detected_tags = detected
        user.cover_letter_template_analyzed_at = _utcnow()

        if errors:
            user.cover_letter_template_status = "failed"
            user.cover_letter_template_error = "; ".join(errors)
            user.cover_letter_template_working_path = None
        else:
            shutil.copy2(source_path, working_path)
            user.cover_letter_template_working_path = str(working_path)
            user.cover_letter_template_status = "ready"
            user.cover_letter_template_error = None

        await session.commit()
        payload = template_status_payload(user)
        payload["validation_warnings"] = warnings
        return payload


async def revalidate_cover_letter_template(user_id: str) -> dict[str, Any]:
    async with get_session() as session:
        from app.storage.user_repository import UserRepository

        repo = UserRepository(session)
        user = await repo.get_by_id(user_id)
        if not user:
            raise ValueError("User not found")
        source_path = getattr(user, "cover_letter_template_source_path", None)
        if not source_path or not Path(source_path).exists():
            raise ValueError("Upload a cover letter template before re-validating.")

        user.cover_letter_template_status = "processing"
        user.cover_letter_template_error = None
        await session.commit()

    source = Path(source_path)
    errors, warnings, detected = validate_cover_letter_template_docx(source)
    working_path = user_cover_letter_template_dir(user_id) / "working.docx"

    async with get_session() as session:
        from app.storage.user_repository import UserRepository

        repo = UserRepository(session)
        user = await repo.get_by_id(user_id)
        if not user:
            raise ValueError("User not found")

        user.cover_letter_template_detected_tags = detected
        user.cover_letter_template_analyzed_at = _utcnow()

        if errors:
            user.cover_letter_template_status = "failed"
            user.cover_letter_template_error = "; ".join(errors)
            user.cover_letter_template_working_path = None
        else:
            shutil.copy2(source, working_path)
            user.cover_letter_template_working_path = str(working_path)
            user.cover_letter_template_status = "ready"
            user.cover_letter_template_error = None

        await session.commit()
        payload = template_status_payload(user)
        payload["validation_warnings"] = warnings
        return payload


async def generate_cover_letter_preview_docx(user_id: str) -> Path:
    async with get_session() as session:
        from app.storage.user_repository import UserRepository

        repo = UserRepository(session)
        user = await repo.get_by_id(user_id)
        if not user:
            raise ValueError("User not found")

        if not user_cover_letter_template_ready_for_build(user):
            raise ValueError(
                "Upload and validate your cover letter template in Settings before previewing."
            )
        template_path = resolve_cover_letter_template_path(user)
        if not template_path or not template_path.exists():
            raise ValueError("Cover letter template file is missing on disk. Re-upload in Settings.")

        preview_dir = user_cover_letter_template_dir(user_id)
        preview_path = preview_dir / "preview.docx"
        sample_body = (
            "I am writing to express my interest in this role. "
            "My background aligns closely with the requirements outlined in the posting.\n\n"
            "In recent roles I have delivered scalable systems, led cross-functional initiatives, "
            "and contributed measurable business outcomes. I would welcome the opportunity to bring "
            "that experience to your team.\n\n"
            "Thank you for your consideration. I look forward to discussing how I can contribute."
        )
        fill_cover_letter_template(template_path, preview_path, sample_body)
        return preview_path
