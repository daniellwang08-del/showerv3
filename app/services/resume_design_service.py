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


async def load_design_for_render(session, user: User | None) -> tuple[ResumeDesign, bool]:
    """Resolve the design to render a résumé/cover letter from, self-healing a stale
    mirror.

    The ``users.resume_template_design`` column is only a *mirror* of the active library
    resume (see ``_compile_design_into_user``). If that mirror is empty but the user does
    have a library resume with a design, render from the library design instead of silently
    falling back to the default theme - otherwise a desynced or un-backfilled mirror makes
    every tailored résumé come out in the default theme. Only when no design exists anywhere
    do we use the default theme."""
    design, has_design = _load_design(user)
    if has_design or user is None:
        return design, has_design

    from app.storage.resume_document_repository import ResumeDocumentRepository

    rrepo = ResumeDocumentRepository(session)
    doc = None
    active_id = getattr(user, "active_resume_id", None)
    if active_id:
        doc = await rrepo.get_by_id(active_id, user.id)
    if doc is None:
        docs = await rrepo.list_for_user(user.id)  # ordered updated_at DESC
        doc = docs[0] if docs else None
    if doc is not None and isinstance(doc.design, dict) and doc.design:
        try:
            resolved = ResumeDesign.model_validate(doc.design)
            logger.info("resume_design_recovered_from_library", user_id=user.id, resume_id=doc.id)
            return resolved, True
        except Exception:
            logger.warning("resume_design_invalid_library", user_id=user.id, resume_id=getattr(doc, "id", None))
    return design, False


def design_response_payload(user: User | None) -> dict[str, Any]:
    design, has_design = _load_design(user)
    return ResumeDesignResponse(
        has_design=has_design,
        design=design,
        profile_work_count=count_work_roles(user) if user else 0,
        resume_template_status=getattr(user, "resume_template_status", None) or "missing",
        resume_template_ready=user_template_ready_for_build(user),
    ).model_dump(mode="json")


def _compile_design_into_user(user_id: str, user: User, design: ResumeDesign) -> list:
    """Compile a design into the user's working template + mirror columns. Used both by
    the builder auto-save and when switching/activating a library resume, so the
    extension, downloads and job-tailoring always read the active resume's template."""
    out_path = user_template_dir(user_id) / "working_template.docx"
    # Builder-authored design: apply the manual content override (if any) so the
    # downloadable working template matches what the user edited in the Content panel.
    tags, blueprint = compile_design(design, user, out_path, apply_content=True)

    user.resume_template_design = design.model_dump(mode="json")
    user.resume_template_working_path = str(out_path)
    user.resume_template_blueprint = _blueprint_for_storage(blueprint)
    user.resume_template_status = "ready"
    user.resume_template_error = None
    return tags


def _serialize_resume(doc, active_id: str | None) -> dict[str, Any]:
    return {
        "id": doc.id,
        "name": doc.name,
        "status": doc.status,
        "source": doc.source,
        "job_title": doc.job_title,
        "company": doc.company,
        "design": doc.design,
        "is_active": doc.id == active_id,
        "created_at": doc.created_at.isoformat() if getattr(doc, "created_at", None) else None,
        "updated_at": doc.updated_at.isoformat() if getattr(doc, "updated_at", None) else None,
    }


async def _list_payload(session, user_id: str) -> dict[str, Any]:
    from app.storage.resume_document_repository import ResumeDocumentRepository
    from app.storage.user_repository import UserRepository

    user = await UserRepository(session).get_by_id(user_id)
    active_id = getattr(user, "active_resume_id", None) if user else None
    docs = await ResumeDocumentRepository(session).list_for_user(user_id)
    return {"resumes": [_serialize_resume(d, active_id) for d in docs], "active_id": active_id}


async def save_user_design(user_id: str, design: ResumeDesign) -> dict[str, Any]:
    async with get_session() as session:
        from app.storage.resume_document_repository import ResumeDocumentRepository
        from app.storage.user_repository import UserRepository

        repo = UserRepository(session)
        user = await repo.get_by_id(user_id)
        if not user:
            raise ValueError("User not found")

        tags = _compile_design_into_user(user_id, user, design)

        # Mirror the edit into the active library resume (create one if the user has
        # none yet, e.g. a brand-new account saving for the first time).
        rrepo = ResumeDocumentRepository(session)
        doc = None
        if user.active_resume_id:
            doc = await rrepo.get_by_id(user.active_resume_id, user_id)
        if doc is None:
            doc = await rrepo.create(
                user_id=user_id,
                name="My Resume",
                status="draft",
                source="manual",
                design=design.model_dump(mode="json"),
            )
            user.active_resume_id = doc.id
        else:
            doc.design = design.model_dump(mode="json")

        await session.commit()

        user = await repo.get_by_id(user_id)
        logger.info("resume_design_saved", user_id=user_id, tags=len(tags))
        return template_status_payload(user)


