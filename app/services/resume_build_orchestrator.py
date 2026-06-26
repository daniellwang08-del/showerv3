"""

Orchestrates resume & cover letter document generation from stored tailored data.



Called by the resume build worker after the analysis pipeline has stored

tailored_resume_data and cover_letter_data on a ResumeBuildResult row.

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

from app.services.cover_letter_template_service import (

    resolve_cover_letter_template_path,

    user_cover_letter_template_ready_for_build,

)

from app.services.resume_blueprint_renderer import fill_user_resume_template

from app.services.resume_context_builder import build_render_context

from app.services.resume_template_service import user_template_ready_for_build

from app.api.websocket import publish_resume_event



logger = get_logger(__name__)



RESUME_TEMPLATE_NOT_READY_MSG = (

    "Upload and analyze your résumé template in Settings before generating resume documents."

)

COVER_LETTER_TEMPLATE_NOT_READY_MSG = (

    "Upload and validate your cover letter template in Settings before generating cover letter documents."

)

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

    """

    Build resume and cover letter files (DOCX + PDF) and report

    per-file progress via the resume WebSocket channel.



    Resume and cover letter templates are gated independently - each requires

    the user's own uploaded template, like the résumé builder flow.

    """

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



            resume_template_ready = user_template_ready_for_build(user)

            cover_letter_template_ready = user_cover_letter_template_ready_for_build(user)

            working_path = getattr(user, "resume_template_working_path", None)

            blueprint = getattr(user, "resume_template_blueprint", None)



            first = (user.name_first or "").strip()

            last = (user.name_last or "").strip()

            person_name = f"{first} {last}".strip() or "Resume"



            r = await session.execute(select(Job).where(Job.id == job_id))

            job = r.scalar_one_or_none()

            company = (job.company if job else None) or "Unknown"

            position = (job.title if job else None) or "Unknown"



            out_dir = build_output_directory(first, last, company, position)

            await repo.set_output_directory(build.id, str(out_dir))



            cl_template = resolve_cover_letter_template_path(user)



            resume_docx_name = f"{person_name} Resume.docx"

            resume_pdf_name = f"{person_name} Resume.pdf"

            cl_docx_name = f"{person_name} Cover Letter.docx"

            cl_pdf_name = f"{person_name} Cover Letter.pdf"



            results: dict[str, str | None] = {}

            render_context = build_render_context(user, tailored, job)



            # --- Resume DOCX ---

            if not resume_template_ready:

                logger.warning("resume_build_template_not_ready", user_id=user_id, job_id=job_id)

                for ft in ("resume_docx", "resume_pdf"):

                    await _fail_file(

                        repo,

                        build.id,

                        user_id=user_id,

                        job_id=job_id,

                        file_type=ft,

                        error=RESUME_TEMPLATE_NOT_READY_MSG,

                    )

            else:

                try:

                    await repo.update_file_status(build.id, "resume_docx", "processing")

                    await publish_resume_event({

                        "type": "resume_file_processing",

                        "user_id": user_id,

                        "job_id": job_id,

                        "file_type": "resume_docx",

                    })



                    resume_template = Path(working_path)  # type: ignore[arg-type]

                    if not resume_template.exists():

                        raise RuntimeError("User resume template file is missing on disk.")



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

            if not cover_letter_template_ready or not cl_template or not cl_template.exists():

                logger.warning(

                    "cover_letter_build_template_not_ready",

                    user_id=user_id,

                    job_id=job_id,

                )

                for ft in ("cover_letter_docx", "cover_letter_pdf"):

                    await _fail_file(

                        repo,

                        build.id,

                        user_id=user_id,

                        job_id=job_id,

                        file_type=ft,

                        error=COVER_LETTER_TEMPLATE_NOT_READY_MSG,

                    )

            elif not cover_data or not cover_data.get("body"):

                logger.warning(

                    "cover_letter_build_no_content",

                    user_id=user_id,

                    job_id=job_id,

                )

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


