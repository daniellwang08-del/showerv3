"""Persist resume designs: compile to a working template + blueprint, and preview."""

from __future__ import annotations

import hashlib
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any

from app.core.logging import get_logger
from app.models.database import User
from app.models.resume_design_schemas import (
    ContentSkill,
    ContentWork,
    ResumeContent,
    ResumeDesign,
    ResumeDesignResponse,
)
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

# Accurate PDF blob cache (per process). Keyed by user + design hash so rapid style
# tweaks that bounce back to a prior design skip compile → dxpdf. Entries expire by
# age and count. Stores raw PDF bytes for the native PDF viewer embed.
_PREVIEW_PDF_CACHE: OrderedDict[str, tuple[float, bytes]] = OrderedDict()
# Short-lived tokens so the iframe can load a real URL ending in ``Name_resume.pdf``
# (Chrome's PDF chrome shows blob: UUIDs for anonymous object URLs).
_PREVIEW_TOKEN_CACHE: OrderedDict[str, tuple[float, str, str, str]] = OrderedDict()
_PREVIEW_PDF_CACHE_MAX = 12
_PREVIEW_PDF_CACHE_TTL_S = 180.0


# Bump when compiler layout math changes so in-process PDF cache cannot serve a
# pre-fix blob for an unchanged design JSON (e.g. contact column width).
_PREVIEW_LAYOUT_REV = "contact-icons-brand-fill-v13"


def _design_cache_key(user_id: str, design: ResumeDesign) -> str:
    raw = design.model_dump_json()
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    return f"{user_id}:{_PREVIEW_LAYOUT_REV}:{digest}"


def _preview_pdf_cache_get(key: str) -> bytes | None:
    hit = _PREVIEW_PDF_CACHE.get(key)
    if not hit:
        return None
    ts, payload = hit
    if time.monotonic() - ts > _PREVIEW_PDF_CACHE_TTL_S:
        _PREVIEW_PDF_CACHE.pop(key, None)
        return None
    _PREVIEW_PDF_CACHE.move_to_end(key)
    return payload


def _preview_pdf_cache_put(key: str, payload: bytes) -> None:
    _PREVIEW_PDF_CACHE[key] = (time.monotonic(), payload)
    _PREVIEW_PDF_CACHE.move_to_end(key)
    while len(_PREVIEW_PDF_CACHE) > _PREVIEW_PDF_CACHE_MAX:
        _PREVIEW_PDF_CACHE.popitem(last=False)


def register_preview_pdf_token(user_id: str, cache_key: str, filename: str) -> str:
    """Mint a short-lived token for the named preview-doc GET endpoint."""
    import secrets

    token = secrets.token_urlsafe(18)
    _PREVIEW_TOKEN_CACHE[token] = (time.monotonic(), user_id, cache_key, filename)
    _PREVIEW_TOKEN_CACHE.move_to_end(token)
    while len(_PREVIEW_TOKEN_CACHE) > _PREVIEW_PDF_CACHE_MAX * 2:
        _PREVIEW_TOKEN_CACHE.popitem(last=False)
    return token


def get_preview_pdf_by_token(token: str, user_id: str) -> tuple[bytes, str] | None:
    """Return ``(pdf_bytes, filename)`` when the token is valid for *user_id*."""
    hit = _PREVIEW_TOKEN_CACHE.get(token)
    if not hit:
        return None
    ts, owner_id, cache_key, filename = hit
    if time.monotonic() - ts > _PREVIEW_PDF_CACHE_TTL_S:
        _PREVIEW_TOKEN_CACHE.pop(token, None)
        return None
    if owner_id != user_id:
        return None
    payload = _preview_pdf_cache_get(cache_key)
    if payload is None:
        _PREVIEW_TOKEN_CACHE.pop(token, None)
        return None
    _PREVIEW_TOKEN_CACHE.move_to_end(token)
    return payload, filename


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


def _sync_cover_letter_from_design(user_id: str, user: User, design: ResumeDesign) -> None:
    """Keep the cover-letter template matched to the active resume design.

    Called whenever the resume working template is recompiled so job builds never
    need a separate "generate cover letter theme" step.
    """
    from app.services.cover_letter_design_compiler import compile_cover_letter_design
    from app.services.cover_letter_template_service import user_cover_letter_template_dir

    working_path = user_cover_letter_template_dir(user_id) / "working.docx"
    compile_cover_letter_design(design, user, working_path)
    user.cover_letter_template_working_path = str(working_path)
    user.cover_letter_template_status = "ready"
    user.cover_letter_template_error = None


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
    try:
        _sync_cover_letter_from_design(user_id, user, design)
    except Exception as exc:
        # Resume save must still succeed; cover letter can be retried on the next edit.
        logger.exception(
            "cover_letter_sync_failed",
            user_id=user_id,
            error=str(exc),
        )
        user.cover_letter_template_error = str(exc)[:500]
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


