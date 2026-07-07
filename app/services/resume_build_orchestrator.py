"""Orchestrates resume & cover letter document generation from stored tailored data.

Called by the resume build worker after the analysis pipeline has stored
tailored_resume_data and cover_letter_data on a ResumeBuildResult row.

Every résumé and cover letter is rendered from the user's Resume Builder design
(``ResumeDesign``); users who never opened the builder fall back to the default theme.
There is no uploaded-.docx-template path anymore.
"""

from pathlib import Path

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
)
from app.services.cover_letter_design_compiler import compile_cover_letter_design
from app.services.cover_letter_template_service import user_cover_letter_template_dir
from app.services.resume_blueprint_renderer import fill_user_resume_template
from app.services.resume_context_builder import build_render_context
from app.services.resume_design_compiler import compile_design
from app.services.resume_design_service import load_design_for_render
from app.services.resume_template_service import user_template_dir
from app.api.websocket import publish_resume_event

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
            person_name = f"{first} {last}".strip() or "Resume"

            r = await session.execute(select(Job).where(Job.id == job_id))
            job = r.scalar_one_or_none()
            company = (job.company if job else None) or "Unknown"
            position = (job.title if job else None) or "Unknown"

            out_dir = build_output_directory(first, last, company, position)
            await repo.set_output_directory(build.id, str(out_dir))

            resume_docx_name = f"{person_name} Resume.docx"
            resume_pdf_name = f"{person_name} Resume.pdf"
            cl_docx_name = f"{person_name} Cover Letter.docx"
            cl_pdf_name = f"{person_name} Cover Letter.pdf"

            results: dict[str, str | None] = {}
            render_context = build_render_context(user, tailored, job)

            # --- Resume DOCX ---
            try:
                await repo.update_file_status(build.id, "resume_docx", "processing")
                await publish_resume_event({
                    "type": "resume_file_processing",
                    "user_id": user_id,
                    "job_id": job_id,
                    "file_type": "resume_docx",
                })

                # Compile the working template from the design on every build so the
                # rendered résumé always reflects the current design AND compiler logic.
                resume_template = user_template_dir(user_id) / "working_template.docx"
                _tags, blueprint = compile_design(design, user, resume_template)

                docx_path = fill_user_resume_template(
                    resume_template,
                    blueprint,
                    render_context,
                    out_dir / resume_docx_name,
                )
                await repo.update_file_status(build.id, "resume_docx", "completed", path=str(docx_path))
                results["resume_docx"] = str(docx_path)
                await publish_resume_event({
                    "type": "resume_file_ready",
                    "user_id": user_id,
                    "job_id": job_id,
                    "file_type": "resume_docx",
                })
            except Exception as e:
                logger.error("resume_docx_build_failed", error=str(e))
                await repo.update_file_status(build.id, "resume_docx", "failed", error=str(e))
                await publish_resume_event({
                    "type": "resume_file_failed",
                    "user_id": user_id,
                    "job_id": job_id,
                    "file_type": "resume_docx",
                    "error": str(e),
                })

            # --- Resume PDF ---
            if results.get("resume_docx"):
                try:
                    await repo.update_file_status(build.id, "resume_pdf", "processing")
                    await publish_resume_event({
                        "type": "resume_file_processing",
                        "user_id": user_id,
                        "job_id": job_id,
                        "file_type": "resume_pdf",
                    })

                    pdf_path = convert_docx_to_pdf(Path(results["resume_docx"]), out_dir / resume_pdf_name)
                    await repo.update_file_status(build.id, "resume_pdf", "completed", path=str(pdf_path))
                    results["resume_pdf"] = str(pdf_path)
                    await publish_resume_event({
                        "type": "resume_file_ready",
                        "user_id": user_id,
                        "job_id": job_id,
                        "file_type": "resume_pdf",
                    })
                except Exception as e:
                    logger.error("resume_pdf_conversion_failed", error=str(e))
                    await repo.update_file_status(build.id, "resume_pdf", "failed", error=str(e))
                    await publish_resume_event({
                        "type": "resume_file_failed",
                        "user_id": user_id,
                        "job_id": job_id,
                        "file_type": "resume_pdf",
                        "error": str(e),
                    })

            # --- Cover Letter DOCX ---
            if not cover_data or not cover_data.get("body"):
                logger.warning("cover_letter_build_no_content", user_id=user_id, job_id=job_id)
                for ft in ("cover_letter_docx", "cover_letter_pdf"):
                    await _fail_file(
                        repo,
                        build.id,
                        user_id=user_id,
                        job_id=job_id,
                        file_type=ft,
                        error=COVER_LETTER_CONTENT_MISSING_MSG,
                    )
            else:
                try:
                    await repo.update_file_status(build.id, "cover_letter_docx", "processing")
                    await publish_resume_event({
                        "type": "resume_file_processing",
                        "user_id": user_id,
                        "job_id": job_id,
                        "file_type": "cover_letter_docx",
                    })

                    # Compile the cover letter template from the same design on every build.
                    cl_template = user_cover_letter_template_dir(user_id) / "working.docx"
                    compile_cover_letter_design(design, user, cl_template)

                    cl_docx = fill_cover_letter_template(
                        cl_template,
                        out_dir / cl_docx_name,
                        cover_data["body"],
                    )
                    await repo.update_file_status(build.id, "cover_letter_docx", "completed", path=str(cl_docx))
                    results["cover_letter_docx"] = str(cl_docx)
                    await publish_resume_event({
                        "type": "resume_file_ready",
                        "user_id": user_id,
                        "job_id": job_id,
                        "file_type": "cover_letter_docx",
                    })
                except Exception as e:
                    logger.error("cover_letter_docx_build_failed", error=str(e))
                    await repo.update_file_status(build.id, "cover_letter_docx", "failed", error=str(e))
                    await publish_resume_event({
                        "type": "resume_file_failed",
                        "user_id": user_id,
                        "job_id": job_id,
                        "file_type": "cover_letter_docx",
                        "error": str(e),
                    })

                if results.get("cover_letter_docx"):
                    try:
                        await repo.update_file_status(build.id, "cover_letter_pdf", "processing")
                        await publish_resume_event({
                            "type": "resume_file_processing",
                            "user_id": user_id,
                            "job_id": job_id,
                            "file_type": "cover_letter_pdf",
                        })

                        cl_pdf = convert_docx_to_pdf(Path(results["cover_letter_docx"]), out_dir / cl_pdf_name)
                        await repo.update_file_status(build.id, "cover_letter_pdf", "completed", path=str(cl_pdf))
                        results["cover_letter_pdf"] = str(cl_pdf)
                        await publish_resume_event({
                            "type": "resume_file_ready",
                            "user_id": user_id,
                            "job_id": job_id,
                            "file_type": "cover_letter_pdf",
                        })
                    except Exception as e:
                        logger.error("cover_letter_pdf_conversion_failed", error=str(e))
                        await repo.update_file_status(build.id, "cover_letter_pdf", "failed", error=str(e))
                        await publish_resume_event({
                            "type": "resume_file_failed",
                            "user_id": user_id,
                            "job_id": job_id,
                            "file_type": "cover_letter_pdf",
                            "error": str(e),
                        })

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