# ─────────────────────────── Resume library (multi-resume) ───────────────────────────


async def list_resumes(user_id: str) -> dict[str, Any]:
    """Return the user's resume library + the active resume id. Lazily backfills a
    single "My Resume" row for users who saved a design before the library existed."""
    async with get_session() as session:
        from app.storage.resume_document_repository import ResumeDocumentRepository
        from app.storage.user_repository import UserRepository

        repo = UserRepository(session)
        user = await repo.get_by_id(user_id)
        if not user:
            raise ValueError("User not found")

        rrepo = ResumeDocumentRepository(session)
        docs = await rrepo.list_for_user(user_id)
        if not docs and isinstance(user.resume_template_design, dict) and user.resume_template_design:
            doc = await rrepo.create(
                user_id=user_id,
                name="My Resume",
                status="completed",
                source="manual",
                design=user.resume_template_design,
            )
            user.active_resume_id = doc.id
            await session.commit()

        return await _list_payload(session, user_id)


async def create_resume(
    user_id: str,
    *,
    name: str,
    design: ResumeDesign,
    source: str = "manual",
    status: str = "draft",
    job_title: str | None = None,
    company: str | None = None,
    activate: bool = True,
) -> dict[str, Any]:
    async with get_session() as session:
        from app.storage.resume_document_repository import ResumeDocumentRepository
        from app.storage.user_repository import UserRepository

        repo = UserRepository(session)
        user = await repo.get_by_id(user_id)
        if not user:
            raise ValueError("User not found")

        rrepo = ResumeDocumentRepository(session)
        doc = await rrepo.create(
            user_id=user_id,
            name=(name or "Untitled resume").strip() or "Untitled resume",
            status="completed" if status == "completed" else "draft",
            source="tailored" if source == "tailored" else "manual",
            job_title=job_title,
            company=company,
            design=design.model_dump(mode="json"),
        )
        if activate:
            user.active_resume_id = doc.id
            _compile_design_into_user(user_id, user, design)

        await session.commit()
        payload = await _list_payload(session, user_id)
        payload["resume"] = next((r for r in payload["resumes"] if r["id"] == doc.id), None)
        return payload


async def update_resume(
    user_id: str,
    resume_id: str,
    *,
    name: str | None = None,
    status: str | None = None,
    design: ResumeDesign | None = None,
) -> dict[str, Any]:
    async with get_session() as session:
        from app.storage.resume_document_repository import ResumeDocumentRepository
        from app.storage.user_repository import UserRepository

        repo = UserRepository(session)
        user = await repo.get_by_id(user_id)
        if not user:
            raise ValueError("User not found")

        rrepo = ResumeDocumentRepository(session)
        doc = await rrepo.get_by_id(resume_id, user_id)
        if doc is None:
            raise ValueError("Resume not found")

        if name is not None and name.strip():
            doc.name = name.strip()
        if status in {"draft", "completed"}:
            doc.status = status
        if design is not None:
            doc.design = design.model_dump(mode="json")
            # Keep the mirror in sync when editing the active resume.
            if user.active_resume_id == doc.id:
                _compile_design_into_user(user_id, user, design)

        await session.commit()
        payload = await _list_payload(session, user_id)
        payload["resume"] = next((r for r in payload["resumes"] if r["id"] == resume_id), None)
        return payload


async def duplicate_resume(user_id: str, resume_id: str) -> dict[str, Any]:
    async with get_session() as session:
        from app.storage.resume_document_repository import ResumeDocumentRepository

        rrepo = ResumeDocumentRepository(session)
        src = await rrepo.get_by_id(resume_id, user_id)
        if src is None:
            raise ValueError("Resume not found")

        new_doc = await rrepo.create(
            user_id=user_id,
            name=f"{src.name} (copy)"[:200],
            status="draft",
            source=src.source,
            job_title=src.job_title,
            company=src.company,
            design=src.design,
        )
        await session.commit()
        payload = await _list_payload(session, user_id)
        payload["resume"] = next((r for r in payload["resumes"] if r["id"] == new_doc.id), None)
        return payload