def _serialize_search_library(doc, active_id: str | None) -> dict[str, Any]:
    """Lightweight library hit for search (no design blob)."""
    return {
        "kind": "library",
        "id": doc.id,
        "build_id": None,
        "job_id": None,
        "name": doc.name,
        "status": doc.status,
        "source": doc.source,
        "job_title": doc.job_title,
        "company": doc.company,
        "is_active": doc.id == active_id,
        "content_ready": True,
        "created_at": doc.created_at.isoformat() if getattr(doc, "created_at", None) else None,
        "updated_at": doc.updated_at.isoformat() if getattr(doc, "updated_at", None) else None,
    }


def _serialize_search_job_build(build, job, active_id: str | None) -> dict[str, Any]:
    company = (getattr(job, "company", None) or "").strip() or None
    title = (getattr(job, "title", None) or "").strip() or None
    name_parts = [p for p in (title, company) if p]
    return {
        "kind": "job_build",
        "id": build.id,  # build id, open via from-job-build endpoint
        "build_id": build.id,
        "job_id": job.id,
        "name": " - ".join(name_parts) if name_parts else "Job resume",
        "status": getattr(build, "content_generation_status", None) or "completed",
        "source": "job_workflow",
        "job_title": title,
        "company": company,
        "is_active": False,
        "content_ready": True,
        "created_at": build.created_at.isoformat() if getattr(build, "created_at", None) else None,
        "updated_at": build.updated_at.isoformat() if getattr(build, "updated_at", None) else None,
    }


def _norm_key(company: str | None, title: str | None) -> str:
    return f"{(company or '').strip().lower()}::{(title or '').strip().lower()}"


def _tailored_work_to_content(entry: dict) -> ContentWork:
    bullets = entry.get("bullets") or entry.get("contributions") or []
    contribs = [str(b).strip() for b in bullets if isinstance(b, str) and b.strip()]
    project_title = str(entry.get("project_name") or entry.get("project_title") or "").strip()
    project_intro = str(entry.get("project_description") or entry.get("project_intro") or "").strip()
    return ContentWork(
        company_name=str(entry.get("company_name") or "").strip(),
        job_title=str(entry.get("job_title") or "").strip(),
        period_start=str(entry.get("period_start") or "").strip(),
        period_end=str(entry.get("period_end") or "").strip(),
        location=str(entry.get("location") or "").strip(),
        job_type=str(entry.get("job_type") or "").strip(),
        employment_type=str(entry.get("employment_type") or "").strip(),
        project_title=project_title,
        project_intro=project_intro,
        contributions=contribs or [""],
        used_skills=str(entry.get("used_skills") or "").strip(),
        description="",
    )


def _with_profile_project(work: ContentWork, profile_rows: list[ContentWork]) -> ContentWork:
    """Keep the profile's project title and brief description when the tailored role left them out."""
    if work.project_title and work.project_intro:
        return work
    from app.utils.company_name import companies_match
    from app.utils.profile_converter import split_role_description

    match = next((r for r in profile_rows if companies_match(r.company_name, work.company_name)), None)
    if match is None:
        return work
    has_contributions = any(str(c or "").strip() for c in match.contributions or [])
    desc = (match.description or "").strip()
    intro = (match.project_intro or "").strip() or (desc if has_contributions else split_role_description(desc)[0])
    return work.model_copy(
        update={
            "project_title": work.project_title or (match.project_title or "").strip(),
            "project_intro": work.project_intro or intro,
        }
    )


