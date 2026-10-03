"""Orchestrates resume & cover letter document generation from stored tailored data.

Called by the resume build worker after the analysis pipeline has stored
tailored_resume_data and cover_letter_data on a ResumeBuildResult row.

Every résumé and cover letter is rendered from the user's Resume Builder design
(``ResumeDesign``); users who never opened the builder fall back to the default theme.
There is no uploaded-.docx-template path anymore.

DOCX fills run in parallel (resume + cover letter). PDFs are printed by the shared
Chromium document renderer from the same templates the Resume studio shows, so the
file matches the design exactly; dxpdf (DOCX -> PDF) is only a fallback when the
renderer is unavailable.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from sqlalchemy import select

from app.core.logging import bind_logging_context, get_logger
from app.models.database import Job
from app.storage.database import get_session
from app.storage.repository import ResumeBuildRepository
from app.storage.user_repository import UserRepository
from app.services.resume_builder_service import (
    fill_cover_letter_template,
    convert_docx_to_pdf,
    build_output_directory,
    person_document_stem,
)
from app.services.cover_letter_design_compiler import compile_cover_letter_design
from app.services.resume_blueprint_renderer import fill_user_resume_template
from app.services.resume_context_builder import build_render_context
from app.services.resume_design_compiler import compile_design
from app.services.resume_design_service import load_design_for_render
from app.api.websocket import publish_resume_event
from app.services.document_content import tailored_design
from app.services.document_renderer import (
    profile_payload,
    render_cover_letter_pdf,
    render_resume_pdf,
)

logger = get_logger(__name__)

COVER_LETTER_CONTENT_MISSING_MSG = (
    "No cover letter content was generated. Re-run job analysis or check Phase B output."
)


async def _fail_file(
    repo: ResumeBuildRepository,
    build_id: str,
    *,
    user_id: str,
    job_id: str,
    file_type: str,
    error: str,
) -> None:
    await repo.update_file_status(build_id, file_type, "failed", error=error)
    await publish_resume_event({
        "type": "resume_file_failed",
        "user_id": user_id,
        "job_id": job_id,
        "file_type": file_type,
        "error": error,
    })


def _sync_build_resume_docx(
    *,
    design: Any,
    user: Any,
    user_id: str,
    render_context: dict,
    out_path: Path,
    scratch_template: Path,
) -> Path:
    # Compile into a per-job scratch file, never the shared working_template.docx.
    # Concurrent builds for the same user previously raced on that shared path and
    # could fill one job's content into another's half-written template.
    scratch_template.parent.mkdir(parents=True, exist_ok=True)
    _tags, blueprint = compile_design(design, user, scratch_template)
    try:
        return fill_user_resume_template(
            scratch_template,
            blueprint,
            render_context,
            out_path,
        )
    finally:
        try:
            scratch_template.unlink(missing_ok=True)
        except OSError:
            pass


def _sync_build_cover_letter_docx(
    *,
    design: Any,
    user: Any,
    user_id: str,
    body: str,
    out_path: Path,
    scratch_template: Path,
) -> Path:
    scratch_template.parent.mkdir(parents=True, exist_ok=True)
    compile_cover_letter_design(design, user, scratch_template)
    try:
        return fill_cover_letter_template(scratch_template, out_path, body)
    finally:
        try:
            scratch_template.unlink(missing_ok=True)
        except OSError:
            pass


async def _mark_processing(
    repo: ResumeBuildRepository,
    build_id: str,
    *,
    user_id: str,
    job_id: str,
    file_type: str,
) -> None:
    await repo.update_file_status(build_id, file_type, "processing")
    await publish_resume_event({
        "type": "resume_file_processing",
        "user_id": user_id,
        "job_id": job_id,
        "file_type": file_type,
    })


async def _mark_completed(
    repo: ResumeBuildRepository,
    build_id: str,
    *,
    user_id: str,
    job_id: str,
    file_type: str,
    path: str,
) -> None:
    await repo.update_file_status(build_id, file_type, "completed", path=path)
    await publish_resume_event({
        "type": "resume_file_ready",
        "user_id": user_id,
        "job_id": job_id,
        "file_type": file_type,
    })


async def _mark_failed(
    repo: ResumeBuildRepository,
    build_id: str,
    *,
    user_id: str,
    job_id: str,
    file_type: str,
    error: str,
    log_event: str,
) -> None:
    logger.error(log_event, error=error)
    await repo.update_file_status(build_id, file_type, "failed", error=error)
    await publish_resume_event({
        "type": "resume_file_failed",
        "user_id": user_id,
        "job_id": job_id,
        "file_type": file_type,
        "error": error,
    })


async def run_resume_build(job_id: str, user_id: str) -> dict | None:
    """Build resume and cover letter files (DOCX + PDF), reporting per-file progress
    on the resume WebSocket channel. Documents are rendered from the user's saved
    Resume Builder design (default theme if none saved)."""
    bind_logging_context(job_id=job_id, user_id=user_id)

    try:
        async with get_session() as session:
            repo = ResumeBuildRepository(session)
            user_repo = UserRepository(session)

            build = await repo.get(job_id, user_id)
            if not build:
                logger.warning("resume_build_no_row", job_id=job_id)
                return None

            tailored = build.tailored_resume_data
            cover_data = build.cover_letter_data
            if not tailored:
                logger.warning("resume_build_no_tailored_data", job_id=job_id)
                return None

            user = await user_repo.get_by_id(user_id)
            if not user:
                logger.warning("resume_build_no_user", user_id=user_id)
                return None

            # Single source of truth for both documents: the saved builder design
            # (mirror column, self-healing from the active library resume if the mirror
            # is stale/empty), or the default theme for users who never opened the builder.
            design, _has_design = await load_design_for_render(session, user)

            first = (user.name_first or "").strip()
            last = (user.name_last or "").strip()
            resume_stem = person_document_stem(first, last, "resume")
            cover_stem = person_document_stem(first, last, "cover_letter")

            r = await session.execute(select(Job).where(Job.id == job_id))
            job = r.scalar_one_or_none()
            company = (job.company if job else None) or "Unknown"

            # Disk layout: resume_output/{Company}/{job_id}/{First_Last}_resume.pdf
            # job_id directory is mandatory so builds never overwrite each other.
            out_dir = build_output_directory(company, job_id)
            await repo.set_output_directory(build.id, str(out_dir))

            resume_docx_name = f"{resume_stem}.docx"
            resume_pdf_name = f"{resume_stem}.pdf"
            cl_docx_name = f"{cover_stem}.docx"
            cl_pdf_name = f"{cover_stem}.pdf"
            resume_scratch = out_dir / f"_scratch_{resume_stem}.docx"
            cover_scratch = out_dir / f"_scratch_{cover_stem}.docx"

            results: dict[str, str | None] = {}
            render_context = build_render_context(user, tailored, job)
            profile = profile_payload(user)
            job_design = tailored_design(design, profile, tailored)
            display_name = " ".join(p for p in (first, last) if p) or "Resume"
            build_id = build.id
            has_cover_body = bool(cover_data and cover_data.get("body"))

            # --- Parallel DOCX fills (independent template dirs) ---
            await _mark_processing(
                repo, build_id, user_id=user_id, job_id=job_id, file_type="resume_docx",
            )
            if has_cover_body:
                await _mark_processing(
                    repo, build_id, user_id=user_id, job_id=job_id, file_type="cover_letter_docx",
                )
            else:
                logger.warning("cover_letter_build_no_content", user_id=user_id, job_id=job_id)
                for ft in ("cover_letter_docx", "cover_letter_pdf"):
                    await _fail_file(
                        repo,
                        build_id,
                        user_id=user_id,
                        job_id=job_id,
                        file_type=ft,
                        error=COVER_LETTER_CONTENT_MISSING_MSG,
                    )

            cover_body = cover_data["body"] if has_cover_body else ""

            async def _resume_docx_task() -> tuple[str, Path | None, str | None]:
                try:
                    path = await asyncio.to_thread(
                        _sync_build_resume_docx,
                        design=design,
                        user=user,
                        user_id=user_id,
                        render_context=render_context,
                        out_path=out_dir / resume_docx_name,
                        scratch_template=resume_scratch,
                    )
                    return ("resume_docx", path, None)
                except Exception as e:
                    return ("resume_docx", None, str(e))

            async def _cover_docx_task() -> tuple[str, Path | None, str | None]:
                try:
                    path = await asyncio.to_thread(
                        _sync_build_cover_letter_docx,
                        design=design,
                        user=user,
                        user_id=user_id,
                        body=cover_body,
                        out_path=out_dir / cl_docx_name,
                        scratch_template=cover_scratch,
                    )
                    return ("cover_letter_docx", path, None)
                except Exception as e:
                    return ("cover_letter_docx", None, str(e))

            docx_tasks = [_resume_docx_task()]
            if has_cover_body:
                docx_tasks.append(_cover_docx_task())

            for file_type, path, err in await asyncio.gather(*docx_tasks):
                if path is not None:
                    results[file_type] = str(path)
                    await _mark_completed(
                        repo,
                        build_id,
                        user_id=user_id,
                        job_id=job_id,
                        file_type=file_type,
                        path=str(path),
                    )
                else:
                    await _mark_failed(
                        repo,
                        build_id,
                        user_id=user_id,
                        job_id=job_id,
                        file_type=file_type,
                        error=err or "unknown error",
                        log_event=f"{file_type}_build_failed",
                    )

            # --- PDFs: Chromium print of the studio templates (dxpdf fallback) ---
            pdf_jobs: list[tuple[str, Path, Path]] = []
            if results.get("resume_docx"):
                await _mark_processing(
                    repo, build_id, user_id=user_id, job_id=job_id, file_type="resume_pdf",
                )
                pdf_jobs.append((
                    "resume_pdf",
                    Path(results["resume_docx"]),
                    out_dir / resume_pdf_name,
                ))
            if results.get("cover_letter_docx"):
                await _mark_processing(
                    repo, build_id, user_id=user_id, job_id=job_id, file_type="cover_letter_pdf",
                )
                pdf_jobs.append((
                    "cover_letter_pdf",
                    Path(results["cover_letter_docx"]),
                    out_dir / cl_pdf_name,
                ))

            if pdf_jobs:
                async def _pdf_task(
                    file_type: str, docx_path: Path, pdf_path: Path,
                ) -> tuple[str, Path | None, str | None]:
                    try:
                        if file_type == "resume_pdf":
                            rendered = await render_resume_pdf(
                                job_design, profile, title=f"{display_name} - Resume",
                            )
                        else:
                            rendered = await render_cover_letter_pdf(
                                design, profile, cover_body, title=f"{display_name} - Cover Letter",
                            )
                        pdf_path.parent.mkdir(parents=True, exist_ok=True)
                        pdf_path.write_bytes(rendered.pdf)
                        return (file_type, pdf_path, None)
                    except Exception as render_err:  # noqa: BLE001 - fall back to dxpdf
                        logger.warning(
                            "document_render_fallback_dxpdf", file_type=file_type, error=str(render_err),
                        )
                    try:
                        out = await asyncio.to_thread(convert_docx_to_pdf, docx_path, pdf_path)
                        return (file_type, out, None)
                    except Exception as e:
                        return (file_type, None, str(e))

                for file_type, path, err in await asyncio.gather(
                    *[_pdf_task(ft, src, dst) for ft, src, dst in pdf_jobs]
                ):
                    if path is not None:
                        results[file_type] = str(path)
                        await _mark_completed(
                            repo,
                            build_id,
                            user_id=user_id,
                            job_id=job_id,
                            file_type=file_type,
                            path=str(path),
                        )
                    else:
                        log_event = (
                            "resume_pdf_conversion_failed"
                            if file_type == "resume_pdf"
                            else "cover_letter_pdf_conversion_failed"
                        )
                        await _mark_failed(
                            repo,
                            build_id,
                            user_id=user_id,
                            job_id=job_id,
                            file_type=file_type,
                            error=err or "unknown error",
                            log_event=log_event,
                        )

            await session.commit()
            logger.info("resume_build_completed", job_id=job_id, files=list(results.keys()))
            return results if results else None

    except Exception as e:
        logger.exception("resume_build_failed", job_id=job_id, error=str(e))
        await publish_resume_event({
            "type": "resume_build_failed",
            "user_id": user_id,
            "job_id": job_id,
            "error": str(e),
        })
        return None
