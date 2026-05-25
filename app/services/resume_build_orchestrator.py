"""
Orchestrates resume & cover letter document generation from stored tailored data.

Called by the resume build worker after the analysis pipeline has stored
tailored_resume_data and cover_letter_data on a ResumeBuildResult row.
"""

from pathlib import Path

from app.core.config import get_settings
from app.core.logging import bind_logging_context, get_logger
from app.storage.database import get_session
from app.storage.repository import ResumeBuildRepository
from app.storage.user_repository import UserRepository
from app.services.resume_builder_service import (
    fill_resume_template,
    fill_cover_letter_template,
    convert_docx_to_pdf,
    build_output_directory,
)
from app.api.websocket import publish_resume_event

logger = get_logger(__name__)

FILE_TYPES = ("resume_docx", "resume_pdf", "cover_letter_docx", "cover_letter_pdf")


async def run_resume_build(job_id: str, user_id: str) -> dict | None:
    """
    Build all four resume/cover letter files (DOCX + PDF) and report
    per-file progress via the resume WebSocket channel.

    Returns a summary dict on success or None on failure.
    """
    bind_logging_context(job_id=job_id, user_id=user_id)
    settings = get_settings()

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

            first = (user.name_first or "").strip()
            last = (user.name_last or "").strip()
            person_name = f"{first} {last}".strip() or "Resume"

            from sqlalchemy import select
            from app.models.database import Job
            r = await session.execute(select(Job).where(Job.id == job_id))
            job = r.scalar_one_or_none()
            company = (job.company if job else None) or "Unknown"
            position = (job.title if job else None) or "Unknown"

            out_dir = build_output_directory(first, last, company, position)
            await repo.set_output_directory(build.id, str(out_dir))

            resume_template = Path(settings.resume_template_path)
            cl_template = Path(settings.cover_letter_template_path)

            resume_docx_name = f"{person_name} Resume.docx"
            resume_pdf_name = f"{person_name} Resume.pdf"
            cl_docx_name = f"{person_name} Cover Letter.docx"
            cl_pdf_name = f"{person_name} Cover Letter.pdf"

            results: dict[str, str | None] = {}

            # --- Resume DOCX ---
            try:
                await repo.update_file_status(build.id, "resume_docx", "processing")
                await publish_resume_event({"type": "resume_file_processing", "user_id": user_id, "job_id": job_id, "file_type": "resume_docx"})

                docx_path = fill_resume_template(resume_template, out_dir / resume_docx_name, tailored)
                await repo.update_file_status(build.id, "resume_docx", "completed", path=str(docx_path))
                results["resume_docx"] = str(docx_path)
                await publish_resume_event({"type": "resume_file_ready", "user_id": user_id, "job_id": job_id, "file_type": "resume_docx"})
            except Exception as e:
                logger.error("resume_docx_build_failed", error=str(e))
                await repo.update_file_status(build.id, "resume_docx", "failed", error=str(e))
                await publish_resume_event({"type": "resume_file_failed", "user_id": user_id, "job_id": job_id, "file_type": "resume_docx", "error": str(e)})

            # --- Resume PDF ---
            if results.get("resume_docx"):
                try:
                    await repo.update_file_status(build.id, "resume_pdf", "processing")
                    await publish_resume_event({"type": "resume_file_processing", "user_id": user_id, "job_id": job_id, "file_type": "resume_pdf"})

                    pdf_path = convert_docx_to_pdf(Path(results["resume_docx"]), out_dir / resume_pdf_name)
                    await repo.update_file_status(build.id, "resume_pdf", "completed", path=str(pdf_path))
                    results["resume_pdf"] = str(pdf_path)
                    await publish_resume_event({"type": "resume_file_ready", "user_id": user_id, "job_id": job_id, "file_type": "resume_pdf"})
                except Exception as e:
                    logger.error("resume_pdf_conversion_failed", error=str(e))
                    await repo.update_file_status(build.id, "resume_pdf", "failed", error=str(e))
                    await publish_resume_event({"type": "resume_file_failed", "user_id": user_id, "job_id": job_id, "file_type": "resume_pdf", "error": str(e)})

            # --- Cover Letter DOCX ---
            if cover_data and cover_data.get("body") and cl_template.exists():
                try:
                    await repo.update_file_status(build.id, "cover_letter_docx", "processing")
                    await publish_resume_event({"type": "resume_file_processing", "user_id": user_id, "job_id": job_id, "file_type": "cover_letter_docx"})

                    cl_docx = fill_cover_letter_template(cl_template, out_dir / cl_docx_name, cover_data["body"])
                    await repo.update_file_status(build.id, "cover_letter_docx", "completed", path=str(cl_docx))
                    results["cover_letter_docx"] = str(cl_docx)
                    await publish_resume_event({"type": "resume_file_ready", "user_id": user_id, "job_id": job_id, "file_type": "cover_letter_docx"})
                except Exception as e:
                    logger.error("cover_letter_docx_build_failed", error=str(e))
                    await repo.update_file_status(build.id, "cover_letter_docx", "failed", error=str(e))
                    await publish_resume_event({"type": "resume_file_failed", "user_id": user_id, "job_id": job_id, "file_type": "cover_letter_docx", "error": str(e)})

                # --- Cover Letter PDF ---
                if results.get("cover_letter_docx"):
                    try:
                        await repo.update_file_status(build.id, "cover_letter_pdf", "processing")
                        await publish_resume_event({"type": "resume_file_processing", "user_id": user_id, "job_id": job_id, "file_type": "cover_letter_pdf"})

                        cl_pdf = convert_docx_to_pdf(Path(results["cover_letter_docx"]), out_dir / cl_pdf_name)
                        await repo.update_file_status(build.id, "cover_letter_pdf", "completed", path=str(cl_pdf))
                        results["cover_letter_pdf"] = str(cl_pdf)
                        await publish_resume_event({"type": "resume_file_ready", "user_id": user_id, "job_id": job_id, "file_type": "cover_letter_pdf"})
                    except Exception as e:
                        logger.error("cover_letter_pdf_conversion_failed", error=str(e))
                        await repo.update_file_status(build.id, "cover_letter_pdf", "failed", error=str(e))
                        await publish_resume_event({"type": "resume_file_failed", "user_id": user_id, "job_id": job_id, "file_type": "cover_letter_pdf", "error": str(e)})
            else:
                for ft in ("cover_letter_docx", "cover_letter_pdf"):
                    await repo.update_file_status(build.id, ft, "failed", error="No cover letter data or template")

            logger.info("resume_build_completed", job_id=job_id, files=list(results.keys()))
            return results

    except Exception as e:
        logger.exception("resume_build_failed", job_id=job_id, error=str(e))
        await publish_resume_event({
            "type": "resume_build_failed",
            "user_id": user_id,
            "job_id": job_id,
            "error": str(e),
        })
        return None