def _merge_tailored_into_design(base: ResumeDesign, tailored: dict) -> ResumeDesign:
    """Merge Phase-B tailored sections onto a base design (keeps theme/header/edu/certs)."""
    base_content = base.content.model_copy(deep=True) if base.content else ResumeContent()
    summary = str(tailored.get("profile_summary") or "").strip()
    skills_raw = tailored.get("technical_skills") or []
    skills: list[ContentSkill] = []
    if isinstance(skills_raw, list):
        for item in skills_raw:
            if not isinstance(item, dict):
                continue
            cat = str(item.get("category") or "").strip()
            vals = str(item.get("skills") or "").strip()
            if cat and vals:
                skills.append(ContentSkill(category=cat, skills=vals))
    exp_raw = tailored.get("work_experience") or []
    experience: list[ContentWork] = []
    profile_rows = list(base_content.work_experience or [])
    if isinstance(exp_raw, list):
        for entry in exp_raw:
            if isinstance(entry, dict):
                w = _tailored_work_to_content(entry)
                if w.company_name and w.job_title:
                    experience.append(_with_profile_project(w, profile_rows))

    merged = base_content.model_copy(
        update={
            "profile_summary": summary or base_content.profile_summary,
            "technical_skills": skills or base_content.technical_skills,
            "work_experience": experience or base_content.work_experience,
        }
    )
    return base.model_copy(update={"content": merged})


