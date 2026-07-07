"""Shared cover-letter template helpers for the design-driven pipeline.

The uploaded-.docx cover-letter-template feature has been removed; cover letters are now
compiled from the user's Resume Builder design. Only the per-user directory layout and a
lightweight readiness/status payload remain.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from app.core.logging import get_logger
from app.models.cover_letter_template_schemas import CoverLetterTemplateStatusResponse
from app.models.database import User
from app.services.resume_template_service import user_template_dir

logger = get_logger(__name__)


def user_cover_letter_template_dir(user_id: str) -> Path:
    path = user_template_dir(user_id) / "cover_letter"
    path.mkdir(parents=True, exist_ok=True)
    return path


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


def user_cover_letter_template_ready(user: User | None) -> bool:
    return user_cover_letter_template_ready_for_build(user)


def template_status_payload(user: User | None) -> dict[str, Any]:
    """Lightweight cover-letter readiness status for the settings response."""
    if not user:
        return CoverLetterTemplateStatusResponse().model_dump(mode="json")
    status = getattr(user, "cover_letter_template_status", None) or "missing"
    return CoverLetterTemplateStatusResponse(
        cover_letter_template_status=status,  # type: ignore[arg-type]
        cover_letter_template_error=getattr(user, "cover_letter_template_error", None),
        cover_letter_template_ready=user_cover_letter_template_ready(user),
    ).model_dump(mode="json")
