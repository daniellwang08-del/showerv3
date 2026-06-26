"""Persist resume designs: compile to a working template + blueprint, and preview."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from app.core.logging import get_logger
from app.models.database import User
from app.models.resume_design_schemas import ResumeDesign, ResumeDesignResponse
from app.services.resume_blueprint_renderer import fill_user_resume_template
from app.services.resume_context_builder import build_preview_tailored, build_render_context
from app.services.resume_design_compiler import compile_design
from app.services.resume_template_service import (
    _blueprint_for_storage,
    _utcnow,
    count_work_roles,
    template_status_payload,
    user_template_dir,
    user_template_ready_for_build,
)
from app.services.resume_themes import default_design
from app.storage.database import get_session

logger = get_logger(__name__)


def _load_design(user: User | None) -> tuple[ResumeDesign, bool]:
    raw = getattr(user, "resume_template_design", None) if user else None
    if isinstance(raw, dict) and raw:
        try:
            return ResumeDesign.model_validate(raw), True
        except Exception:
            logger.warning("resume_design_invalid_stored", user_id=getattr(user, "id", None))
    return default_design(), False


def design_response_payload(user: User | None) -> dict[str, Any]:
    design, has_design = _load_design(user)
    return ResumeDesignResponse(
        has_design=has_design,
        design=design,
        profile_work_count=count_work_roles(user) if user else 0,
        resume_template_status=getattr(user, "resume_template_status", None) or "missing",
        resume_template_ready=user_template_ready_for_build(user),
    ).model_dump(mode="json")


async def save_user_design(user_id: str, design: ResumeDesign) -> dict[str, Any]:
    async with get_session() as session:
        from app.storage.user_repository import UserRepository

        repo = UserRepository(session)
        user = await repo.get_by_id(user_id)
        if not user:
            raise ValueError("User not found")

        out_path = user_template_dir(user_id) / "working_template.docx"
        tags, blueprint = compile_design(design, user, out_path)
        profile_work_count = count_work_roles(user)

        user.resume_template_design = design.model_dump(mode="json")
        user.resume_template_source_path = str(out_path)
        user.resume_template_working_path = str(out_path)
        user.resume_template_source_filename = "Resume Builder design.docx"
        user.resume_template_blueprint = _blueprint_for_storage(blueprint)
        user.resume_template_profile_work_count = profile_work_count
        user.resume_template_analyzed_at = _utcnow()
        user.resume_template_status = "ready"
        user.resume_template_error = None
        await session.commit()

        user = await repo.get_by_id(user_id)
        logger.info("resume_design_saved", user_id=user_id, tags=len(tags))
        return template_status_payload(user)


async def generate_cover_letter_from_design(user_id: str) -> dict[str, Any]:
    """Compile a cover letter template from the user's saved resume design (or default)
    and set it as the active cover letter template."""
    from app.services.cover_letter_design_compiler import compile_cover_letter_design
    from app.services.cover_letter_template_service import (
        template_status_payload as cover_letter_status_payload,
        user_cover_letter_template_dir,
    )

    async with get_session() as session:
        from app.storage.user_repository import UserRepository

        repo = UserRepository(session)
        user = await repo.get_by_id(user_id)
        if not user:
            raise ValueError("User not found")

        design, _ = _load_design(user)
        working_path = user_cover_letter_template_dir(user_id) / "working.docx"
        detected = compile_cover_letter_design(design, user, working_path)

        user.cover_letter_template_source_path = str(working_path)
        user.cover_letter_template_source_filename = "Resume Builder cover letter.docx"
        user.cover_letter_template_working_path = str(working_path)
        user.cover_letter_template_detected_tags = detected
        user.cover_letter_template_status = "ready"
        user.cover_letter_template_error = None
        user.cover_letter_template_analyzed_at = _utcnow()
        await session.commit()

        user = await repo.get_by_id(user_id)
        logger.info("cover_letter_design_generated", user_id=user_id)
        return cover_letter_status_payload(user)


async def generate_design_preview_docx(user_id: str, design: ResumeDesign) -> Path:
    async with get_session() as session:
        from app.storage.user_repository import UserRepository

        repo = UserRepository(session)
        user = await repo.get_by_id(user_id)
        if not user:
            raise ValueError("User not found")

        preview_dir = user_template_dir(user_id)
        template_path = preview_dir / "design_preview_template.docx"
        _tags, blueprint = compile_design(design, user, template_path)
        tailored = build_preview_tailored(user)
        context = build_render_context(user, tailored, job=None)
        # Preview reflects the design being edited (which may be unsaved), so override
        # the skills theme + palette the fill engine uses.
        context["tailored"]["skills_style"] = design.sections.skills_style.model_dump(mode="json")
        context["tailored"]["experience_style"] = design.sections.experience_style.model_dump(mode="json")
        context["tailored"]["colors"] = design.colors.model_dump(mode="json")

    preview_path = preview_dir / "design_preview.docx"
    fill_user_resume_template(template_path, blueprint, context, preview_path)
    return preview_path