async def search_resumes(
    user_id: str,
    *,
    company: str | None = None,
    job_title: str | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    """Search library resumes AND completed job-workflow builds (company/role AND).

    Empty company+title returns recent resumes from both sources (browse mode).
    Job-build hits that already have a matching library resume (same company+title)
    are suppressed so each tailored job appears once (preferring the library copy).
    """
    async with get_session() as session:
        from app.storage.repository import ResumeBuildRepository
        from app.storage.resume_document_repository import ResumeDocumentRepository
        from app.storage.user_repository import UserRepository

        user = await UserRepository(session).get_by_id(user_id)
        if not user:
            raise ValueError("User not found")

        company_q = (company or "").strip() or None
        role_q = (job_title or "").strip() or None
        active_id = getattr(user, "active_resume_id", None)
        per_source_limit = max(1, min(limit, 200))

        docs = await ResumeDocumentRepository(session).search_for_user(
            user_id,
            company=company_q,
            job_title=role_q,
            limit=per_source_limit,
        )
        builds = await ResumeBuildRepository(session).search_completed_for_user(
            user_id,
            company=company_q,
            job_title=role_q,
            limit=per_source_limit,
        )

        library_keys = {_norm_key(d.company, d.job_title) for d in docs}
        # Also suppress against ALL library rows for this user (not just search hits),
        # so opening a build then searching again shows the library copy.
        all_docs = await ResumeDocumentRepository(session).list_metadata_for_user(user_id)
        all_library_keys = {_norm_key(d.company, d.job_title) for d in all_docs}

        results: list[dict[str, Any]] = [
            _serialize_search_library(d, active_id) for d in docs
        ]
        for build, job in builds:
            key = _norm_key(getattr(job, "company", None), getattr(job, "title", None))
            if key in all_library_keys or key in library_keys:
                continue
            if key == "::":
                continue
            results.append(_serialize_search_job_build(build, job, active_id))

        # Newest first across both sources
        results.sort(key=lambda r: r.get("updated_at") or "", reverse=True)
        results = results[:per_source_limit]

        return {
            "resumes": results,
            "active_id": active_id,
            "query": {"company": company_q, "job_title": role_q},
            "count": len(results),
        }


async def open_job_build_as_library_resume(user_id: str, build_id: str) -> dict[str, Any]:
    """Materialize a completed job-workflow build into the resume library and activate it.

    Creates a tailored library resume (or updates an existing one with the same
    company + job title) so the builder can edit it like any other library entry.
    """
    async with get_session() as session:
        from app.storage.repository import ResumeBuildRepository
        from app.storage.user_repository import UserRepository
        from sqlalchemy import select
        from app.models.database import Job

        repo = UserRepository(session)
        user = await repo.get_by_id(user_id)
        if not user:
            raise ValueError("User not found")

        build = await ResumeBuildRepository(session).get_by_id(build_id, user_id)
        if not build:
            raise ValueError("Job resume not found")
        if (build.content_generation_status or "") != "completed" or not isinstance(
            build.tailored_resume_data, dict
        ):
            raise ValueError("Job resume content is not ready yet")

        job_result = await session.execute(select(Job).where(Job.id == build.job_id))
        job = job_result.scalar_one_or_none()
        company = (getattr(job, "company", None) or "").strip() or None if job else None
        job_title = (getattr(job, "title", None) or "").strip() or None if job else None

        base_design = await _resolve_base_design(session, user)
        from app.services.document_content import with_profile_content
        from app.services.document_renderer import profile_payload

        base_design = with_profile_content(base_design, profile_payload(user))
        design = _merge_tailored_into_design(base_design, build.tailored_resume_data)
        name = " - ".join([p for p in (job_title, company) if p]) or "Tailored resume"
        cover = build.cover_letter_data if isinstance(build.cover_letter_data, dict) else {}

        doc = await _upsert_tailored_library_doc(
            session,
            user_id=user_id,
            name=name,
            company=company,
            job_title=job_title,
            design=design,
            cover_letter=(str(cover.get("body") or "").strip() or None),
        )

        user.active_resume_id = doc.id
        _compile_design_into_user(user_id, user, design)
        await session.commit()
        payload = await _list_payload(session, user_id)
        payload["resume"] = next((r for r in payload["resumes"] if r["id"] == doc.id), None)
        return payload


async def _resolve_base_design(session, user) -> ResumeDesign:
    """Active library design → user template → default."""
    from app.storage.resume_document_repository import ResumeDocumentRepository

    rrepo = ResumeDocumentRepository(session)
    base_design: ResumeDesign | None = None
    if user.active_resume_id:
        active_doc = await rrepo.get_by_id(user.active_resume_id, user.id)
        if active_doc and isinstance(active_doc.design, dict):
            try:
                base_design = ResumeDesign.model_validate(active_doc.design)
            except Exception:
                base_design = None
    if base_design is None and isinstance(user.resume_template_design, dict):
        try:
            base_design = ResumeDesign.model_validate(user.resume_template_design)
        except Exception:
            base_design = None
    if base_design is None:
        base_design = default_design()
    return base_design


async def _upsert_tailored_library_doc(
    session,
    *,
    user_id: str,
    name: str,
    company: str | None,
    job_title: str | None,
    design: ResumeDesign,
    cover_letter: str | None = None,
    job_description: str | None = None,
    match_score: int | None = None,
    origin: str | None = None,
):
    """Save a tailored resume.

    With ``job_description`` only a rerun of that same posting updates its
    document; two postings with the same title stay separate. Without it the
    document for the same company and title is updated (job workflow opens).
    """
    from app.storage.resume_document_repository import ResumeDocumentRepository

    rrepo = ResumeDocumentRepository(session)
    existing = None
    jd = (job_description or "").strip() or None
    jd_hash = job_description_hash(jd) if jd else None
    if jd_hash:
        existing = await rrepo.find_by_job_description_hash(user_id, jd_hash)
    else:
        target_key = _norm_key(company, job_title)
        if target_key != "::":
            for doc in await rrepo.list_for_user(user_id):
                if _norm_key(doc.company, doc.job_title) == target_key:
                    existing = doc
                    break

    if existing:
        existing.name = name[:200]
        existing.source = "tailored"
        existing.company = company
        existing.job_title = job_title
        existing.design = design.model_dump(mode="json")
        existing.status = "draft"
        if cover_letter is not None:
            existing.cover_letter = cover_letter
        if jd:
            existing.job_description = jd
            existing.job_description_hash = jd_hash
        if match_score is not None:
            existing.match_score = match_score
        if origin:
            existing.origin = origin
        return existing

    return await rrepo.create(
        user_id=user_id,
        name=name[:200],
        status="draft",
        source="tailored",
        job_title=job_title,
        company=company,
        design=design.model_dump(mode="json"),
        cover_letter=cover_letter,
        job_description=jd,
        job_description_hash=jd_hash,
        match_score=match_score,
        origin=origin,
    )


def job_description_hash(text: str) -> str:
    """Stable across whitespace and case, so a re-paste of the same posting matches."""
    import hashlib

    normalized = " ".join((text or "").split()).lower()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


async def save_ai_tailored_as_library_resume(
    user_id: str,
    *,
    content: dict,
    job_title: str | None = None,
    company: str | None = None,
    activate: bool = True,
    cover_letter: str | None = None,
    job_description: str | None = None,
    match_score: int | float | None = None,
    origin: str | None = None,
) -> dict[str, Any]:
    """Persist OneClick / extension AI-tailored sections into the resume library.

    Same merge rules as job-workflow opens: theme/header/edu/certs from the active
    (or template) design; summary/skills/experience from the AI payload.
    """
    if not isinstance(content, dict) or not content:
        raise ValueError("Tailored content is required")

    company_n = (company or "").strip() or None
    title_n = (job_title or "").strip() or None
    name = " - ".join([p for p in (title_n, company_n) if p]) or "Tailored resume"

    async with get_session() as session:
        from app.storage.user_repository import UserRepository

        user = await UserRepository(session).get_by_id(user_id)
        if not user:
            raise ValueError("User not found")

        base_design = await _resolve_base_design(session, user)
        from app.services.document_content import with_profile_content
        from app.services.document_renderer import profile_payload

        base_design = with_profile_content(base_design, profile_payload(user))
        design = _merge_tailored_into_design(base_design, content)
        doc = await _upsert_tailored_library_doc(
            session,
            user_id=user_id,
            name=name,
            company=company_n,
            job_title=title_n,
            design=design,
            cover_letter=(cover_letter or "").strip() or None,
            job_description=job_description,
            match_score=(
                int(round(match_score)) if isinstance(match_score, (int, float)) else None
            ),
            origin=origin,
        )
        if activate:
            user.active_resume_id = doc.id
            _compile_design_into_user(user_id, user, design)
        await session.commit()
        payload = await _list_payload(session, user_id)
        payload["resume"] = next((r for r in payload["resumes"] if r["id"] == doc.id), None)
        return payload


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
    and set it as the active cover letter template.

    Prefer the automatic sync in ``_compile_design_into_user`` (runs on every resume
    save). This endpoint remains for explicit/manual regeneration.
    """
    from app.services.cover_letter_template_service import (
        template_status_payload as cover_letter_status_payload,
    )

    async with get_session() as session:
        from app.storage.user_repository import UserRepository

        repo = UserRepository(session)
        user = await repo.get_by_id(user_id)
        if not user:
            raise ValueError("User not found")

        design, _ = _load_design(user)
        _sync_cover_letter_from_design(user_id, user, design)
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


async def render_design_pdf(user_id: str, design: ResumeDesign) -> tuple[bytes, int | None]:
    """Print ``design`` with the Chromium document renderer (the same templates the
    Resume studio shows). Returns ``(pdf_bytes, page_count)``; falls back to the
    DOCX -> dxpdf path (page count unknown) when the renderer is unavailable."""
    import asyncio

    from app.services.document_content import with_profile_content
    from app.services.document_renderer import profile_payload, render_resume_pdf
    from app.services.resume_builder_service import convert_docx_to_pdf

    async with get_session() as session:
        from app.storage.user_repository import UserRepository

        user = await UserRepository(session).get_by_id(user_id)
        if not user:
            raise ValueError("User not found")
        profile = profile_payload(user)
        title = " ".join(
            p for p in ((user.name_first or "").strip(), (user.name_last or "").strip()) if p
        ) or "Resume"

    try:
        rendered = await render_resume_pdf(
            with_profile_content(design, profile), profile, title=f"{title} - Resume",
        )
        return rendered.pdf, rendered.page_count
    except Exception as e:  # noqa: BLE001 - fall back to the DOCX pipeline
        logger.warning("document_render_fallback_dxpdf", file_type="design_preview", error=str(e))

    docx_path = await generate_design_preview_docx(user_id, design)
    pdf_path = docx_path.with_suffix(".pdf")

    def _convert() -> bytes:
        convert_docx_to_pdf(docx_path, pdf_path)
        return pdf_path.read_bytes()

    return await asyncio.to_thread(_convert), None


async def generate_design_preview_pdf_bytes(user_id: str, design: ResumeDesign) -> tuple[bytes, str]:
    """Render ``design`` to PDF and return ``(pdf_bytes, cache_key)``.

    Hits an in-process LRU when the same user+design was rendered recently.
    """
    cache_key = _design_cache_key(user_id, design)
    cached = _preview_pdf_cache_get(cache_key)
    if cached is not None:
        return cached, cache_key

    pdf_bytes, _pages = await render_design_pdf(user_id, design)
    if not pdf_bytes.startswith(b"%PDF"):
        raise RuntimeError("Preview PDF is not a valid PDF document")
    _preview_pdf_cache_put(cache_key, pdf_bytes)
    return pdf_bytes, cache_key


async def render_original_resume_file(
    user_id: str, file_type: str, *, company: str = "", title: str = ""
) -> tuple[bytes, str]:
    """Render the user's original résumé (active studio design + profile) for upload.

    ``file_type`` is ``resume_pdf`` or ``resume_docx``. Returns ``(bytes, filename)``.
    """
    from app.services.resume_filename import document_stem_for_user

    async with get_session() as session:
        from app.storage.user_repository import UserRepository

        user = await UserRepository(session).get_by_id(user_id)
        if not user:
            raise ValueError("User not found")
        design, _ = await load_design_for_render(session, user)
        stem = document_stem_for_user(user, "resume", company=company, title=title)
    if file_type == "resume_pdf":
        pdf, _pages = await render_design_pdf(user_id, design)
        return pdf, f"{stem}.pdf"
    path = await generate_design_preview_docx(user_id, design)
    return path.read_bytes(), f"{stem}.docx"


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