async def activate_resume(user_id: str, resume_id: str) -> dict[str, Any]:
    async with get_session() as session:
        from app.storage.resume_document_repository import ResumeDocumentRepository
        from app.storage.user_repository import UserRepository

        repo = UserRepository(session)
        user = await repo.get_by_id(user_id)
        if not user:
            raise ValueError("User not found")

        rrepo = ResumeDocumentRepository(session)
        doc = await rrepo.get_by_id(resume_id, user_id)
        if doc is None:
            raise ValueError("Resume not found")

        user.active_resume_id = doc.id
        if isinstance(doc.design, dict) and doc.design:
            try:
                _compile_design_into_user(user_id, user, ResumeDesign.model_validate(doc.design))
            except Exception:
                logger.warning("resume_activate_compile_failed", user_id=user_id, resume_id=resume_id)

        await session.commit()
        payload = await _list_payload(session, user_id)
        payload["resume"] = next((r for r in payload["resumes"] if r["id"] == resume_id), None)
        return payload


async def delete_resume(user_id: str, resume_id: str) -> dict[str, Any]:
    async with get_session() as session:
        from app.storage.resume_document_repository import ResumeDocumentRepository
        from app.storage.user_repository import UserRepository

        repo = UserRepository(session)
        user = await repo.get_by_id(user_id)
        if not user:
            raise ValueError("User not found")

        rrepo = ResumeDocumentRepository(session)
        doc = await rrepo.get_by_id(resume_id, user_id)
        if doc is None:
            raise ValueError("Resume not found")

        was_active = user.active_resume_id == doc.id
        await rrepo.delete(doc)

        if was_active:
            remaining = await rrepo.list_for_user(user_id)
            if remaining:
                nxt = remaining[0]
                user.active_resume_id = nxt.id
                if isinstance(nxt.design, dict) and nxt.design:
                    try:
                        _compile_design_into_user(user_id, user, ResumeDesign.model_validate(nxt.design))
                    except Exception:
                        logger.warning("resume_delete_reactivate_failed", user_id=user_id)
            else:
                user.active_resume_id = None

        await session.commit()
        return await _list_payload(session, user_id)


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
        compile_cover_letter_design(design, user, working_path)

        user.cover_letter_template_working_path = str(working_path)
        user.cover_letter_template_status = "ready"
        user.cover_letter_template_error = None
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
        _tags, blueprint = compile_design(design, user, template_path, apply_content=True)
        # The PDF preview must reflect the manual content override too, so overlay it onto
        # the user before deriving the sample tailored payload + render context.
        from app.services.resume_content_overlay import apply_content_overlay

        content_user = apply_content_overlay(user, design.content)
        tailored = build_preview_tailored(content_user)
        context = build_render_context(content_user, tailored, job=None)
        # Preview reflects the design being edited (which may be unsaved), so override
        # the skills theme + palette the fill engine uses.
        context["tailored"]["skills_style"] = design.sections.skills_style.model_dump(mode="json")
        context["tailored"]["experience_style"] = design.sections.experience_style.model_dump(mode="json")
        context["tailored"]["colors"] = design.colors.model_dump(mode="json")
        # Browser-measured per-role body gaps for the design being previewed, so the
        # downloadable .docx reproduces the exact spacing shown in the live preview.
        if design.layout.layout_metrics is not None:
            context["tailored"]["layout_metrics"] = design.layout.layout_metrics.model_dump(mode="json")

    preview_path = preview_dir / "design_preview.docx"
    fill_user_resume_template(template_path, blueprint, context, preview_path)
    return preview_path


async def generate_saved_design_docx(user_id: str) -> Path:
    """Render a downloadable .docx from the user's SAVED design (default theme if none).

    Used by the Resume Builder "Download DOCX" button so the file always matches the
    builder preview, with no uploaded-template dependency."""
    async with get_session() as session:
        from app.storage.user_repository import UserRepository

        repo = UserRepository(session)
        user = await repo.get_by_id(user_id)
        if not user:
            raise ValueError("User not found")
        design, _ = _load_design(user)
    return await generate_design_preview_docx(user_id, design)
