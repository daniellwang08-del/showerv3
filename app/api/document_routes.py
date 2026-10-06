"""Documents: the Resume studio renderer, the generated-documents library and
tailor-from-job-description.

PDFs are printed by the Chromium document renderer from the same React templates
the studio draws on screen, so a download matches the design exactly. DOCX files
are the editable export built from the same design settings.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.routes import get_current_user
from app.core.logging import get_logger
from app.models.database import Job, ResumeBuildResult, ResumeDocument
from app.models.resume_design_schemas import ResumeDesign
from app.storage.database import get_session
from app.storage.resume_document_repository import ResumeDocumentRepository
from app.storage.user_repository import UserRepository

logger = get_logger(__name__)

router = APIRouter(prefix="/documents", tags=["documents"])

DOCX_MEDIA = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
FileType = Literal["resume_pdf", "resume_docx", "cover_letter_pdf", "cover_letter_docx"]


def _user_id(current_user: dict) -> str:
    uid = current_user.get("user_id")
    if not uid:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return uid


def _disposition(filename: str, inline: bool = False) -> str:
    kind = "inline" if inline else "attachment"
    ascii_name = filename.encode("ascii", "replace").decode("ascii").replace('"', "")
    return f"{kind}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"


async def _person_stem(user_id: str, kind: str) -> tuple[str, str]:
    """``(file_stem, display_name)`` for the signed-in user."""
    from app.services.resume_builder_service import person_document_stem

    async with get_session() as session:
        user = await UserRepository(session).get_by_id(user_id)
        first = ((user.name_first if user else "") or "").strip()
        last = ((user.name_last if user else "") or "").strip()
    display = " ".join(p for p in (first, last) if p) or "Resume"
    return person_document_stem(first, last, kind), display


def _pdf_response(pdf: bytes, filename: str, page_count: int | None, inline: bool) -> Response:
    headers = {
        "Content-Disposition": _disposition(filename, inline),
        "Cache-Control": "no-store",
        "Access-Control-Expose-Headers": "Content-Disposition, X-Page-Count",
    }
    if page_count is not None:
        headers["X-Page-Count"] = str(page_count)
    return Response(content=pdf, media_type="application/pdf", headers=headers)


# ---------------------------------------------------------------------------
# Rendering (Resume studio)
# ---------------------------------------------------------------------------


class RenderRequest(BaseModel):
    design: ResumeDesign
    # When set, render the cover letter (in the design's letterhead) instead of the resume.
    cover_letter: str | None = Field(default=None, max_length=20_000)
    inline: bool = False


async def _render_cover_letter(user_id: str, design: ResumeDesign, body: str) -> tuple[bytes, int | None]:
    from app.services.document_renderer import profile_payload, render_cover_letter_pdf

    async with get_session() as session:
        user = await UserRepository(session).get_by_id(user_id)
        if not user:
            raise ValueError("User not found")
        profile = profile_payload(user)
    _stem, display = await _person_stem(user_id, "cover_letter")
    rendered = await render_cover_letter_pdf(design, profile, body, title=f"{display} - Cover Letter")
    return rendered.pdf, rendered.page_count


async def _cover_letter_docx(user_id: str, design: ResumeDesign, body: str):
    from app.services.cover_letter_design_compiler import compile_cover_letter_design
    from app.services.resume_builder_service import fill_cover_letter_template
    from app.services.resume_template_service import user_template_dir

    async with get_session() as session:
        user = await UserRepository(session).get_by_id(user_id)
        if not user:
            raise ValueError("User not found")
        out_dir = user_template_dir(user_id)
        template = out_dir / "studio_cover_letter_template.docx"
        compile_cover_letter_design(design, user, template)
    out = out_dir / "studio_cover_letter.docx"
    return await asyncio.to_thread(fill_cover_letter_template, template, out, body)


@router.post("/render/pdf")
async def render_pdf(body: RenderRequest, current_user: dict = Depends(get_current_user)):
    """Print a (possibly unsaved) design to PDF. ``X-Page-Count`` reports the pages."""
    from app.services.resume_design_service import render_design_pdf

    user_id = _user_id(current_user)
    try:
        if body.cover_letter is not None:
            pdf, pages = await _render_cover_letter(user_id, body.design, body.cover_letter)
            kind = "cover_letter"
        else:
            pdf, pages = await render_design_pdf(user_id, body.design)
            kind = "resume"
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("document_render_pdf_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=503, detail="Could not render the PDF. Please try again.")
    stem, _ = await _person_stem(user_id, kind)
    return _pdf_response(pdf, f"{stem}.pdf", pages, body.inline)


@router.post("/render/docx")
async def render_docx(body: RenderRequest, current_user: dict = Depends(get_current_user)):
    """Editable Word export built from the same design settings."""
    from app.services.resume_design_service import generate_design_preview_docx

    user_id = _user_id(current_user)
    try:
        if body.cover_letter is not None:
            path = await _cover_letter_docx(user_id, body.design, body.cover_letter)
            kind = "cover_letter"
        else:
            path = await generate_design_preview_docx(user_id, body.design)
            kind = "resume"
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("document_render_docx_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail="Could not build the Word file.")
    stem, _ = await _person_stem(user_id, kind)
    return FileResponse(
        path=str(path),
        media_type=DOCX_MEDIA,
        headers={"Content-Disposition": _disposition(f"{stem}.docx"), "Cache-Control": "no-store"},
    )


# ---------------------------------------------------------------------------
# Documents library
# ---------------------------------------------------------------------------


def _iso(v: Any) -> str | None:
    return v.isoformat() if v is not None else None


@router.get("")
async def list_documents(current_user: dict = Depends(get_current_user)):
    """Everything the system generated for the user: tailored and manual library
    resumes, plus per-job builds from the job pipeline with their file statuses."""
    user_id = _user_id(current_user)
    async with get_session() as session:
        user = await UserRepository(session).get_by_id(user_id)
        active_id = getattr(user, "active_resume_id", None) if user else None
        docs = await ResumeDocumentRepository(session).list_metadata_for_user(user_id)
        with_letter = set(
            (
                await session.execute(
                    select(ResumeDocument.id).where(
                        ResumeDocument.user_id == user_id,
                        ResumeDocument.cover_letter.isnot(None),
                    )
                )
            ).scalars()
        )
        with_posting = set(
            (
                await session.execute(
                    select(ResumeDocument.id).where(
                        ResumeDocument.user_id == user_id,
                        ResumeDocument.job_description.isnot(None),
                    )
                )
            ).scalars()
        )
        rows = (
            await session.execute(
                select(ResumeBuildResult, Job)
                .join(Job, Job.id == ResumeBuildResult.job_id)
                .where(ResumeBuildResult.user_id == user_id)
                .order_by(ResumeBuildResult.updated_at.desc())
                .limit(300)
            )
        ).all()

    library = [
        {
            "id": d.id,
            "name": d.name,
            "status": d.status,
            "source": d.source,
            "job_title": d.job_title,
            "company": d.company,
            "is_active": d.id == active_id,
            "has_cover_letter": d.id in with_letter,
            "has_job_description": d.id in with_posting,
            "match_score": d.match_score,
            "origin": d.origin,
            "created_at": _iso(d.created_at),
            "updated_at": _iso(d.updated_at),
        }
        for d in docs
    ]
    builds = [
        {
            "id": b.id,
            "job_id": j.id,
            "job_title": (j.title or "").strip() or None,
            "company": (j.company or "").strip() or None,
            "job_url": j.source_url,
            "content_status": b.content_generation_status,
            "content_error": b.content_generation_error,
            "files": {
                "resume_pdf": b.resume_pdf_status,
                "resume_docx": b.resume_docx_status,
                "cover_letter_pdf": b.cover_letter_pdf_status,
                "cover_letter_docx": b.cover_letter_docx_status,
            },
            "created_at": _iso(b.created_at),
            "updated_at": _iso(b.updated_at),
        }
        for b, j in rows
    ]
    return {"library": library, "builds": builds, "active_id": active_id}


@router.get("/search")
async def search_documents(
    q: str = Query(..., min_length=2, max_length=200),
    current_user: dict = Depends(get_current_user),
):
    """Ids of documents whose role, company or job description contains ``q``.

    The list endpoint omits posting text, so the page asks here to search inside it.
    """
    from sqlalchemy import or_

    from app.models.database import JobExtraction
    from app.storage.resume_document_repository import resume_search_ilike_pattern

    user_id = _user_id(current_user)
    pattern = resume_search_ilike_pattern(q.strip())
    async with get_session() as session:
        library_ids = await ResumeDocumentRepository(session).search_text_for_user(user_id, q)
        build_ids = list(
            (
                await session.execute(
                    select(ResumeBuildResult.id)
                    .join(Job, Job.id == ResumeBuildResult.job_id)
                    .outerjoin(JobExtraction, JobExtraction.id == Job.extraction_id)
                    .where(
                        ResumeBuildResult.user_id == user_id,
                        or_(
                            Job.title.ilike(pattern, escape="\\"),
                            Job.company.ilike(pattern, escape="\\"),
                            JobExtraction.description.ilike(pattern, escape="\\"),
                        ),
                    )
                    .limit(300)
                )
            ).scalars()
        )
    return {"library_ids": library_ids, "build_ids": build_ids}


@router.get("/resumes/{resume_id}/job-description")
async def get_library_job_description(resume_id: str, current_user: dict = Depends(get_current_user)):
    """The posting a resume was tailored to, for interview prep."""
    from sqlalchemy.orm import undefer

    user_id = _user_id(current_user)
    async with get_session() as session:
        doc = (
            await session.execute(
                select(ResumeDocument)
                .options(undefer(ResumeDocument.job_description))
                .where(ResumeDocument.id == resume_id, ResumeDocument.user_id == user_id)
            )
        ).scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Resume not found")
    return {
        "job_description": doc.job_description,
        "job_title": doc.job_title,
        "company": doc.company,
        "match_score": doc.match_score,
        "origin": doc.origin,
        "created_at": _iso(doc.created_at),
    }


async def _library_doc(user_id: str, resume_id: str) -> tuple[ResumeDesign, str | None]:
    from sqlalchemy.orm import undefer

    async with get_session() as session:
        doc = (
            await session.execute(
                select(ResumeDocument)
                .options(undefer(ResumeDocument.design), undefer(ResumeDocument.cover_letter))
                .where(ResumeDocument.id == resume_id, ResumeDocument.user_id == user_id)
            )
        ).scalar_one_or_none()
        if not doc:
            raise HTTPException(status_code=404, detail="Resume not found")
        try:
            design = ResumeDesign.model_validate(doc.design or {})
        except Exception:
            raise HTTPException(status_code=422, detail="This resume's design could not be read.")
        return design, doc.cover_letter


@router.get("/resumes/{resume_id}/cover-letter")
async def get_library_cover_letter(resume_id: str, current_user: dict = Depends(get_current_user)):
    user_id = _user_id(current_user)
    _design, letter = await _library_doc(user_id, resume_id)
    return {"cover_letter": letter}


class CoverLetterUpdate(BaseModel):
    cover_letter: str | None = Field(default=None, max_length=20_000)


@router.put("/resumes/{resume_id}/cover-letter")
async def update_library_cover_letter(
    resume_id: str, body: CoverLetterUpdate, current_user: dict = Depends(get_current_user)
):
    user_id = _user_id(current_user)
    async with get_session() as session:
        doc = await ResumeDocumentRepository(session).get_by_id(resume_id, user_id)
        if not doc:
            raise HTTPException(status_code=404, detail="Resume not found")
        doc.cover_letter = (body.cover_letter or "").strip() or None
        await session.commit()
    return {"cover_letter": (body.cover_letter or "").strip() or None}


@router.get("/resumes/{resume_id}/download/{file_type}")
async def download_library_document(
    resume_id: str,
    file_type: FileType,
    inline: bool = False,
    current_user: dict = Depends(get_current_user),
):
    """Render a library resume (or its cover letter) on demand."""
    from app.services.resume_design_service import generate_design_preview_docx, render_design_pdf

    user_id = _user_id(current_user)
    design, letter = await _library_doc(user_id, resume_id)
    is_letter = file_type.startswith("cover_letter")
    if is_letter and not (letter or "").strip():
        raise HTTPException(status_code=404, detail="This resume has no cover letter.")
    stem, _ = await _person_stem(user_id, "cover_letter" if is_letter else "resume")
    try:
        if file_type == "resume_pdf":
            pdf, pages = await render_design_pdf(user_id, design)
            return _pdf_response(pdf, f"{stem}.pdf", pages, inline)
        if file_type == "cover_letter_pdf":
            pdf, pages = await _render_cover_letter(user_id, design, letter or "")
            return _pdf_response(pdf, f"{stem}.pdf", pages, inline)
        if file_type == "resume_docx":
            path = await generate_design_preview_docx(user_id, design)
        else:
            path = await _cover_letter_docx(user_id, design, letter or "")
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("library_document_download_failed", user_id=user_id, file_type=file_type, error=str(e))
        raise HTTPException(status_code=503, detail="Could not build the file. Please try again.")
    return FileResponse(
        path=str(path),
        media_type=DOCX_MEDIA,
        headers={"Content-Disposition": _disposition(f"{stem}.docx"), "Cache-Control": "no-store"},
    )


# ---------------------------------------------------------------------------
# Tailor from a pasted job description
# ---------------------------------------------------------------------------


class TailorRequest(BaseModel):
    job_description: str = Field(..., min_length=40, max_length=40_000)
    instructions: str = Field(default="", max_length=2_000)


@router.post("/tailor")
async def tailor_from_job_description(body: TailorRequest, current_user: dict = Depends(get_current_user)):
    """Tailor a resume and cover letter to a pasted job description and save both
    to the library. Streams Server-Sent Events, one JSON object per ``data:`` line:
      {"stage": "analyzing"|"evidence"|"tailoring"|"saving", "label": "..."}
      {"stage": "done", "resume": <library item>, "match": {...}, "has_cover_letter": bool}
      {"stage": "error", "message": "..."}"""
    from app.services.resume_ai_chat_service import _run_pipeline
    from app.services.resume_design_service import save_ai_tailored_as_library_resume

    user_id = _user_id(current_user)

    def _sse(obj: dict) -> str:
        return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"

    async def event_stream():
        queue: asyncio.Queue = asyncio.Queue()

        async def emit(ev: dict) -> None:
            await queue.put(ev)

        async def run() -> None:
            try:
                out = await _run_pipeline(
                    user_id,
                    body.job_description,
                    want_tailor=True,
                    extra_instructions=body.instructions,
                    emit=emit,
                    free_scoring=True,
                )
                if out.get("error") == "no_profile":
                    await queue.put({
                        "stage": "error",
                        "message": "Add your experience on the Profile page first, then try again.",
                    })
                    return
                if not out.get("is_job_posting"):
                    await queue.put({
                        "stage": "error",
                        "message": "That doesn't look like a job description. Paste the full posting and try again.",
                    })
                    return
                tailored = out.get("tailored")
                if not isinstance(tailored, dict) or not tailored:
                    await queue.put({"stage": "error", "message": "The AI returned no tailored content. Please try again."})
                    return
                await queue.put({"stage": "saving", "label": "Saving to your documents"})
                letter = out.get("cover_letter") or None
                match = out.get("match") if isinstance(out.get("match"), dict) else {}
                score = match.get("overall_score", match.get("score"))
                payload = await save_ai_tailored_as_library_resume(
                    user_id,
                    content=tailored,
                    job_title=out.get("job_title"),
                    company=out.get("company"),
                    activate=False,
                    cover_letter=letter,
                    job_description=body.job_description,
                    match_score=score if isinstance(score, (int, float)) else None,
                    origin="documents",
                )
                await queue.put({
                    "stage": "done",
                    "resume": payload.get("resume"),
                    "match": {**match, "score": score} if match else None,
                    "has_cover_letter": bool((letter or "").strip()),
                })
            except Exception as e:  # noqa: BLE001 - surface a clean SSE error
                from app.core.llm_client import llm_failure_message

                logger.exception("documents_tailor_failed", user_id=user_id, error=str(e))
                await queue.put({"stage": "error", "message": llm_failure_message(e, feature="Tailoring")})
            finally:
                await queue.put(None)

        task = asyncio.create_task(run())
        try:
            while True:
                ev = await queue.get()
                if ev is None:
                    break
                yield _sse(ev)
        finally:
            if not task.done():
                task.cancel()

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )
