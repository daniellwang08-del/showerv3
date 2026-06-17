from fastapi import APIRouter, HTTPException, Depends, BackgroundTasks, Request, Response, status, Cookie, File, UploadFile, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from app.services.auth_service import AuthService
from app.models.schemas import (
    ExtractionRequest,
    ExtractionResponse,
    BatchExtractionRequest,
    BatchExtractionResponse,
    HealthResponse,
    ExtractionStatus,
    JobDescriptionSchema,
    JobSubmissionRequest,
    JobResponse,
    JobIdsBatchRequest,
    AiJobSearchRequest,
    AiJobSearchResponse,
    DuplicatedJobResponse,
    JobSubmissionResponse,
    AttachmentExtractUrlsResponse,
    JobMatchResponse,
    JobAnalysisResponse,
    JobPromotionInfo,
    ResumeBuildStatusResponse,
    DashboardJobResponse,
    DashboardJobsPage,
)
from app.models.auth_schemas import SignupRequest, LoginRequest, AuthResponse, UserResponse, ProfileUpdateRequest
from app.models.profile_schemas import ProfileResponse, ProfileCreateRequest, ResumeParseResponse
from app.models.profile_source_schemas import (
    ProfileSourceDocumentListResponse,
    ProfileSourceDocumentResponse,
    ProfileSourceDocumentUpdateRequest,
    ProfileSourceDocumentUploadResponse,
)
from app.models.resume_template_schemas import ResumeTemplateBlueprintUpdateRequest
from app.storage.database import get_session, check_database_connection
from app.storage.repository import (
    JobExtractionRepository,
    JobMatchRepository,
    JobMatchInProgressRepository,
    JobRepository,
    ValidJobUserApplicationRepository,
    ResumeBuildRepository,
    UserJobStatusRepository,
)
from app.storage.user_repository import UserRepository, _profile_display_name, user_applied_by_display_name
from app.services.url_manager import URLManager
from app.api.websocket import publish_ws_event
from app.extractors.browser_extractor import get_browser_pool_safe
from app.core.config import get_settings
from app.core.logging import bind_logging_context, get_logger
from openai import APIError as OpenAIAPIError
from app.core.exceptions import AIParsingError
from app.services.job_ai_search_service import apply_job_search_spec, interpret_job_search_prompt
from app.services.resume_parse_service import parse_resume_bytes
from app.models.database import (
    Job,
    UserJobStatus,
    JobExtraction,
    JobMatchResult,
    JobMatchInProgress,
    ValidJobUserApplication,
    ResumeBuildResult,
)
from sqlalchemy import delete as sa_delete, select, func, update as sa_update, nullslast, text
from sqlalchemy.exc import IntegrityError
import asyncio
from datetime import datetime, timedelta, timezone
from app.utils.text_sanitizer import sanitize_for_postgres_text
from app.services.attachment_text_extract import combine_file_texts, extract_text_from_bytes
from app.services.attachment_job_url_ai import extract_job_urls_from_text_combined
from app.services.job_field_utils import resolve_job_display_title
from app.storage.repository import _utcnow

router = APIRouter()
logger = get_logger(__name__)

BLOCKED_DOMAINS: dict[str, str] = {
    "paycomonline.net": "Paycom ATS requires lengthy manual registration; auto-extraction not supported.",
}


def _check_domain_blocked(domain: str) -> str | None:
    """Return block reason if the domain (or its parent) is in the blocklist, else None."""
    lowered = domain.lower()
    for blocked, reason in BLOCKED_DOMAINS.items():
        if lowered == blocked or lowered.endswith(f".{blocked}"):
            return reason
    return None


class JobUrlUpdateRequest(BaseModel):
    url: str = Field(..., min_length=1, max_length=2048)


class JobReportRequest(BaseModel):
    duplication_reason: str | None = Field(default=None, max_length=500)
    duplicate_of_job_id: str | None = Field(default=None, max_length=36)


class PromoteInvalidRequest(BaseModel):
    reason: str = Field(..., min_length=1, max_length=500)


class DuplicatedJobStatusBatchRequest(BaseModel):
    user_job_status_ids: list[str] = Field(default_factory=list, max_length=500)


class DismissDuplicatesBatchRequest(BaseModel):
    """IDs of duplicate-list entries to hide for this user (no data is deleted)."""
    user_job_status_ids: list[str] = Field(..., min_length=1, max_length=2000)


async def _purge_job_cascade(session, job_id: str) -> bool:
    """
    Delete a job row and related match/progress/application/user_job_status rows.
    Remove JobExtraction when no other job references it.
    Returns False if the job row was not found.
    """
    result = await session.execute(select(Job).where(Job.id == job_id))
    job = result.scalar_one_or_none()
    if not job:
        return False

    extraction_id = job.extraction_id

    await session.execute(sa_delete(JobMatchResult).where(JobMatchResult.job_id == job_id))
    await session.execute(sa_delete(JobMatchInProgress).where(JobMatchInProgress.job_id == job_id))
    await session.execute(sa_delete(ValidJobUserApplication).where(ValidJobUserApplication.job_id == job_id))
    await session.execute(sa_delete(UserJobStatus).where(UserJobStatus.job_id == job_id))
    await session.execute(sa_delete(ResumeBuildResult).where(ResumeBuildResult.job_id == job_id))

    await session.delete(job)

    if extraction_id:
        other_ref = await session.execute(
            select(Job.id).where(
                Job.extraction_id == extraction_id,
                Job.id != job_id,
            ).limit(1)
        )
        if other_ref.scalar_one_or_none() is None:
            await session.execute(sa_delete(JobExtraction).where(JobExtraction.id == extraction_id))
    return True


async def get_current_user(request: Request):
    token = request.cookies.get("access_token")
    if not token:
        logger.warning("auth_required_missing_token")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    payload = AuthService.verify_token(token)
    if not payload:
        logger.warning("auth_required_invalid_token")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    uid = payload.get("user_id")
    if uid is not None and str(uid).strip():
        normalized_uid = str(uid).strip()
        bind_logging_context(user_id=normalized_uid, user_email=payload.get("sub"))
        return {**payload, "user_id": normalized_uid}
    sub = payload.get("sub")
    if isinstance(sub, str) and sub.strip():
        async with get_session() as session:
            user_repo = UserRepository(session)
            user = await user_repo.get_by_email(sub.lower().strip())
            if user:
                bind_logging_context(user_id=user.id, user_email=user.email)
                return {**payload, "user_id": user.id}
    bind_logging_context(user_email=payload.get("sub"))
    return payload


@router.post("/auth/signup", response_model=AuthResponse)
async def signup(request: SignupRequest, response: Response) -> AuthResponse:
    """Register a new user with email and password"""
    settings = get_settings()
    normalized_email = request.email.lower().strip()
    
    async with get_session() as session:
        user_repo = UserRepository(session)
        
        # Check if user already exists
        existing_user = await user_repo.get_by_email(normalized_email)
        if existing_user:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Email already registered"
            )
        
        try:
            # Create new user
            user = await user_repo.create(normalized_email, request.password)
            await session.commit()
            
            # Create access token
            access_token = AuthService.create_access_token(data={"sub": user.email, "user_id": user.id})
            response.set_cookie(
                key="access_token",
                value=access_token,
                httponly=True,
                max_age=86400,
                samesite="lax",
                secure=settings.app_env == "production",
            )
            
            logger.info("user_signup_success", email=user.email, user_id=user.id)
            
            return AuthResponse(
                success=True,
                message="Account created successfully",
                email=user.email,
                user_id=user.id
            )
        except IntegrityError:
            await session.rollback()
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Email already registered"
            )
        except Exception as e:
            await session.rollback()
            logger.error("signup_failed", error=str(e))
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create account"
            )


@router.post("/auth/login", response_model=AuthResponse)
async def login(request: LoginRequest, response: Response) -> AuthResponse:
    """Login with email and password"""
    settings = get_settings()
    normalized_email = request.email.lower().strip()
    
    async with get_session() as session:
        user_repo = UserRepository(session)
        
        # Verify credentials
        user = await user_repo.verify_credentials(normalized_email, request.password)
        if not user:
            logger.warning("user_login_failed", email=normalized_email, reason="invalid_credentials")
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid email or password"
            )
        
        # Create access token
        access_token = AuthService.create_access_token(data={"sub": user.email, "user_id": user.id})
        response.set_cookie(
            key="access_token",
            value=access_token,
            httponly=True,
            max_age=86400,
            samesite="lax",
            secure=settings.app_env == "production",
        )
        
        logger.info("user_login_success", email=user.email, user_id=user.id)
        
        return AuthResponse(
            success=True,
            message="Logged in successfully",
            email=user.email,
            user_id=user.id
        )


@router.post("/auth/logout")
async def logout(response: Response):
    response.delete_cookie(key="access_token")
    logger.info("user_logout")
    return {"message": "Logged out successfully"}


@router.get("/auth/me", response_model=UserResponse)
async def read_users_me(current_user: dict = Depends(get_current_user)) -> UserResponse:
    """Get current user profile"""
    user_id = current_user.get("user_id")
    email = current_user.get("sub")
    
    async with get_session() as session:
        user_repo = UserRepository(session)
        user = await user_repo.get_by_id(user_id)
        
        if not user:
            logger.warning("auth_me_user_not_found", user_id=user_id)
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )
        
        logger.debug("auth_me_success", user_id=user_id)
        return UserResponse(
            id=user.id,
            email=user.email,
            name=getattr(user, "name", None),
            display_name=user_applied_by_display_name(user),
            is_active=user.is_active,
            created_at=user.created_at,
        )


@router.patch("/auth/profile", response_model=UserResponse)
async def update_profile(
    request: ProfileUpdateRequest,
    current_user: dict = Depends(get_current_user),
) -> UserResponse:
    """Update current user profile (e.g. display name)"""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    async with get_session() as session:
        user_repo = UserRepository(session)
        user = await user_repo.get_by_id(user_id)
        if not user:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

        name_value = request.name.strip() if request.name and request.name.strip() else None
        await user_repo.update_user(user_id, name=name_value)
        await session.commit()

        user = await user_repo.get_by_id(user_id)
        return UserResponse(
            id=user.id,
            email=user.email,
            name=getattr(user, "name", None),
            display_name=user_applied_by_display_name(user),
            is_active=user.is_active,
            created_at=user.created_at,
        )


# ---- User profile (single profile per account) ----

def _user_to_profile_response(u) -> ProfileResponse:
    name = _profile_display_name(getattr(u, "name_first", None), getattr(u, "name_middle", None), getattr(u, "name_last", None))
    return ProfileResponse(
        user_id=u.id,
        name=name or getattr(u, "name", None) or "",
        name_first=getattr(u, "name_first", None),
        name_middle=getattr(u, "name_middle", None),
        name_last=getattr(u, "name_last", None),
        title=getattr(u, "profile_title", None),
        email=getattr(u, "profile_email", None),
        phone_country_code=getattr(u, "phone_country_code", None),
        phone_number=getattr(u, "phone_number", None),
        linkedin_url=getattr(u, "linkedin_url", None),
        github_url=getattr(u, "github_url", None),
        profile_summary=getattr(u, "profile_summary", None),
        technical_skills=getattr(u, "technical_skills", None) or [],
        work_experience=getattr(u, "work_experience", None) or [],
        education=getattr(u, "education", None) or [],
        certificates=getattr(u, "certificates", None) or [],
        extra=getattr(u, "extra", None) or [],
        created_at=u.created_at,
        updated_at=u.updated_at,
    )


def _request_to_profile_data(req) -> dict:
    return {
        "name_first": req.name_first,
        "name_middle": req.name_middle,
        "name_last": req.name_last,
        "title": req.title,
        "email": req.email,
        "phone_country_code": req.phone_country_code,
        "phone_number": req.phone_number,
        "linkedin_url": req.linkedin_url,
        "github_url": req.github_url,
        "profile_summary": req.profile_summary,
        "technical_skills": [b.model_dump() for b in req.technical_skills],
        "work_experience": [b.model_dump() for b in req.work_experience],
        "education": [b.model_dump() for b in req.education],
        "certificates": [b.model_dump() for b in req.certificates],
        "extra": list(req.extra),
    }


@router.get("/profile", response_model=ProfileResponse)
async def get_profile(current_user: dict = Depends(get_current_user)) -> ProfileResponse:
    """Get current user's profile."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    async with get_session() as session:
        repo = UserRepository(session)
        user = await repo.get_by_id(user_id)
        if not user:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
        return _user_to_profile_response(user)


@router.put("/profile", response_model=ProfileResponse)
async def put_profile(
    request: ProfileCreateRequest,
    current_user: dict = Depends(get_current_user),
) -> ProfileResponse:
    """Create or update current user's profile."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    async with get_session() as session:
        repo = UserRepository(session)
        user, should_reanalyze = await repo.update_profile(user_id, _request_to_profile_data(request))
        if not user:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
        await session.commit()

    if should_reanalyze:
        from app.services.resume_template_service import schedule_template_analysis

        await schedule_template_analysis(user_id, reason="profile_work_count_changed")

    async with get_session() as session:
        repo = UserRepository(session)
        user = await repo.get_by_id(user_id)
        if not user:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
        return _user_to_profile_response(user)


@router.post("/profile/resume-parse", response_model=ResumeParseResponse, dependencies=[Depends(get_current_user)])
async def resume_parse(
    file: UploadFile = File(...),
    current_user: dict = Depends(get_current_user),
) -> ResumeParseResponse:
    """Parse a résumé PDF (vision) or DOCX (text) into structured profile draft fields."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Empty file")
    try:
        result = await parse_resume_bytes(raw=raw, filename=file.filename or "", user_id=user_id)
        logger.info("resume_parse_ok", user_id=user_id, source_kind=result.source_kind)
        return result
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except AIParsingError as e:
        logger.warning("resume_parse_ai_failed", error=str(e))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(e) or "Résumé parsing failed. Check OPENAI_API_KEY and model access.",
        )
    except OpenAIAPIError as e:
        logger.warning("resume_parse_openai_error", error=str(e))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Résumé parsing is temporarily unavailable. Please try again later.",
        )
    except ModuleNotFoundError as e:
        logger.exception("resume_parse_missing_dependency", error=str(e))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Server dependency missing ({e}). Run: pip install -r requirements.txt",
        )
    except Exception as e:
        logger.exception("resume_parse_failed", error=str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Résumé parsing failed. See server logs for details.",
        )


@router.get("/profile/openai-text")
async def get_profile_openai_text(current_user: dict = Depends(get_current_user)) -> dict:
    """Get cached OpenAI-ready profile text for use in OpenAI API calls."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    async with get_session() as session:
        repo = UserRepository(session)
        text = await repo.get_profile_openai_text(user_id)
        return {"profile_openai_text": text}


@router.get(
    "/profile/source-documents",
    response_model=ProfileSourceDocumentListResponse,
    dependencies=[Depends(get_current_user)],
)
async def list_profile_source_documents(
    current_user: dict = Depends(get_current_user),
) -> ProfileSourceDocumentListResponse:
    """List uploaded project source documents for resume tailoring."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    from app.services.profile_source_document_service import list_source_documents

    documents = await list_source_documents(user_id)
    return ProfileSourceDocumentListResponse(documents=documents)


@router.post(
    "/profile/source-documents",
    response_model=ProfileSourceDocumentUploadResponse,
    dependencies=[Depends(get_current_user)],
)
async def upload_profile_source_document(
    file: UploadFile = File(...),
    company_name: str | None = Query(default=None, max_length=200),
    current_user: dict = Depends(get_current_user),
) -> ProfileSourceDocumentUploadResponse:
    """Upload a PDF/DOCX with detailed per-company project descriptions."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Empty file")
    from app.services.profile_source_document_service import upload_and_parse_source_document

    try:
        result = await upload_and_parse_source_document(
            user_id=user_id,
            raw=raw,
            filename=file.filename or "document",
            company_name_hint=company_name,
        )
        logger.info(
            "profile_source_document_uploaded",
            user_id=user_id,
            doc_id=result.document.id,
            parse_status=result.document.parse_status,
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except AIParsingError as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(e) or "Document parsing failed.",
        )
    except Exception as e:
        logger.exception("profile_source_document_upload_failed", error=str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Upload failed. See server logs for details.",
        )


@router.patch(
    "/profile/source-documents/{doc_id}",
    response_model=ProfileSourceDocumentResponse,
    dependencies=[Depends(get_current_user)],
)
async def update_profile_source_document(
    doc_id: str,
    request: ProfileSourceDocumentUpdateRequest,
    current_user: dict = Depends(get_current_user),
) -> ProfileSourceDocumentResponse:
    """Update the linked company for a project source document."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    from app.services.profile_source_document_service import update_source_document_company

    updated = await update_source_document_company(
        user_id=user_id,
        doc_id=doc_id,
        company_name=request.company_name,
    )
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
    return updated


@router.post(
    "/profile/source-documents/{doc_id}/reparse",
    response_model=ProfileSourceDocumentResponse,
    dependencies=[Depends(get_current_user)],
)
async def reparse_profile_source_document(
    doc_id: str,
    current_user: dict = Depends(get_current_user),
) -> ProfileSourceDocumentResponse:
    """Re-run structured parse on a stored source document."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    from app.services.profile_source_document_service import reparse_source_document

    updated = await reparse_source_document(user_id=user_id, doc_id=doc_id)
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
    return updated


@router.delete(
    "/profile/source-documents/{doc_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(get_current_user)],
)
async def delete_profile_source_document(
    doc_id: str,
    current_user: dict = Depends(get_current_user),
) -> Response:
    """Delete a project source document."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    from app.services.profile_source_document_service import delete_source_document

    deleted = await delete_source_document(user_id=user_id, doc_id=doc_id)
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


async def _try_pool(pool_factory, label: str):
    """Try to create and ping a Redis pool. Returns the pool or None."""
    try:
        pool = await pool_factory()
        await pool.ping()
        return pool
    except Exception as e:
        logger.warning(
            "redis_pool_unavailable",
            queue=label,
            error=str(e),
            hint="Jobs will use background_tasks fallback. For async processing, ensure Memurai/Redis is running and workers are started.",
        )
        return None


async def try_get_extraction_pool():
    from app.tasks.worker import get_extraction_pool, EXTRACTION_QUEUE
    return await _try_pool(get_extraction_pool, EXTRACTION_QUEUE)


async def try_get_analysis_pool():
    from app.tasks.worker import get_analysis_pool, ANALYSIS_QUEUE
    return await _try_pool(get_analysis_pool, ANALYSIS_QUEUE)


async def enqueue_extraction(
    extraction_id: str,
    url: str,
    *,
    user_id: str | None = None,
    background_tasks: BackgroundTasks | None = None,
) -> None:
    """
    Prefer Redis/arq whenever Redis is reachable (jobs wait in queue until a worker runs).
    Fall back in-process only when Redis is down or enqueue fails.
    """
    from app.tasks.worker import EXTRACTION_QUEUE

    pool = await try_get_extraction_pool()
    bind_logging_context(extraction_id=extraction_id, target_url=url, user_id=user_id)
    if pool:
        try:
            if user_id:
                await pool.enqueue_job("extract_job", extraction_id, url, user_id)
            else:
                await pool.enqueue_job("extract_job", extraction_id, url)
            logger.info(
                "extraction_enqueued_redis",
                extraction_id=extraction_id,
                url=url,
                queue=EXTRACTION_QUEUE,
            )
            return
        except Exception as e:
            logger.warning("extraction_redis_enqueue_failed", extraction_id=extraction_id, error=str(e))

    if background_tasks:
        background_tasks.add_task(process_extraction_sync, extraction_id, url, user_id)
        logger.info("extraction_enqueued_in_process", extraction_id=extraction_id, url=url)
    else:
        logger.error(
            "extraction_not_enqueued",
            extraction_id=extraction_id,
            reason="No Redis and no background_tasks available",
        )


async def enqueue_job_match_analysis(
    job_id: str,
    user_id: str,
    *,
    background_tasks: BackgroundTasks | None = None,
) -> None:
    """
    Prefer Redis/arq for match analysis; fall back to FastAPI BackgroundTasks.
    Uses the dedicated analysis queue, independent from extraction.
    """
    from app.tasks.worker import ANALYSIS_QUEUE

    pool = await try_get_analysis_pool()
    bind_logging_context(job_id=job_id, user_id=user_id)
    if pool:
        try:
            await pool.enqueue_job("analyze_job_match", job_id, user_id)
            logger.info(
                "job_match_enqueued_redis",
                job_id=job_id,
                user_id=user_id,
                queue=ANALYSIS_QUEUE,
            )
            return
        except Exception as e:
            logger.warning("job_match_redis_enqueue_failed", job_id=job_id, error=str(e))

    if background_tasks:
        from app.services.job_match_orchestrator import run_job_match_analysis

        background_tasks.add_task(run_job_match_analysis, job_id, user_id)
        logger.info("job_match_enqueued_in_process", job_id=job_id, user_id=user_id)
    else:
        logger.error(
            "job_match_not_enqueued",
            job_id=job_id,
            user_id=user_id,
            reason="No Redis and no background_tasks available",
        )


async def _fallback_job_match_after_extraction(job_id: str, user_id: str) -> None:
    """Run match in a separate task so extraction (BackgroundTasks) does not block on OpenAI."""
    from app.services.job_match_orchestrator import run_job_match_analysis

    try:
        await run_job_match_analysis(job_id, user_id)
    except Exception as match_err:
        logger.warning(
            "fallback_job_match_failed",
            job_id=job_id,
            user_id=user_id,
            error=str(match_err),
        )


async def _fallback_match_batch_parallel(user_id: str, job_ids: list[str]) -> None:
    """
    When Redis is unavailable, run many matches with bounded concurrency (not one-by-one
    Starlette background tasks, which would serialize all match calls).
    """
    from app.core.config import get_settings
    from app.services.job_match_orchestrator import run_job_match_analysis

    sem = asyncio.Semaphore(max(1, get_settings().analysis_worker_max_jobs))

    async def one(jid: str) -> None:
        async with sem:
            try:
                await run_job_match_analysis(jid, user_id)
            except Exception as e:
                logger.warning("fallback_batch_job_match_failed", job_id=jid, error=str(e))

    await asyncio.gather(*(one(jid) for jid in job_ids))


@router.get("/health", response_model=HealthResponse)
async def health_check() -> HealthResponse:
    settings = get_settings()
    db_connected = await check_database_connection()

    redis_connected = False
    try:
        pool = await try_get_extraction_pool()
        if pool:
            redis_connected = True
            await pool.ping()
    except Exception:
        pass

    browser_available = 0
    try:
        browser_pool = get_browser_pool_safe()
        if browser_pool:
            browser_available = browser_pool.available_slots
    except Exception:
        pass

    status = "healthy" if db_connected else "unhealthy"
    if db_connected and not redis_connected:
        status = "degraded"

    logger.info(
        "health_check",
        status=status,
        database_connected=db_connected,
        redis_connected=redis_connected,
        browser_available=browser_available,
    )
    return HealthResponse(
        status=status,
        version=settings.app_version,
        database_connected=db_connected,
        redis_connected=redis_connected,
        browser_pool_available=browser_available,
    )


async def process_extraction_sync(
    extraction_id: str,
    url: str,
    user_id: str | None = None,
) -> None:
    from app.services.extraction_service import ExtractionService
    from app.storage.repository import JobRepository

    try:
        service = ExtractionService()
        result = await service.process_job(extraction_id, url)
        if user_id and result.get("status") == "extracted":
            found_job_id: str | None = None
            async with get_session() as session:
                job_repo = JobRepository(session)
                job = await job_repo.get_by_extraction_id(extraction_id)
                if job:
                    found_job_id = job.id
                    progress_repo = JobMatchInProgressRepository(session)
                    await progress_repo.add(job.id, user_id)
                    await session.commit()
            if found_job_id:
                asyncio.create_task(_fallback_job_match_after_extraction(found_job_id, user_id))
    except Exception as e:
        logger.error("sync_extraction_failed", extraction_id=extraction_id, error=str(e))


@router.post("/extract", response_model=ExtractionResponse, dependencies=[Depends(get_current_user)])
async def extract_job(
    request: ExtractionRequest,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
) -> ExtractionResponse:
    url = str(request.url)
    should_enqueue = False
    extraction_id: str | None = None
    response: ExtractionResponse | None = None

    is_valid, error = URLManager.validate_url(url)
    if not is_valid:
        logger.warning("extract_job_invalid_url", url=url, error=error)
        raise HTTPException(status_code=400, detail=error)

    domain = URLManager.extract_domain(url)

    block_reason = _check_domain_blocked(domain)
    if block_reason:
        raise HTTPException(status_code=400, detail=block_reason)

    async with get_session() as session:
        repository = JobExtractionRepository(session)
        extraction = await repository.create(
            source_url=url,
            normalized_url=url,
            domain=domain,
        )
        should_enqueue = True
        extraction_id = extraction.id
        logger.info("extract_job_created", job_id=extraction.id, url=url)
        response = _build_response(extraction)

    if should_enqueue and extraction_id:
        await enqueue_extraction(
            extraction_id, url, user_id=current_user.get("user_id"), background_tasks=background_tasks
        )
    return response


@router.post("/extract/batch", response_model=BatchExtractionResponse, dependencies=[Depends(get_current_user)])
async def extract_batch(
    request: BatchExtractionRequest,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
) -> BatchExtractionResponse:
    job_ids = []
    to_enqueue: list[tuple[str, str]] = []

    async with get_session() as session:
        repository = JobExtractionRepository(session)

        for url in request.urls:
            url_str = str(url)

            is_valid, _ = URLManager.validate_url(url_str)
            if not is_valid:
                continue

            domain = URLManager.extract_domain(url_str)
            if _check_domain_blocked(domain):
                continue

            extraction = await repository.create(
                source_url=url_str,
                normalized_url=url_str,
                domain=domain,
            )

            job_ids.append(extraction.id)
            to_enqueue.append((extraction.id, url_str))

    for extraction_id, url_str in to_enqueue:
        await enqueue_extraction(
            extraction_id,
            url_str,
            user_id=current_user.get("user_id"),
            background_tasks=background_tasks,
        )

    logger.info(
        "extract_batch_completed",
        total_urls=len(request.urls),
        accepted_urls=len(job_ids),
        job_ids=job_ids,
    )
    return BatchExtractionResponse(
        batch_id=f"batch_{_utcnow().strftime('%Y%m%d%H%M%S')}",
        total_urls=len(request.urls),
        accepted_urls=len(job_ids),
        duplicate_urls=0,
        job_ids=job_ids,
    )


@router.get("/extract/{job_id}", response_model=ExtractionResponse, dependencies=[Depends(get_current_user)])
async def get_extraction(job_id: str) -> ExtractionResponse:
    async with get_session() as session:
        repository = JobExtractionRepository(session)
        extraction = await repository.get_by_id(job_id)

        if not extraction:
            logger.warning("get_extraction_not_found", job_id=job_id)
            raise HTTPException(status_code=404, detail="Job not found")

        return _build_response(extraction)


def _build_response(extraction) -> ExtractionResponse:
    job_data = None
    display_title = resolve_job_display_title(
        job_title=extraction.title,
        description=extraction.description,
    )
    if extraction.status == ExtractionStatus.COMPLETED and display_title:
        job_data = JobDescriptionSchema(
            title=display_title,
            company=extraction.company,
            location=extraction.location,
            employment_type=extraction.employment_type,
            salary_range=extraction.salary_range,
            description=extraction.description or "",
            responsibilities=extraction.responsibilities or [],
            requirements=extraction.requirements or [],
            benefits=extraction.benefits or [],
            posted_date=extraction.posted_date,
            application_deadline=extraction.application_deadline,
            remote_policy=extraction.remote_policy,
            experience_level=extraction.experience_level,
            industry=extraction.industry,
            raw_metadata=extraction.raw_metadata or {},
        )

    return ExtractionResponse(
        job_id=extraction.id,
        status=extraction.status,
        source_url=extraction.source_url,
        normalized_url=extraction.normalized_url,
        extraction_method=extraction.extraction_method,
        job_data=job_data,
        created_at=extraction.created_at,
        completed_at=extraction.completed_at,
        error_message=None,  # Never expose internal errors to frontend; log server-side only
        is_job_posting=extraction.is_job_posting,
    )


async def _publish_job_submitted(user_id: str | None, job_id: str, url: str) -> None:
    if not user_id:
        return
    await publish_ws_event({
        "type": "job_submitted",
        "user_id": user_id,
        "job_id": job_id,
        "url": url,
    })


@router.post("/jobs/submit", response_model=JobSubmissionResponse, dependencies=[Depends(get_current_user)])
async def submit_job(
    request: JobSubmissionRequest,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
) -> JobSubmissionResponse:
    """
    Submit a job link.

    1. Validate URL
    2. Blocked domain → Job(status='blocked') + UserJobStatus(status='duplicated')
    3. URL match → reuse existing Job row if possible
    4. New URL → create Job + JobExtraction + UserJobStatus(status='active'), enqueue extraction
    """
    is_valid, error = URLManager.validate_url(request.url)
    if not is_valid:
        logger.warning("jobs_submit_invalid_url", url=request.url, error=error)
        return JobSubmissionResponse(
            success=False,
            job_id=None,
            is_duplicate=False,
            duplicate_job_id=None,
            message=f"Invalid URL: {error}"
        )

    user_id = current_user.get("user_id")
    normalized_url = request.url
    domain = URLManager.extract_domain(request.url)

    async with get_session() as session:
        block_reason = _check_domain_blocked(domain)
        if block_reason:
            blocked_job = Job(
                source_url=request.url,
                normalized_url=normalized_url,
                domain=domain,
                title=request.title,
                company=request.company or "Unknown",
                location=request.location,
                description=request.description,
                posted_date=request.posted_date,
                experience_level=request.experience_level,
                industry=request.industry,
                status="blocked",
                raw_metadata={"blocked_domain": domain},
            )
            session.add(blocked_job)
            await session.flush()

            if user_id:
                ujs_repo = UserJobStatusRepository(session)
                await ujs_repo.upsert(
                    user_id=user_id,
                    job_id=blocked_job.id,
                    status="duplicated",
                    exclusion_type="blocked_domain",
                    reason=block_reason,
                )
            await session.commit()
            logger.info("jobs_submit_blocked_domain", domain=domain, job_id=blocked_job.id)
            return JobSubmissionResponse(
                success=True,
                job_id=blocked_job.id,
                is_duplicate=True,
                duplicate_job_id=None,
                message=block_reason,
            )

        # Simple URL match: look for an existing active job with the same URL
        existing_result = await session.execute(
            select(Job)
            .where(Job.normalized_url == normalized_url, Job.status == "active")
            .limit(1)
        )
        existing_job = existing_result.scalar_one_or_none()

        if existing_job and user_id:
            ujs_repo = UserJobStatusRepository(session)
            existing_ujs = await ujs_repo.get(user_id, existing_job.id)
            if existing_ujs:
                await session.commit()
                logger.info("jobs_submit_already_in_pool", job_id=existing_job.id, url=request.url)
                return JobSubmissionResponse(
                    success=True,
                    job_id=existing_job.id,
                    is_duplicate=True,
                    duplicate_job_id=existing_job.id,
                    message="Already in your pool",
                )
            # User doesn't have a status row yet — add one
            await ujs_repo.upsert(
                user_id=user_id,
                job_id=existing_job.id,
                status="active",
            )
            await session.commit()
            logger.info("jobs_submit_existing_job_linked", job_id=existing_job.id, url=request.url)
            await _publish_job_submitted(user_id, existing_job.id, request.url)
            return JobSubmissionResponse(
                success=True,
                job_id=existing_job.id,
                is_duplicate=False,
                duplicate_job_id=None,
                message="Job submitted successfully",
            )

        if existing_job and not user_id:
            return JobSubmissionResponse(
                success=True,
                job_id=existing_job.id,
                is_duplicate=True,
                duplicate_job_id=existing_job.id,
                message="Already in your pool",
            )

        # New URL — create Job + extraction + UserJobStatus
        new_job = Job(
            source_url=request.url,
            normalized_url=normalized_url,
            domain=domain,
            title=request.title,
            company=request.company or "Unknown",
            location=request.location,
            description=request.description,
            posted_date=request.posted_date,
            experience_level=request.experience_level,
            industry=request.industry,
            status="active",
            raw_metadata={
                "submitted_data": {
                    "title": request.title,
                    "company": request.company,
                    "location": request.location,
                    "description": request.description,
                    "posted_date": request.posted_date.isoformat() if request.posted_date else None,
                    "experience_level": request.experience_level,
                    "industry": request.industry,
                }
            },
        )
        session.add(new_job)
        await session.flush()

        extraction_repo = JobExtractionRepository(session)
        extraction = await extraction_repo.create(
            source_url=request.url,
            normalized_url=normalized_url,
            domain=domain,
        )
        new_job.extraction_id = extraction.id

        if user_id:
            ujs_repo = UserJobStatusRepository(session)
            await ujs_repo.upsert(
                user_id=user_id,
                job_id=new_job.id,
                status="active",
            )

        await session.commit()

        if extraction.status != ExtractionStatus.COMPLETED:
            await enqueue_extraction(
                extraction.id,
                request.url,
                user_id=user_id,
                background_tasks=background_tasks,
            )
        elif user_id:
            async with get_session() as match_session:
                existing_match = await match_session.execute(
                    select(JobMatchResult).where(
                        JobMatchResult.job_id == new_job.id,
                        JobMatchResult.user_id == user_id,
                    )
                )
                existing_progress = await match_session.execute(
                    select(JobMatchInProgress).where(
                        JobMatchInProgress.job_id == new_job.id,
                        JobMatchInProgress.user_id == user_id,
                    )
                )
                if not existing_match.scalar_one_or_none() and not existing_progress.scalar_one_or_none():
                    progress_repo = JobMatchInProgressRepository(match_session)
                    await progress_repo.add(new_job.id, user_id)
                    await match_session.commit()
                    await enqueue_job_match_analysis(
                        new_job.id,
                        user_id,
                        background_tasks=background_tasks,
                    )

        logger.info("jobs_submit_created", job_id=new_job.id, url=request.url, extraction_id=extraction.id)
        await _publish_job_submitted(user_id, new_job.id, request.url)
        return JobSubmissionResponse(
            success=True,
            job_id=new_job.id,
            is_duplicate=False,
            duplicate_job_id=None,
            message="Job submitted successfully",
        )


_MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024
_MAX_ATTACHMENT_FILES = 15


@router.post(
    "/jobs/attachment/extract-urls",
    response_model=AttachmentExtractUrlsResponse,
    dependencies=[Depends(get_current_user)],
)
async def extract_job_urls_from_attachments(
    files: list[UploadFile] = File(...),
    current_user: dict = Depends(get_current_user),
) -> AttachmentExtractUrlsResponse:
    """
    Upload Word (.docx), Excel (.xlsx), Markdown, plain text, or HTML files.
    Text is extracted server-side, then OpenAI returns job-related URLs as JSON.
    """
    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded")

    if len(files) > _MAX_ATTACHMENT_FILES:
        raise HTTPException(
            status_code=400,
            detail=f"Too many files (max {_MAX_ATTACHMENT_FILES})",
        )

    warnings: list[str] = []
    parts: list[tuple[str, str]] = []

    for upload in files:
        filename = (upload.filename or "attachment").strip()
        raw = await upload.read()
        if len(raw) > _MAX_ATTACHMENT_BYTES:
            raise HTTPException(
                status_code=400,
                detail=f"File {filename} exceeds maximum size of {_MAX_ATTACHMENT_BYTES // (1024 * 1024)} MB",
            )
        try:
            text = extract_text_from_bytes(filename, raw)
        except ValueError as e:
            warnings.append(f"{filename}: {e}")
            continue
        if text.strip():
            parts.append((filename, text))

    if not parts:
        raise HTTPException(
            status_code=400,
            detail="No readable text from attachments. " + ("; ".join(warnings) if warnings else "Try .docx, .xlsx, .txt, .md, or .html"),
        )

    combined = combine_file_texts(parts)
    if not combined.strip():
        raise HTTPException(status_code=400, detail="Extracted text was empty")

    try:
        urls = await extract_job_urls_from_text_combined(combined, user_id=current_user.get("user_id"))
    except AIParsingError as e:
        logger.warning("extract_urls_ai_failed", error=str(e))
        raise HTTPException(status_code=502, detail=str(e)) from e

    logger.info(
        "extract_job_urls_from_attachments_done",
        files_processed=len(parts),
        url_count=len(urls),
        warning_count=len(warnings),
    )
    return AttachmentExtractUrlsResponse(urls=urls, files_processed=len(parts), warnings=warnings)


@router.get("/jobs/dashboard", response_model=DashboardJobsPage, dependencies=[Depends(get_current_user)])
async def get_dashboard_jobs(
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    sort: str = Query("created_at"),
    order: str = Query("desc"),
    q: str | None = Query(None),
    source: str | None = Query(None),
    remote_only: bool = Query(False),
    current_user: dict = Depends(get_current_user),
) -> DashboardJobsPage:
    """Paginated list of processed jobs from the jobs table, with per-user status."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    SORT_COLUMNS = {
        "created_at": Job.created_at,
        "title": Job.title,
        "company": Job.company,
        "posted_date": Job.posted_date,
        "updated_at": Job.updated_at,
        "match_score": JobMatchResult.overall_score,
    }
    sort_col = SORT_COLUMNS.get(sort, Job.created_at)
    if order == "asc":
        sort_expr = nullslast(sort_col.asc())
    else:
        sort_expr = nullslast(sort_col.desc())

    order_clauses = [sort_expr]
    if sort != "created_at":
        order_clauses.append(Job.created_at.desc())
    order_clauses.append(Job.id.desc())

    async with get_session() as session:
        base_filter = [
            Job.status != "blocked",
            (UserJobStatus.status.is_(None)) | (UserJobStatus.status == "active"),
        ]

        if q:
            pattern = f"%{q}%"
            base_filter.append(
                (Job.title.ilike(pattern)) | (Job.company.ilike(pattern))
            )

        if source:
            base_filter.append(Job.raw_metadata["source"].as_string() == source)

        if remote_only:
            base_filter.append(Job.raw_metadata["is_remote"].as_boolean() == True)  # noqa: E712

        count_stmt = (
            select(func.count())
            .select_from(Job)
            .outerjoin(
                UserJobStatus,
                (UserJobStatus.job_id == Job.id) & (UserJobStatus.user_id == user_id),
            )
            .where(*base_filter)
        )
        total = (await session.execute(count_stmt)).scalar() or 0

        pages = max(1, -(-total // per_page))
        offset = (page - 1) * per_page

        stmt = (
            select(
                Job,
                JobExtraction.status.label("ext_status"),
                JobExtraction.is_job_posting,
                JobExtraction.salary_range,
                JobMatchResult.overall_score,
                JobMatchInProgress.id.label("match_progress_id"),
                ResumeBuildResult.resume_docx_status,
                ResumeBuildResult.content_generation_status,
                ResumeBuildResult.resume_pdf_status,
                ResumeBuildResult.resume_pdf_path,
                ResumeBuildResult.cover_letter_pdf_status,
                ResumeBuildResult.cover_letter_pdf_path,
                ValidJobUserApplication.applied_at,
                ValidJobUserApplication.applied_by_name,
                UserJobStatus.status.label("ujs_status"),
            )
            .select_from(Job)
            .outerjoin(
                UserJobStatus,
                (UserJobStatus.job_id == Job.id) & (UserJobStatus.user_id == user_id),
            )
            .outerjoin(JobExtraction, Job.extraction_id == JobExtraction.id)
            .outerjoin(
                JobMatchResult,
                (JobMatchResult.job_id == Job.id) & (JobMatchResult.user_id == user_id),
            )
            .outerjoin(
                JobMatchInProgress,
                (JobMatchInProgress.job_id == Job.id) & (JobMatchInProgress.user_id == user_id),
            )
            .outerjoin(
                ResumeBuildResult,
                (ResumeBuildResult.job_id == Job.id) & (ResumeBuildResult.user_id == user_id),
            )
            .outerjoin(
                ValidJobUserApplication,
                (ValidJobUserApplication.job_id == Job.id) & (ValidJobUserApplication.user_id == user_id),
            )
            .where(*base_filter)
            .order_by(*order_clauses)
            .limit(per_page)
            .offset(offset)
        )
        result = await session.execute(stmt)
        rows = result.all()

        items = []
        for (
            job, ext_status, is_job_posting, ext_salary_range, match_score,
            match_progress_id, rb_docx_status, cg_status,
            rb_pdf_status, rb_pdf_path, cl_pdf_status, cl_pdf_path,
            applied_at, applied_by_name, ujs_status,
        ) in rows:
            meta = job.raw_metadata or {}
            items.append(
                DashboardJobResponse(
                    id=job.id,
                    source_url=job.source_url,
                    normalized_url=job.normalized_url,
                    domain=job.domain,
                    title=job.title,
                    company=job.company,
                    location=job.location,
                    posted_date=job.posted_date,
                    experience_level=job.experience_level,
                    industry=job.industry,
                    status=job.status,
                    created_at=job.created_at,
                    updated_at=job.updated_at,
                    extraction_id=job.extraction_id,
                    extraction_status=ext_status.value if ext_status else None,
                    is_job_posting=is_job_posting,
                    match_overall_score=match_score,
                    match_in_progress=bool(match_progress_id and match_score is None),
                    resume_build_status=rb_docx_status,
                    content_generation_status=cg_status,
                    resume_pdf_status=rb_pdf_status,
                    resume_pdf_path=rb_pdf_path,
                    cover_letter_pdf_status=cl_pdf_status,
                    cover_letter_pdf_path=cl_pdf_path,
                    applied_at=applied_at,
                    applied_by_name=applied_by_name,
                    sheet_posted_at=job.sheet_posted_at,
                    user_status=ujs_status,
                    source=meta.get("source"),
                    is_remote=bool(meta.get("is_remote", False)),
                    salary_raw=ext_salary_range or meta.get("salary_raw"),
                    job_type=meta.get("job_type"),
                )
            )

        return DashboardJobsPage(
            items=items,
            total=total,
            page=page,
            per_page=per_page,
            pages=pages,
        )


@router.get("/jobs/valid", response_model=list[JobResponse], dependencies=[Depends(get_current_user)])
async def get_valid_jobs(
    limit: int = 50,
    offset: int = 0,
    current_user: dict = Depends(get_current_user),
) -> list[JobResponse]:
    """Get active jobs for the current user — only jobs with UserJobStatus(status='active')."""
    limit = min(limit, 500)
    logger.debug("get_valid_jobs", limit=limit, offset=offset)
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    async with get_session() as session:
        stmt = (
            select(
                Job,
                JobExtraction.status,
                JobExtraction.is_job_posting,
                JobMatchResult.overall_score,
                JobMatchInProgress.id.label("match_progress_id"),
                ValidJobUserApplication.applied_at,
                ValidJobUserApplication.applied_by_name,
            )
            .select_from(Job)
            .join(
                UserJobStatus,
                (UserJobStatus.job_id == Job.id) & (UserJobStatus.user_id == user_id),
            )
            .outerjoin(JobExtraction, Job.extraction_id == JobExtraction.id)
            .outerjoin(
                JobMatchResult,
                (JobMatchResult.job_id == Job.id) & (JobMatchResult.user_id == user_id),
            )
            .outerjoin(
                JobMatchInProgress,
                (JobMatchInProgress.job_id == Job.id) & (JobMatchInProgress.user_id == user_id),
            )
            .outerjoin(
                ValidJobUserApplication,
                (ValidJobUserApplication.job_id == Job.id)
                & (ValidJobUserApplication.user_id == user_id),
            )
            .where(Job.status == "active")
            .where(UserJobStatus.status == "active")
            .order_by(Job.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
        result = await session.execute(stmt)
        rows = result.all()
        return [
            JobResponse(
                id=job.id,
                source_url=job.source_url,
                normalized_url=job.normalized_url,
                domain=job.domain,
                title=job.title,
                company=job.company,
                location=job.location,
                posted_date=job.posted_date,
                experience_level=job.experience_level,
                industry=job.industry,
                similarity_hash=job.similarity_hash,
                scraped_at=job.scraped_at,
                extraction_id=job.extraction_id,
                extraction_status=ext_status.value if ext_status else None,
                is_job_posting=is_job_posting,
                match_overall_score=match_score,
                match_status="processing" if (match_progress_id and match_score is None) else None,
                click_count=getattr(job, "click_count", 0) or 0,
                applied_at=applied_at,
                applied_by_name=applied_by_name,
                sheet_posted_at=job.sheet_posted_at,
                status=job.status,
                created_at=job.created_at,
                updated_at=job.updated_at,
            )
            for job, ext_status, is_job_posting, match_score, match_progress_id, applied_at, applied_by_name in rows
        ]


@router.post("/jobs/valid/ai-search", response_model=AiJobSearchResponse, dependencies=[Depends(get_current_user)])
async def ai_search_valid_jobs(
    body: AiJobSearchRequest,
    current_user: dict = Depends(get_current_user),
) -> AiJobSearchResponse:
    """Interpret a natural language prompt via OpenAI and return matching valid jobs with full data."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        spec = await interpret_job_search_prompt(body.prompt, user_id=user_id)
    except OpenAIAPIError as e:
        logger.warning("ai_search_openai_error", error=str(e))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AI search is temporarily unavailable. Please try again later.",
        )
    except AIParsingError as e:
        logger.warning("ai_search_valid_jobs_failed", error=str(e))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(e) or "AI search is unavailable. Check OPENAI_API_KEY.",
        )
    async with get_session() as session:
        matching_jobs, total_matching = await apply_job_search_spec(session, user_id, spec)
    logger.info("ai_search_valid_jobs_ok", matches=len(matching_jobs), total_matching=total_matching)
    return AiJobSearchResponse(matching_jobs=matching_jobs, query=spec, total_matching=total_matching)


@router.get("/jobs/valid/{job_id}", response_model=JobResponse, dependencies=[Depends(get_current_user)])
async def get_valid_job(job_id: str, current_user: dict = Depends(get_current_user)) -> JobResponse:
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    async with get_session() as session:
        stmt = (
            select(
                Job,
                JobExtraction.status,
                JobExtraction.is_job_posting,
                ValidJobUserApplication.applied_at,
                ValidJobUserApplication.applied_by_name,
            )
            .select_from(Job)
            .join(
                UserJobStatus,
                (UserJobStatus.job_id == Job.id) & (UserJobStatus.user_id == user_id),
            )
            .outerjoin(JobExtraction, Job.extraction_id == JobExtraction.id)
            .outerjoin(
                ValidJobUserApplication,
                (ValidJobUserApplication.job_id == Job.id)
                & (ValidJobUserApplication.user_id == user_id),
            )
            .where(Job.id == job_id)
            .where(Job.status == "active")
            .where(UserJobStatus.status == "active")
        )
        result = await session.execute(stmt)
        row = result.one_or_none()
        if not row:
            logger.warning("get_valid_job_not_found", job_id=job_id)
            raise HTTPException(status_code=404, detail="Job not found or not in your active pool")
        job, ext_status, is_job_posting, applied_at, applied_by_name = row
        return JobResponse(
            id=job.id,
            source_url=job.source_url,
            normalized_url=job.normalized_url,
            domain=job.domain,
            title=job.title,
            company=job.company,
            location=job.location,
            description=job.description,
            posted_date=job.posted_date,
            experience_level=job.experience_level,
            industry=job.industry,
            similarity_hash=job.similarity_hash,
            scraped_at=job.scraped_at,
            extraction_id=job.extraction_id,
            extraction_status=ext_status.value if ext_status else None,
            is_job_posting=is_job_posting,
            click_count=getattr(job, "click_count", 0) or 0,
            applied_at=applied_at,
            applied_by_name=applied_by_name,
            sheet_posted_at=job.sheet_posted_at,
            status=job.status,
            created_at=job.created_at,
            updated_at=job.updated_at,
        )


@router.post(
    "/jobs/valid/applied/batch",
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(get_current_user)],
)
async def mark_valid_jobs_applied_batch(
    body: JobIdsBatchRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """Persist per-user applied marks (full name from profile / account)."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    async with get_session() as session:
        user_repo = UserRepository(session)
        user = await user_repo.get_by_id(user_id)
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        label = user_applied_by_display_name(user)
        app_repo = ValidJobUserApplicationRepository(session)
        n = await app_repo.upsert_batch(user_id, body.job_ids, label)
        await session.commit()
    applied_at_iso = _utcnow().isoformat()
    return {"marked": n, "applied_by_name": label, "applied_at": applied_at_iso}


@router.post(
    "/jobs/valid/unapplied/batch",
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(get_current_user)],
)
async def mark_valid_jobs_unapplied_batch(
    body: JobIdsBatchRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    async with get_session() as session:
        app_repo = ValidJobUserApplicationRepository(session)
        n = await app_repo.delete_batch(user_id, body.job_ids)
        await session.commit()
    return {"cleared": n}


@router.post("/jobs/valid/{job_id}/click", response_model=dict)
async def record_job_click(
    job_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Record a click on a job URL. Returns updated click_count."""
    async with get_session() as session:
        r = await session.execute(
            select(Job).where(Job.id == job_id, Job.status == "active")
        )
        job = r.scalar_one_or_none()
        if not job:
            raise HTTPException(status_code=404, detail="Valid job not found")
        new_count = (getattr(job, "click_count", 0) or 0) + 1
        await session.execute(
            sa_update(Job).where(Job.id == job_id).values(click_count=new_count)
        )
        await session.commit()
    return {"click_count": new_count}


@router.get("/jobs/valid/{job_id}/match", response_model=JobMatchResponse, dependencies=[Depends(get_current_user)])
async def get_job_match(
    job_id: str,
    current_user: dict = Depends(get_current_user),
) -> JobMatchResponse:
    """Get cached AI job–profile match for the current user. Returns 404 if not yet analyzed."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    async with get_session() as session:
        match_repo = JobMatchRepository(session)
        match_result = await match_repo.get(job_id, user_id)
        if not match_result:
            raise HTTPException(status_code=404, detail="Job match not yet analyzed")
        return JobMatchResponse(
            job_id=match_result.job_id,
            overall_score=match_result.overall_score,
            dimension_scores=match_result.dimension_scores,
            summary=match_result.summary or "",
            strengths=match_result.strengths or [],
            gaps=match_result.gaps or [],
            recommendation=match_result.recommendation or "moderate_match",
            created_at=match_result.created_at,
        )


def _ai_enriched_extraction(extraction: JobExtraction | None) -> bool:
    if not extraction:
        return False
    meta = extraction.raw_metadata or {}
    return bool(meta.get("ai_structured_updated_at") or meta.get("ai_structured_source"))


@router.get(
    "/jobs/valid/{job_id}/analysis",
    response_model=JobAnalysisResponse,
    dependencies=[Depends(get_current_user)],
)
async def get_job_analysis_panel(
    job_id: str,
    current_user: dict = Depends(get_current_user),
) -> JobAnalysisResponse:
    """
    Single payload for the analysis UI: extraction posting + optional cached AI match.
    """
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    async with get_session() as session:
        r = await session.execute(select(Job).where(Job.id == job_id, Job.status == "active"))
        job = r.scalar_one_or_none()
        if not job:
            raise HTTPException(status_code=404, detail="Valid job not found")

        extraction = None
        extraction_status = None
        extraction_method = None
        is_job_posting = None
        job_data = None
        content_enriched_by_ai = False

        if job.extraction_id:
            ext_repo = JobExtractionRepository(session)
            extraction = await ext_repo.get_by_id(job.extraction_id)
            if extraction:
                extraction_status = extraction.status
                extraction_method = extraction.extraction_method
                is_job_posting = extraction.is_job_posting
                content_enriched_by_ai = _ai_enriched_extraction(extraction)
                display_title = resolve_job_display_title(
                    job_title=extraction.title,
                    description=extraction.description,
                )
                if extraction.status == ExtractionStatus.COMPLETED and display_title:
                    job_data = JobDescriptionSchema(
                        title=display_title,
                        company=extraction.company,
                        location=extraction.location,
                        employment_type=extraction.employment_type,
                        salary_range=extraction.salary_range,
                        description=extraction.description or "",
                        responsibilities=extraction.responsibilities or [],
                        requirements=extraction.requirements or [],
                        benefits=extraction.benefits or [],
                        posted_date=extraction.posted_date,
                        application_deadline=extraction.application_deadline,
                        remote_policy=extraction.remote_policy,
                        experience_level=extraction.experience_level,
                        industry=extraction.industry,
                        raw_metadata=extraction.raw_metadata or {},
                    )

        match_repo = JobMatchRepository(session)
        match_row = await match_repo.get(job_id, user_id)
        in_prog = await session.execute(
            select(JobMatchInProgress).where(
                JobMatchInProgress.job_id == job_id,
                JobMatchInProgress.user_id == user_id,
            )
        )
        match_in_progress = in_prog.scalar_one_or_none() is not None

        match_payload = None
        if match_row:
            match_payload = JobMatchResponse(
                job_id=match_row.job_id,
                overall_score=match_row.overall_score,
                dimension_scores=match_row.dimension_scores,
                summary=match_row.summary or "",
                strengths=match_row.strengths or [],
                gaps=match_row.gaps or [],
                recommendation=match_row.recommendation or "moderate_match",
                created_at=match_row.created_at,
            )

        vm = job.raw_metadata or {}
        reason_raw = vm.get("promotion_reason")
        promotion_payload = None
        if isinstance(reason_raw, str) and reason_raw.strip():
            name = vm.get("promoted_by_name")
            email = vm.get("promoted_by_email")
            if isinstance(name, str) and name.strip():
                by_label = name.strip()
            elif isinstance(email, str) and email.strip():
                by_label = email.strip()
            else:
                by_label = "Unknown"
            at_raw = vm.get("promoted_at")
            at_str = at_raw.strip() if isinstance(at_raw, str) and at_raw.strip() else None

            promotion_payload = JobPromotionInfo(
                reason=reason_raw.strip(),
                promoted_by=by_label,
                promoted_at=at_str,
            )

        resume_build_payload = None
        resume_repo = ResumeBuildRepository(session)
        rb_row = await resume_repo.get(job_id, user_id)
        if rb_row:
            resume_build_payload = ResumeBuildStatusResponse(
                job_id=rb_row.job_id,
                content_generation_status=getattr(rb_row, "content_generation_status", None) or "pending",
                content_generation_error=getattr(rb_row, "content_generation_error", None),
                resume_docx_status=rb_row.resume_docx_status,
                resume_pdf_status=rb_row.resume_pdf_status,
                cover_letter_docx_status=rb_row.cover_letter_docx_status,
                cover_letter_pdf_status=rb_row.cover_letter_pdf_status,
                output_directory=rb_row.output_directory,
                error_message=rb_row.error_message,
                created_at=rb_row.created_at,
                updated_at=rb_row.updated_at,
            )

        return JobAnalysisResponse(
            job_id=job.id,
            extraction_id=job.extraction_id,
            extraction_status=extraction_status,
            source_url=job.source_url,
            job_data=job_data,
            extraction_method=extraction_method,
            is_job_posting=is_job_posting,
            content_enriched_by_ai=content_enriched_by_ai,
            match=match_payload,
            match_in_progress=match_in_progress,
            promotion=promotion_payload,
            resume_build=resume_build_payload,
        )


@router.post("/jobs/valid/{job_id}/match", status_code=status.HTTP_202_ACCEPTED, dependencies=[Depends(get_current_user)])
async def trigger_job_match(
    job_id: str,
    background_tasks: BackgroundTasks,
    force: bool = Query(
        False,
        description="If true, discard cached match and re-run (e.g. after profile update).",
    ),
    current_user: dict = Depends(get_current_user),
):
    """Trigger AI job–profile match analysis. Returns 202 when queued, or 200 if already cached (unless force)."""
    from app.storage.repository import JobMatchInProgressRepository

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    async with get_session() as session:
        progress_repo = JobMatchInProgressRepository(session)
        match_repo = JobMatchRepository(session)
        in_prog = await session.execute(
            select(JobMatchInProgress).where(
                JobMatchInProgress.job_id == job_id,
                JobMatchInProgress.user_id == user_id,
            )
        )
        if in_prog.scalar_one_or_none():
            return {"status": "queued", "message": "Match analysis already in progress"}
        existing = await match_repo.get(job_id, user_id)
        if existing and not force:
            return {"status": "cached", "message": "Match already computed"}
        if existing and force:
            await match_repo.delete(job_id, user_id)
        r = await session.execute(select(Job).where(Job.id == job_id, Job.status == "active"))
        job = r.scalar_one_or_none()
        if not job or not job.extraction_id:
            raise HTTPException(status_code=400, detail="Job has no scraped description yet")
        extraction_repo = JobExtractionRepository(session)
        extraction = await extraction_repo.get_by_id(job.extraction_id)
        if not extraction or extraction.status != ExtractionStatus.COMPLETED:
            raise HTTPException(status_code=400, detail="Job description not yet scraped")
        await progress_repo.add(job_id, user_id)
        await session.commit()
    await enqueue_job_match_analysis(job_id, user_id, background_tasks=background_tasks)
    return {"status": "queued", "message": "Match analysis queued"}


class RescrapeRequest(BaseModel):
    url: str = Field(..., min_length=1, max_length=2048)


# Jobs the dashboard may show (status != blocked) but batch/single rescrape must accept.
_RESCRAPABLE_JOB_STATUSES = ("active", "extraction_failed")


async def _get_job_for_rescrape(session, job_id: str) -> Job | None:
    """Load a job eligible for rescrape (active or prior extraction failure)."""
    r = await session.execute(
        select(Job).where(Job.id == job_id, Job.status.in_(_RESCRAPABLE_JOB_STATUSES))
    )
    return r.scalar_one_or_none()


async def _prepare_job_rescrape_in_session(
    session,
    job: Job,
    source_url: str,
    user_id: str | None,
) -> str:
    """
    Reset extraction (or attach a new one), clear cached match for the user, return extraction_id.
    Caller must commit, then call enqueue_extraction (same pipeline as a new job posting).
    """
    if job.status == "extraction_failed":
        job.status = "active"

    source_url = source_url.strip()
    is_valid, error = URLManager.validate_url(source_url)
    if not is_valid:
        raise ValueError(error or "Invalid URL")

    block_reason = _check_domain_blocked(URLManager.extract_domain(source_url))
    if block_reason:
        raise ValueError(block_reason)

    domain = URLManager.extract_domain(source_url)

    extraction_id = job.extraction_id
    repo = JobExtractionRepository(session)

    if not extraction_id:
        extraction = await repo.create(
            source_url=source_url,
            normalized_url=source_url,
            domain=domain,
        )
        job.extraction_id = extraction.id
        job.scraped_at = None
        extraction_id = extraction.id
    else:
        await repo.reset_for_refresh(extraction_id, source_url, domain)
        job.scraped_at = None
        from app.services.extraction_cache import invalidate_extraction_cache

        await invalidate_extraction_cache(extraction_id)

    if user_id:
        match_repo = JobMatchRepository(session)
        await match_repo.delete(job.id, user_id)
        progress_repo = JobMatchInProgressRepository(session)
        await progress_repo.remove(job.id, user_id)

    return extraction_id


class RerunJobMatchBatchRequest(BaseModel):
    job_ids: list[str] = Field(..., min_length=1, max_length=100)


@router.post("/jobs/valid/match/rerun", status_code=status.HTTP_202_ACCEPTED, dependencies=[Depends(get_current_user)])
async def rerun_job_match_batch(
    body: RerunJobMatchBatchRequest,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
):
    """
    Re-queue AI job–profile match for many valid jobs (e.g. after profile / résumé update).
    Clears cached scores, marks rows in progress, and enqueues analysis asynchronously.
    """
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    seen_ids: set[str] = set()
    unique_ids: list[str] = []
    for jid in body.job_ids:
        if jid in seen_ids:
            continue
        seen_ids.add(jid)
        unique_ids.append(jid)

    enqueued_ids: list[str] = []
    skipped: list[dict[str, str]] = []

    for job_id in unique_ids:
        async with get_session() as session:
            progress_repo = JobMatchInProgressRepository(session)
            match_repo = JobMatchRepository(session)
            in_prog = await session.execute(
                select(JobMatchInProgress).where(
                    JobMatchInProgress.job_id == job_id,
                    JobMatchInProgress.user_id == user_id,
                )
            )
            if in_prog.scalar_one_or_none():
                skipped.append({"id": job_id, "reason": "already_in_progress"})
                continue

            await match_repo.delete(job_id, user_id)
            await session.execute(
                text(
                    "DELETE FROM resume_build_results "
                    "WHERE job_id = :job_id AND user_id = :uid"
                ),
                {"job_id": job_id, "uid": user_id},
            )

            r = await session.execute(select(Job).where(Job.id == job_id, Job.status == "active"))
            job = r.scalar_one_or_none()
            if not job or not job.extraction_id:
                skipped.append({"id": job_id, "reason": "no_extraction"})
                continue

            extraction_repo = JobExtractionRepository(session)
            extraction = await extraction_repo.get_by_id(job.extraction_id)
            if not extraction or extraction.status != ExtractionStatus.COMPLETED:
                skipped.append({"id": job_id, "reason": "extraction_not_ready"})
                continue

            await progress_repo.add(job_id, user_id)
            await session.commit()
            enqueued_ids.append(job_id)

    if not enqueued_ids:
        return {
            "status": "accepted",
            "enqueued": 0,
            "enqueued_ids": [],
            "skipped": skipped,
            "message": "Nothing queued; fix skipped reasons or wait for in-progress jobs.",
        }

    ids_for_in_process: list[str] = list(enqueued_ids)
    pool = await try_get_analysis_pool()
    if pool:
        redis_failed: list[str] = []
        for jid in enqueued_ids:
            try:
                await pool.enqueue_job("analyze_job_match", jid, user_id)
            except Exception as e:
                logger.warning(
                    "job_match_rerun_redis_enqueue_failed",
                    job_id=jid,
                    error=str(e),
                )
                redis_failed.append(jid)
        if not redis_failed:
            logger.info(
                "job_match_rerun_batch_redis",
                user_id=user_id,
                count=len(enqueued_ids),
                skipped=len(skipped),
            )
            return {"status": "queued", "enqueued": len(enqueued_ids), "enqueued_ids": enqueued_ids, "skipped": skipped}
        logger.warning(
            "job_match_rerun_batch_redis_partial",
            user_id=user_id,
            redis_failed=len(redis_failed),
        )
        ids_for_in_process = redis_failed

    if background_tasks:
        background_tasks.add_task(_fallback_match_batch_parallel, user_id, ids_for_in_process)
        logger.info(
            "job_match_rerun_batch_in_process",
            user_id=user_id,
            count=len(enqueued_ids),
            skipped=len(skipped),
        )
        return {"status": "queued", "enqueued": len(enqueued_ids), "enqueued_ids": enqueued_ids, "skipped": skipped}

    # Redis unavailable and no fallback worker path: clear markers for jobs we failed to queue.
    async with get_session() as session:
        progress_repo = JobMatchInProgressRepository(session)
        for jid in ids_for_in_process:
            await progress_repo.remove(jid, user_id)
    raise HTTPException(status_code=503, detail="Could not queue match analysis")


@router.post(
    "/jobs/valid/rescrape/batch",
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(get_current_user)],
)
async def rescrape_valid_jobs_batch(
    body: JobIdsBatchRequest,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
):
    """
    Re-queue page extraction for many valid jobs (stored source_url each).
    Uses the same extraction queue and post-completion match pipeline as a new job post.
    """
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    seen: set[str] = set()
    unique_ids: list[str] = []
    for jid in body.job_ids:
        if jid in seen:
            continue
        seen.add(jid)
        unique_ids.append(jid)

    jobs_out: list[dict[str, str]] = []
    skipped: list[dict[str, str]] = []

    for job_id in unique_ids:
        async with get_session() as session:
            job = await _get_job_for_rescrape(session, job_id)
            if not job:
                skipped.append({"id": job_id, "reason": "not_found"})
                continue
            source_url = (job.source_url or "").strip()
            if not source_url:
                skipped.append({"id": job_id, "reason": "no_url"})
                continue
            try:
                extraction_id = await _prepare_job_rescrape_in_session(session, job, source_url, user_id)
            except ValueError as e:
                skipped.append({"id": job_id, "reason": str(e)[:200]})
                continue
            await session.commit()

        await enqueue_extraction(
            extraction_id,
            source_url,
            user_id=user_id,
            background_tasks=background_tasks,
        )
        jobs_out.append({"job_id": job_id, "extraction_id": extraction_id})
        logger.info("rescrape_batch_enqueued", job_id=job_id, extraction_id=extraction_id)

    return {
        "status": "queued",
        "enqueued": len(jobs_out),
        "jobs": jobs_out,
        "skipped": skipped,
    }


@router.post("/jobs/valid/{job_id}/rescrape", dependencies=[Depends(get_current_user)])
async def rescrape_valid_job(
    job_id: str,
    request: RescrapeRequest,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
):
    """Reset extraction for a valid job and re-enqueue it for scraping. Uses the URL from the request to ensure we scrape exactly the URL the user clicked on."""
    user_id = current_user.get("user_id")
    source_url = request.url.strip()

    async with get_session() as session:
        job = await _get_job_for_rescrape(session, job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Valid job not found")
        try:
            extraction_id = await _prepare_job_rescrape_in_session(session, job, source_url, user_id)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        await session.commit()

    await enqueue_extraction(
        extraction_id,
        source_url,
        user_id=user_id,
        background_tasks=background_tasks,
    )
    logger.info("rescrape_enqueued", job_id=job_id, extraction_id=extraction_id, url=source_url)
    return {"status": "ok", "extraction_id": extraction_id}


@router.get("/jobs/invalid", response_model=list[DuplicatedJobResponse], dependencies=[Depends(get_current_user)])
async def get_duplicated_jobs(
    limit: int = 50,
    offset: int = 0,
    category: str = Query("duplicates", pattern="^(duplicates|low_score|extraction_failed|non_us)$"),
    current_user: dict = Depends(get_current_user),
) -> list[DuplicatedJobResponse]:
    """Get duplicated/hidden jobs for the current user from user_job_status."""
    limit = min(limit, 500)
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    logger.debug("get_duplicated_jobs", limit=limit, offset=offset, user_id=user_id, category=category)

    from app.services.job_exclusion_types import sql_filter_for_invalid_category

    async with get_session() as session:
        stmt = (
            select(UserJobStatus, Job, JobExtraction)
            .join(Job, UserJobStatus.job_id == Job.id)
            .outerjoin(JobExtraction, Job.extraction_id == JobExtraction.id)
            .where(UserJobStatus.user_id == user_id)
            .where(UserJobStatus.status == "duplicated")
            .where(sql_filter_for_invalid_category(UserJobStatus.exclusion_type, category))
        )
        stmt = (
            stmt.order_by(UserJobStatus.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
        result = await session.execute(stmt)
        rows = result.all()
        return [
            DuplicatedJobResponse(
                user_job_status_id=ujs.id,
                job_id=job.id,
                source_url=job.source_url,
                domain=job.domain,
                title=resolve_job_display_title(
                    job_title=job.title,
                    extraction_title=extraction.title if extraction else None,
                    submitted_title=(
                        (job.raw_metadata or {}).get("submitted_data", {}).get("title")
                        if isinstance(job.raw_metadata, dict)
                        else None
                    ),
                    description=extraction.description if extraction else job.description,
                ),
                company=job.company,
                location=job.location,
                posted_date=job.posted_date,
                status=ujs.status,
                exclusion_type=ujs.exclusion_type,
                duplicated_because_id=ujs.duplicated_because_id,
                reason=ujs.reason,
                match_score_at_decision=ujs.match_score_at_decision,
                created_at=ujs.created_at,
            )
            for ujs, job, extraction in rows
        ]


@router.get("/jobs/invalid/counts", dependencies=[Depends(get_current_user)])
async def get_invalid_job_counts(
    current_user: dict = Depends(get_current_user),
) -> dict:
    """Counts for duplicates modal tabs — single query with conditional aggregation."""
    from app.services.job_exclusion_types import (
        BELOW_MIN_SCORE_EXCLUSION,
        EXTRACTION_FAILED_EXCLUSION,
        NON_US_LOCATION_EXCLUSION,
        _EXCLUDED_FROM_DUPLICATES_TAB,
    )

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    async with get_session() as session:
        et = UserJobStatus.exclusion_type
        row = (await session.execute(
            select(
                func.count().filter(et == BELOW_MIN_SCORE_EXCLUSION).label("low_score"),
                func.count().filter(et == EXTRACTION_FAILED_EXCLUSION).label("extraction_failed"),
                func.count().filter(et == NON_US_LOCATION_EXCLUSION).label("non_us"),
                func.count().filter(
                    (et.is_(None)) | (et.notin_(list(_EXCLUDED_FROM_DUPLICATES_TAB)))
                ).label("duplicates"),
            )
            .select_from(UserJobStatus)
            .where(
                UserJobStatus.user_id == user_id,
                UserJobStatus.status == "duplicated",
            )
        )).one()

        low_score = row.low_score
        extraction_failed = row.extraction_failed
        non_us = row.non_us
        duplicates = row.duplicates

    return {
        "duplicates": duplicates,
        "low_score": low_score,
        "extraction_failed": extraction_failed,
        "non_us": non_us,
        "total": duplicates + low_score + extraction_failed + non_us,
    }


@router.post("/jobs/reconcile-locations", dependencies=[Depends(get_current_user)])
async def reconcile_job_locations(
    current_user: dict = Depends(get_current_user),
) -> dict:
    """Move visible active jobs with non-US or unverified locations into hidden lists."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    from app.services.job_location_reconcile import reconcile_job_locations_for_user

    result = await reconcile_job_locations_for_user(user_id)
    return {"success": True, **result}


@router.get("/jobs/invalid/{job_id}", response_model=DuplicatedJobResponse, dependencies=[Depends(get_current_user)])
async def get_invalid_job(
    job_id: str,
    current_user: dict = Depends(get_current_user),
) -> DuplicatedJobResponse:
    """Get a single duplicated/hidden job entry by user_job_status id."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    async with get_session() as session:
        stmt = (
            select(UserJobStatus, Job, JobExtraction)
            .join(Job, UserJobStatus.job_id == Job.id)
            .outerjoin(JobExtraction, Job.extraction_id == JobExtraction.id)
            .where(UserJobStatus.id == job_id)
            .where(UserJobStatus.user_id == user_id)
        )
        result = await session.execute(stmt)
        row = result.one_or_none()
        if not row:
            logger.warning("get_invalid_job_not_found", job_id=job_id)
            raise HTTPException(status_code=404, detail="Invalid job not found")

        ujs, job, extraction = row
        return DuplicatedJobResponse(
            user_job_status_id=ujs.id,
            job_id=job.id,
            source_url=job.source_url,
            domain=job.domain,
            title=resolve_job_display_title(
                job_title=job.title,
                extraction_title=extraction.title if extraction else None,
                submitted_title=(
                    (job.raw_metadata or {}).get("submitted_data", {}).get("title")
                    if isinstance(job.raw_metadata, dict)
                    else None
                ),
                description=extraction.description if extraction else job.description,
            ),
            company=job.company,
            location=job.location,
            posted_date=job.posted_date,
            status=ujs.status,
            exclusion_type=ujs.exclusion_type,
            duplicated_because_id=ujs.duplicated_because_id,
            reason=ujs.reason,
            match_score_at_decision=ujs.match_score_at_decision,
            created_at=ujs.created_at,
        )


@router.delete(
    "/jobs/user-exclusions/{job_id}",
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(get_current_user)],
)
async def restore_excluded_job(
    job_id: str,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """Restore a per-user excluded job back to the user's active pool.

    Updates the UserJobStatus row to status='active' so the job appears again
    in GET /jobs/valid for this user.
    """
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    async with get_session() as session:
        repo = UserJobStatusRepository(session)
        await repo.upsert(user_id=user_id, job_id=job_id, status="active")
        await session.commit()
    logger.info("user_exclusion_restored", user_id=user_id, job_id=job_id)
    return {"restored": True, "job_id": job_id}


class DeduplicationSettingsRequest(BaseModel):
    dedup_recycle_days: int = Field(..., ge=1, le=3650, description="Days before a company is considered 'fresh' again")


class DeduplicationSettingsResponse(BaseModel):
    dedup_recycle_days: int


class UserSettingsResponse(BaseModel):
    openai_key_mode: str
    openai_key_configured: bool
    openai_key_hint: str | None = None
    system_openai_available: bool
    dedup_recycle_mode: str
    dedup_recycle_days: int
    dedup_recycle_days_custom: int
    default_dedup_recycle_days: int
    min_match_score_mode: str
    min_match_score: int
    min_match_score_custom: int
    default_min_match_score: int
    resume_tailoring_prompt_mode: str
    resume_tailoring_prompt_instructions: str
    resume_tailoring_prompt_instructions_custom: str
    default_resume_tailoring_prompt_instructions: str
    resume_tailoring_output_contract: str
    resume_tailoring_prompt_max_length: int
    cover_letter_prompt_mode: str
    cover_letter_prompt_instructions: str
    cover_letter_prompt_instructions_custom: str
    default_cover_letter_prompt_instructions: str
    cover_letter_prompt_max_length: int
    resume_template_status: str
    resume_template_source_filename: str | None = None
    resume_template_error: str | None = None
    resume_template_profile_work_count: int | None = None
    resume_template_analyzed_at: datetime | None = None
    resume_template_ready: bool = False
    cover_letter_template_status: str = "missing"
    cover_letter_template_source_filename: str | None = None
    cover_letter_template_error: str | None = None
    cover_letter_template_analyzed_at: datetime | None = None
    cover_letter_template_ready: bool = False
    profile_work_count: int = 0
    validation_errors: list[str] = Field(default_factory=list)


class UserSettingsUpdateRequest(BaseModel):
    openai_key_mode: str | None = Field(default=None, pattern="^(default|custom)$")
    openai_api_key: str | None = Field(default=None, max_length=512)
    clear_openai_api_key: bool = False
    dedup_recycle_mode: str | None = Field(default=None, pattern="^(default|custom)$")
    dedup_recycle_days: int | None = Field(default=None, ge=1, le=3650)
    min_match_score_mode: str | None = Field(default=None, pattern="^(default|custom)$")
    min_match_score: int | None = Field(default=None, ge=0, le=100)
    resume_tailoring_prompt_mode: str | None = Field(default=None, pattern="^(default|custom)$")
    resume_tailoring_prompt_custom: str | None = Field(default=None, max_length=12000)
    cover_letter_prompt_mode: str | None = Field(default=None, pattern="^(default|custom)$")
    cover_letter_prompt_custom: str | None = Field(default=None, max_length=12000)


class OpenAiKeyTestRequest(BaseModel):
    """Test a key before save. Omit openai_api_key to test the user's stored custom key."""
    openai_api_key: str | None = Field(default=None, max_length=512)


class OpenAiKeyTestResponse(BaseModel):
    ok: bool
    message: str


class MinMatchScorePreviewSample(BaseModel):
    job_id: str
    title: str | None = None
    company: str | None = None
    match_score: int


class MinMatchScorePreviewRequest(BaseModel):
    """Preview using draft values from the settings form (unsaved OK)."""
    min_match_score_mode: str = Field(..., pattern="^(default|custom)$")
    min_match_score: int | None = Field(default=None, ge=0, le=100)


class MinMatchScorePreviewResponse(BaseModel):
    threshold: int
    threshold_mode: str
    analyzed_visible_count: int
    would_hide_count: int
    meeting_threshold_count: int
    already_hidden_count: int
    would_restore_count: int
    samples: list[MinMatchScorePreviewSample]


class MinMatchScoreApplyRequest(BaseModel):
    min_match_score_mode: str = Field(..., pattern="^(default|custom)$")
    min_match_score: int | None = Field(default=None, ge=0, le=100)


class MinMatchScoreApplyResponse(BaseModel):
    success: bool
    min_match_score: int
    hidden: int
    restored: int
    settings: UserSettingsResponse


def _resolve_draft_min_match_score(mode: str, score: int | None) -> int:
    from app.core.config import get_settings
    from app.storage.user_repository import UserRepository

    settings = get_settings()
    if mode == "default":
        return settings.default_min_match_score
    return UserRepository._clamp_min_match_score(score)


@router.post(
    "/settings/min-match-score/preview",
    response_model=MinMatchScorePreviewResponse,
    dependencies=[Depends(get_current_user)],
)
async def preview_min_match_score(
    body: MinMatchScorePreviewRequest,
    current_user: dict = Depends(get_current_user),
) -> MinMatchScorePreviewResponse:
    """Count analyzed jobs in the active dashboard that score below the draft threshold."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    if body.min_match_score_mode == "custom" and body.min_match_score is None:
        raise HTTPException(status_code=400, detail="min_match_score is required for custom mode.")

    threshold = _resolve_draft_min_match_score(body.min_match_score_mode, body.min_match_score)
    from app.services.min_match_score_reconcile import preview_min_match_score_for_user

    data = await preview_min_match_score_for_user(user_id, threshold)
    return MinMatchScorePreviewResponse(threshold_mode=body.min_match_score_mode, **data)


@router.post(
    "/settings/min-match-score/apply",
    response_model=MinMatchScoreApplyResponse,
    dependencies=[Depends(get_current_user)],
)
async def apply_min_match_score(
    body: MinMatchScoreApplyRequest,
    current_user: dict = Depends(get_current_user),
) -> MinMatchScoreApplyResponse:
    """Save threshold settings and hide/restore existing analyzed jobs accordingly."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    if body.min_match_score_mode == "custom" and body.min_match_score is None:
        raise HTTPException(status_code=400, detail="min_match_score is required for custom mode.")

    threshold = _resolve_draft_min_match_score(body.min_match_score_mode, body.min_match_score)

    async with get_session() as session:
        user_repo = UserRepository(session)
        try:
            settings_data = await user_repo.update_user_settings(
                user_id,
                min_match_score_mode=body.min_match_score_mode,
                min_match_score=body.min_match_score if body.min_match_score_mode == "custom" else None,
            )
            await session.commit()
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    if not settings_data:
        raise HTTPException(status_code=404, detail="User not found")

    from app.services.min_match_score_reconcile import reconcile_min_match_score_for_user
    result = await reconcile_min_match_score_for_user(user_id, threshold)

    logger.info(
        "min_match_score_applied",
        user_id=user_id,
        threshold=threshold,
        hidden=result["hidden"],
        restored=result["restored"],
    )
    return MinMatchScoreApplyResponse(
        success=True,
        min_match_score=threshold,
        hidden=result["hidden"],
        restored=result["restored"],
        settings=UserSettingsResponse(**settings_data),
    )


@router.post(
    "/settings/openai/test",
    response_model=OpenAiKeyTestResponse,
    dependencies=[Depends(get_current_user)],
)
async def test_openai_key_endpoint(
    body: OpenAiKeyTestRequest,
    current_user: dict = Depends(get_current_user),
) -> OpenAiKeyTestResponse:
    from app.services.openai_key_test import test_openai_api_key
    from app.utils.secret_encryption import decrypt_secret

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    key_to_test = (body.openai_api_key or "").strip()
    if not key_to_test:
        async with get_session() as session:
            user_repo = UserRepository(session)
            user = await user_repo.get_by_id(user_id)
            if not user or not user.openai_api_key_encrypted:
                raise HTTPException(
                    status_code=400,
                    detail="Enter an API key to test, or save one first.",
                )
            try:
                key_to_test = decrypt_secret(user.openai_api_key_encrypted)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))

    ok, message = await test_openai_api_key(key_to_test)
    return OpenAiKeyTestResponse(ok=ok, message=message)


@router.get(
    "/settings",
    response_model=UserSettingsResponse,
    dependencies=[Depends(get_current_user)],
)
async def get_user_settings(
    current_user: dict = Depends(get_current_user),
) -> UserSettingsResponse:
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    async with get_session() as session:
        user_repo = UserRepository(session)
        data = await user_repo.get_user_settings(user_id)
    if not data:
        raise HTTPException(status_code=404, detail="User not found")
    return UserSettingsResponse(**data)


@router.put(
    "/settings",
    response_model=UserSettingsResponse,
    dependencies=[Depends(get_current_user)],
)
async def update_user_settings(
    body: UserSettingsUpdateRequest,
    current_user: dict = Depends(get_current_user),
) -> UserSettingsResponse:
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    async with get_session() as session:
        user_repo = UserRepository(session)
        try:
            data = await user_repo.update_user_settings(
                user_id,
                openai_key_mode=body.openai_key_mode,
                openai_api_key=body.openai_api_key,
                clear_openai_api_key=body.clear_openai_api_key,
                dedup_recycle_mode=body.dedup_recycle_mode,
                dedup_recycle_days=body.dedup_recycle_days,
                min_match_score_mode=body.min_match_score_mode,
                min_match_score=body.min_match_score,
                resume_tailoring_prompt_mode=body.resume_tailoring_prompt_mode,
                resume_tailoring_prompt_custom=body.resume_tailoring_prompt_custom,
                cover_letter_prompt_mode=body.cover_letter_prompt_mode,
                cover_letter_prompt_custom=body.cover_letter_prompt_custom,
            )
            await session.commit()
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
    if not data:
        raise HTTPException(status_code=404, detail="User not found")

    logger.info("user_settings_saved", user_id=user_id)
    return UserSettingsResponse(**data)


@router.get(
    "/settings/resume-template/requirements",
    dependencies=[Depends(get_current_user)],
)
async def get_resume_template_requirements(
    current_user: dict = Depends(get_current_user),
):
    from app.models.resume_template_schemas import ResumeTemplateRequirementsResponse
    from app.services.resume_template_requirements import get_template_requirements
    from app.services.resume_template_service import count_work_roles

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    async with get_session() as session:
        user_repo = UserRepository(session)
        user = await user_repo.get_by_id(user_id)
    profile_work_count = count_work_roles(user) if user else 0
    return ResumeTemplateRequirementsResponse(
        **get_template_requirements(user=user, profile_work_count=profile_work_count).model_dump()
    )


@router.get(
    "/settings/resume-template",
    dependencies=[Depends(get_current_user)],
)
async def get_resume_template_status(
    current_user: dict = Depends(get_current_user),
):
    from app.models.resume_template_schemas import ResumeTemplateStatusResponse
    from app.services.resume_template_service import template_status_payload

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    async with get_session() as session:
        user_repo = UserRepository(session)
        user = await user_repo.get_by_id(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return ResumeTemplateStatusResponse(**template_status_payload(user))


@router.post(
    "/settings/resume-template/upload",
    dependencies=[Depends(get_current_user)],
)
async def upload_resume_template(
    file: UploadFile = File(...),
    current_user: dict = Depends(get_current_user),
):
    from app.models.resume_template_schemas import ResumeTemplateStatusResponse
    from app.services.resume_template_service import (
        save_uploaded_template,
        schedule_template_analysis,
        template_status_payload,
    )

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    raw = await file.read()
    filename = file.filename or "template.docx"
    try:
        await save_uploaded_template(user_id, raw, filename)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    await schedule_template_analysis(user_id, reason="upload")

    async with get_session() as session:
        user_repo = UserRepository(session)
        user = await user_repo.get_by_id(user_id)
    return ResumeTemplateStatusResponse(**template_status_payload(user))


@router.put(
    "/settings/resume-template/blueprint",
    dependencies=[Depends(get_current_user)],
)
async def update_resume_template_blueprint(
    body: ResumeTemplateBlueprintUpdateRequest,
    current_user: dict = Depends(get_current_user),
):
    from app.models.resume_template_schemas import ResumeTemplateStatusResponse
    from app.services.resume_template_service import update_user_blueprint

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        payload = await update_user_blueprint(user_id, body.blueprint)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return ResumeTemplateStatusResponse(**payload)


@router.post(
    "/settings/resume-template/reanalyze",
    dependencies=[Depends(get_current_user)],
)
async def reanalyze_resume_template(
    current_user: dict = Depends(get_current_user),
):
    from app.models.resume_template_schemas import ResumeTemplateStatusResponse
    from app.services.resume_template_service import (
        schedule_template_analysis,
        template_status_payload,
    )

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    async with get_session() as session:
        user_repo = UserRepository(session)
        user = await user_repo.get_by_id(user_id)
        if not user or not getattr(user, "resume_template_source_path", None):
            raise HTTPException(status_code=400, detail="Upload a template before re-analyzing.")

    await schedule_template_analysis(user_id, reason="manual_reanalyze")

    async with get_session() as session:
        user_repo = UserRepository(session)
        user = await user_repo.get_by_id(user_id)
    return ResumeTemplateStatusResponse(**template_status_payload(user))


@router.get(
    "/settings/resume-template/variables",
    dependencies=[Depends(get_current_user)],
)
async def list_resume_template_variables(
    current_user: dict = Depends(get_current_user),
):
    from app.services.resume_variable_registry import list_template_variables

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return {"variables": list_template_variables()}


@router.post(
    "/settings/resume-template/preview",
    dependencies=[Depends(get_current_user)],
)
async def preview_resume_template(
    current_user: dict = Depends(get_current_user),
):
    from app.services.resume_template_service import generate_template_preview_docx

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        preview_path = await generate_template_preview_docx(user_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("resume_template_preview_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail="Failed to generate preview.")

    return FileResponse(
        path=str(preview_path),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename="resume-template-preview.docx",
    )


@router.get(
    "/settings/cover-letter-prompt/defaults",
    dependencies=[Depends(get_current_user)],
)
async def get_cover_letter_prompt_defaults_endpoint(
    current_user: dict = Depends(get_current_user),
):
    from app.models.cover_letter_prompt_schemas import CoverLetterPromptDefaultsResponse
    from app.prompts.cover_letter_prompt import get_cover_letter_prompt_defaults

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return CoverLetterPromptDefaultsResponse(**get_cover_letter_prompt_defaults())


@router.get(
    "/settings/cover-letter-template/requirements",
    dependencies=[Depends(get_current_user)],
)
async def get_cover_letter_template_requirements(
    current_user: dict = Depends(get_current_user),
):
    from app.models.cover_letter_template_schemas import CoverLetterTemplateRequirements
    from app.services.cover_letter_template_service import get_cover_letter_requirements

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return CoverLetterTemplateRequirements.model_validate(get_cover_letter_requirements())


@router.get(
    "/settings/cover-letter-template",
    dependencies=[Depends(get_current_user)],
)
async def get_cover_letter_template_status(
    current_user: dict = Depends(get_current_user),
):
    from app.models.cover_letter_template_schemas import CoverLetterTemplateStatusResponse
    from app.services.cover_letter_template_service import template_status_payload

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    async with get_session() as session:
        user_repo = UserRepository(session)
        user = await user_repo.get_by_id(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return CoverLetterTemplateStatusResponse(**template_status_payload(user))


@router.post(
    "/settings/cover-letter-template/upload",
    dependencies=[Depends(get_current_user)],
)
async def upload_cover_letter_template(
    file: UploadFile = File(...),
    current_user: dict = Depends(get_current_user),
):
    from app.models.cover_letter_template_schemas import CoverLetterTemplateStatusResponse
    from app.services.cover_letter_template_service import save_uploaded_cover_letter_template

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    raw = await file.read()
    filename = file.filename or "cover_letter_template.docx"
    try:
        payload = await save_uploaded_cover_letter_template(user_id, raw, filename)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return CoverLetterTemplateStatusResponse(**payload)


@router.post(
    "/settings/cover-letter-template/revalidate",
    dependencies=[Depends(get_current_user)],
)
async def revalidate_cover_letter_template(
    current_user: dict = Depends(get_current_user),
):
    from app.models.cover_letter_template_schemas import CoverLetterTemplateStatusResponse
    from app.services.cover_letter_template_service import revalidate_cover_letter_template as revalidate

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        payload = await revalidate(user_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return CoverLetterTemplateStatusResponse(**payload)


@router.post(
    "/settings/cover-letter-template/preview",
    dependencies=[Depends(get_current_user)],
)
async def preview_cover_letter_template(
    current_user: dict = Depends(get_current_user),
):
    from app.services.cover_letter_template_service import generate_cover_letter_preview_docx

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        preview_path = await generate_cover_letter_preview_docx(user_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("cover_letter_template_preview_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail="Failed to generate preview.")

    return FileResponse(
        path=str(preview_path),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename="cover-letter-template-preview.docx",
    )


@router.get(
    "/settings/dedup",
    response_model=DeduplicationSettingsResponse,
    dependencies=[Depends(get_current_user)],
)
async def get_dedup_settings(
    current_user: dict = Depends(get_current_user),
) -> DeduplicationSettingsResponse:
    """Get the current user's deduplication recycle settings."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    async with get_session() as session:
        user_repo = UserRepository(session)
        days = await user_repo.get_effective_dedup_recycle_days(user_id)
    return DeduplicationSettingsResponse(dedup_recycle_days=days)


@router.put(
    "/settings/dedup",
    response_model=DeduplicationSettingsResponse,
    dependencies=[Depends(get_current_user)],
)
async def update_dedup_settings(
    body: DeduplicationSettingsRequest,
    current_user: dict = Depends(get_current_user),
) -> DeduplicationSettingsResponse:
    """Update the current user's deduplication recycle window.

    The recycle period controls how many days must pass since an old job's
    posting date before a new posting at the same company is treated as fresh
    (not automatically excluded even if you previously applied there or had a
    higher-scoring match elsewhere at that company).  Default is 60 days.
    """
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    async with get_session() as session:
        user_repo = UserRepository(session)
        data = await user_repo.update_user_settings(
            user_id,
            dedup_recycle_days=body.dedup_recycle_days,
            dedup_recycle_mode="custom",
        )
        await session.commit()
    if not data:
        raise HTTPException(status_code=404, detail="User not found")
    days = data["dedup_recycle_days"]
    logger.info("dedup_settings_updated", user_id=user_id, days=days)
    return DeduplicationSettingsResponse(dedup_recycle_days=days)


@router.post(
    "/jobs/valid/reconcile-min-match-score",
    dependencies=[Depends(get_current_user)],
)
async def reconcile_min_match_score(
    current_user: dict = Depends(get_current_user),
) -> dict:
    """Re-apply the user's minimum match score to all existing analyzed jobs."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    async with get_session() as session:
        user_repo = UserRepository(session)
        min_score = await user_repo.get_effective_min_match_score(user_id)

    from app.services.min_match_score_reconcile import reconcile_min_match_score_for_user
    return await reconcile_min_match_score_for_user(user_id, min_score)


@router.post(
    "/jobs/valid/reconcile-company-policy",
    dependencies=[Depends(get_current_user)],
    status_code=status.HTTP_202_ACCEPTED,
)
async def reconcile_company_policy_for_user(
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """Stub — company-policy reconciliation is now handled by the post-analysis dedup service."""
    return {"success": True, "status": "noop", "message": "Dedup is now handled by the save queue"}


@router.post("/jobs/invalid/{job_id}/promote-to-valid", dependencies=[Depends(get_current_user)])
async def promote_invalid_to_valid(
    job_id: str,
    request: PromoteInvalidRequest,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """
    Promote a duplicated/hidden job back to the user's active list.
    Updates the UserJobStatus to 'active' and re-enqueues extraction if needed.
    """
    reason_clean = sanitize_for_postgres_text(request.reason.strip())
    if not reason_clean:
        raise HTTPException(status_code=400, detail="Reason is required")
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    async with get_session() as session:
        # job_id here is either the UserJobStatus.id or a Job.id — try both
        ujs_repo = UserJobStatusRepository(session)

        # Try as UserJobStatus.id first
        ujs_result = await session.execute(
            select(UserJobStatus).where(UserJobStatus.id == job_id, UserJobStatus.user_id == user_id)
        )
        ujs = ujs_result.scalar_one_or_none()

        if ujs:
            actual_job_id = ujs.job_id
        else:
            # Fall back: treat job_id as a Job.id
            actual_job_id = job_id

        job_result = await session.execute(select(Job).where(Job.id == actual_job_id))
        job = job_result.scalar_one_or_none()
        if not job:
            logger.warning("promote_invalid_not_found", job_id=job_id)
            raise HTTPException(status_code=404, detail="Job not found")

        block_reason = _check_domain_blocked(job.domain)
        if block_reason:
            raise HTTPException(status_code=400, detail=block_reason)

        meta = dict(job.raw_metadata or {})
        promoted_at_iso = _utcnow().isoformat()
        meta["promotion_reason"] = reason_clean
        meta["promoted_at"] = promoted_at_iso
        meta["promoted_by_user_id"] = user_id
        sub_email = current_user.get("sub")
        if sub_email:
            meta["promoted_by_email"] = str(sub_email).strip()
        promoter_repo = UserRepository(session)
        promoter = await promoter_repo.get_by_id(user_id)
        if promoter and promoter.name and str(promoter.name).strip():
            meta["promoted_by_name"] = str(promoter.name).strip()
        job.raw_metadata = meta

        await ujs_repo.upsert(user_id=user_id, job_id=actual_job_id, status="active")
        await session.commit()

        extraction_id = job.extraction_id
        source_url = job.source_url

    # Re-enqueue extraction if needed
    if extraction_id:
        async with get_session() as session:
            ext_repo = JobExtractionRepository(session)
            extraction = await ext_repo.get_by_id(extraction_id)
            if extraction and extraction.status != ExtractionStatus.COMPLETED:
                await enqueue_extraction(
                    extraction_id, source_url, user_id=user_id, background_tasks=background_tasks
                )
            elif extraction and extraction.status == ExtractionStatus.COMPLETED:
                existing_match = await session.execute(
                    select(JobMatchResult).where(
                        JobMatchResult.job_id == actual_job_id,
                        JobMatchResult.user_id == user_id,
                    )
                )
                existing_progress = await session.execute(
                    select(JobMatchInProgress).where(
                        JobMatchInProgress.job_id == actual_job_id,
                        JobMatchInProgress.user_id == user_id,
                    )
                )
                if not existing_match.scalar_one_or_none() and not existing_progress.scalar_one_or_none():
                    progress_repo = JobMatchInProgressRepository(session)
                    await progress_repo.add(actual_job_id, user_id)
                    await session.commit()
                    await enqueue_job_match_analysis(
                        actual_job_id, user_id, background_tasks=background_tasks
                    )
    else:
        # No extraction yet — create one and enqueue
        async with get_session() as session:
            job_result = await session.execute(select(Job).where(Job.id == actual_job_id))
            job = job_result.scalar_one_or_none()
            if job:
                ext_repo = JobExtractionRepository(session)
                extraction = await ext_repo.create(
                    source_url=source_url,
                    normalized_url=source_url,
                    domain=job.domain,
                )
                job.extraction_id = extraction.id
                await session.commit()
                await enqueue_extraction(
                    extraction.id, source_url, user_id=user_id, background_tasks=background_tasks
                )

    logger.info("promote_invalid_to_valid_success", job_id=actual_job_id, user_id=user_id)
    return {"success": True, "job_id": actual_job_id}


@router.get("/jobs/stats", dependencies=[Depends(get_current_user)])
async def get_job_stats(current_user: dict = Depends(get_current_user)) -> dict:
    """Get statistics about active and duplicated/hidden jobs for the current user."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    async with get_session() as session:
        valid_count = (await session.execute(
            select(func.count()).select_from(UserJobStatus).where(
                UserJobStatus.user_id == user_id,
                UserJobStatus.status == "active",
            )
        )).scalar_one()

        invalid_count = (await session.execute(
            select(func.count()).select_from(UserJobStatus).where(
                UserJobStatus.user_id == user_id,
                UserJobStatus.status.in_(["duplicated", "manual_hidden"]),
            )
        )).scalar_one()

        logger.debug("get_job_stats", valid_count=valid_count, invalid_count=invalid_count)
        return {
            "valid_jobs_count": valid_count,
            "invalid_jobs_count": invalid_count,
            "total_jobs": valid_count + invalid_count
        }


@router.patch("/jobs/valid/{job_id}/url", dependencies=[Depends(get_current_user)])
async def update_valid_job_url(job_id: str, request: JobUrlUpdateRequest) -> dict:
    is_valid, error = URLManager.validate_url(request.url)
    if not is_valid:
        logger.warning("update_valid_job_url_invalid", job_id=job_id, error=error)
        raise HTTPException(status_code=400, detail=f"Invalid URL: {error}")

    async with get_session() as session:
        result = await session.execute(select(Job).where(Job.id == job_id))
        job = result.scalar_one_or_none()
        if not job:
            logger.warning("update_valid_job_url_not_found", job_id=job_id)
            raise HTTPException(status_code=404, detail="Valid job not found")

        job.source_url = request.url
        job.normalized_url = request.url
        job.domain = URLManager.extract_domain(request.url)
        job.extraction_id = None
        job.scraped_at = None
        job.updated_at = _utcnow()

        try:
            await session.commit()
            logger.info("update_valid_job_url_success", job_id=job_id, url=request.url)
        except IntegrityError:
            await session.rollback()
            logger.warning("update_valid_job_url_conflict", job_id=job_id, url=request.url)
            raise HTTPException(status_code=409, detail="URL already exists")

        return {"success": True}


@router.patch("/jobs/invalid/{job_id}/url", dependencies=[Depends(get_current_user)])
async def update_invalid_job_url(
    job_id: str,
    request: JobUrlUpdateRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """Update the URL of a Job record (looked up via UserJobStatus id or job id)."""
    is_valid, error = URLManager.validate_url(request.url)
    if not is_valid:
        logger.warning("update_invalid_job_url_invalid", job_id=job_id, error=error)
        raise HTTPException(status_code=400, detail=f"Invalid URL: {error}")

    user_id = current_user.get("user_id")
    async with get_session() as session:
        # Try as UserJobStatus id first, fall back to Job id
        actual_job_id = job_id
        if user_id:
            ujs_result = await session.execute(
                select(UserJobStatus.job_id).where(UserJobStatus.id == job_id, UserJobStatus.user_id == user_id)
            )
            ujs_job_id = ujs_result.scalar_one_or_none()
            if ujs_job_id:
                actual_job_id = ujs_job_id

        result = await session.execute(select(Job).where(Job.id == actual_job_id))
        job = result.scalar_one_or_none()
        if not job:
            logger.warning("update_invalid_job_url_not_found", job_id=job_id)
            raise HTTPException(status_code=404, detail="Job not found")

        job.source_url = request.url
        job.normalized_url = request.url
        job.domain = URLManager.extract_domain(request.url)
        job.updated_at = _utcnow()

        try:
            await session.commit()
            logger.info("update_invalid_job_url_success", job_id=actual_job_id, url=request.url)
        except IntegrityError:
            await session.rollback()
            logger.warning("update_invalid_job_url_conflict", job_id=actual_job_id, url=request.url)
            raise HTTPException(status_code=409, detail="URL already exists")

        return {"success": True}


@router.post("/jobs/valid/{job_id}/report-invalid", dependencies=[Depends(get_current_user)])
async def report_valid_as_invalid(
    job_id: str,
    request: JobReportRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    async with get_session() as session:
        result = await session.execute(select(Job).where(Job.id == job_id))
        job = result.scalar_one_or_none()
        if not job:
            logger.warning("report_valid_as_invalid_not_found", job_id=job_id)
            raise HTTPException(status_code=404, detail="Valid job not found")

        reason = request.duplication_reason or "Manually hidden from your active job list"
        ujs_repo = UserJobStatusRepository(session)
        await ujs_repo.upsert(
            user_id=user_id,
            job_id=job_id,
            status="manual_hidden",
            exclusion_type="manual_invalid",
            reason=reason[:1500],
        )
        await session.commit()
        logger.info("report_valid_as_invalid_user_status", job_id=job_id, user_id=user_id)
        return {"success": True, "exclusion_type": "manual_invalid"}


@router.post("/jobs/valid/{job_id}/report-duplicate", dependencies=[Depends(get_current_user)])
async def report_valid_as_duplicate(
    job_id: str,
    request: JobReportRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    async with get_session() as session:
        result = await session.execute(select(Job).where(Job.id == job_id))
        job = result.scalar_one_or_none()
        if not job:
            logger.warning("report_valid_as_duplicate_not_found", job_id=job_id)
            raise HTTPException(status_code=404, detail="Valid job not found")

        reason = request.duplication_reason or "Manually marked as duplicate for your account"
        ujs_repo = UserJobStatusRepository(session)
        await ujs_repo.upsert(
            user_id=user_id,
            job_id=job_id,
            status="duplicated",
            exclusion_type="manual_duplicate",
            duplicated_because_id=request.duplicate_of_job_id,
            reason=reason[:1500],
        )
        await session.commit()
        logger.info(
            "report_valid_as_duplicate_user_status",
            job_id=job_id,
            user_id=user_id,
            duplicate_of=request.duplicate_of_job_id,
        )
        return {"success": True, "exclusion_type": "manual_duplicate"}


@router.post("/jobs/invalid/{job_id}/report-invalid", dependencies=[Depends(get_current_user)])
async def report_invalid_as_invalid(
    job_id: str,
    request: JobReportRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """Update an existing UserJobStatus entry's reason and exclusion_type to manual_invalid."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    async with get_session() as session:
        ujs_repo = UserJobStatusRepository(session)
        # Try as UserJobStatus.id first
        ujs_result = await session.execute(
            select(UserJobStatus).where(UserJobStatus.id == job_id, UserJobStatus.user_id == user_id)
        )
        ujs = ujs_result.scalar_one_or_none()
        if not ujs:
            # Fall back: treat job_id as Job.id
            ujs = await ujs_repo.get(user_id, job_id)
        if not ujs:
            logger.warning("report_invalid_as_invalid_not_found", job_id=job_id)
            raise HTTPException(status_code=404, detail="Job status entry not found")

        ujs.exclusion_type = "manual_invalid"
        ujs.reason = request.duplication_reason or "Manually reported as invalid job"
        ujs.duplicated_because_id = None
        ujs.updated_at = _utcnow()
        await session.commit()
        logger.info("report_invalid_as_invalid_success", job_id=job_id)
        return {"success": True}


@router.post("/jobs/invalid/{job_id}/report-duplicate", dependencies=[Depends(get_current_user)])
async def report_invalid_as_duplicate(
    job_id: str,
    request: JobReportRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """Update an existing UserJobStatus entry's reason and exclusion_type to manual_duplicate."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    async with get_session() as session:
        ujs_repo = UserJobStatusRepository(session)
        ujs_result = await session.execute(
            select(UserJobStatus).where(UserJobStatus.id == job_id, UserJobStatus.user_id == user_id)
        )
        ujs = ujs_result.scalar_one_or_none()
        if not ujs:
            ujs = await ujs_repo.get(user_id, job_id)
        if not ujs:
            logger.warning("report_invalid_as_duplicate_not_found", job_id=job_id)
            raise HTTPException(status_code=404, detail="Job status entry not found")

        ujs.exclusion_type = "manual_duplicate"
        ujs.duplicated_because_id = request.duplicate_of_job_id
        ujs.reason = request.duplication_reason or "Manually reported as duplicated job"
        ujs.updated_at = _utcnow()
        await session.commit()
        logger.info("report_invalid_as_duplicate_success", job_id=job_id, duplicate_of=request.duplicate_of_job_id)
        return {"success": True}


@router.post("/jobs/valid/delete/batch", dependencies=[Depends(get_current_user)])
async def batch_delete_valid_jobs(body: dict) -> dict:
    """Delete multiple valid jobs in a single request."""
    job_ids = body.get("job_ids", [])
    if not job_ids:
        return {"deleted": 0}
    deleted = 0
    async with get_session() as session:
        for jid in job_ids:
            ok = await _purge_job_cascade(session, jid)
            if ok:
                deleted += 1
        await session.commit()
    logger.info("batch_delete_valid_jobs", deleted=deleted, requested=len(job_ids))
    return {"deleted": deleted}


@router.delete("/jobs/valid/{job_id}", dependencies=[Depends(get_current_user)])
async def delete_valid_job(job_id: str) -> dict:
    async with get_session() as session:
        ext_row = await session.execute(select(Job.extraction_id).where(Job.id == job_id))
        extraction_id = ext_row.scalar_one_or_none()
        ok = await _purge_job_cascade(session, job_id)
        if not ok:
            logger.warning("delete_valid_job_not_found", job_id=job_id)
            raise HTTPException(status_code=404, detail="Valid job not found")

        await session.commit()
        logger.info(
            "delete_valid_job_success",
            job_id=job_id,
            extraction_deleted=bool(extraction_id),
        )
        return {"success": True}


@router.delete("/jobs/invalid/{job_id}", dependencies=[Depends(get_current_user)])
async def delete_invalid_job(
    job_id: str,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """Delete a UserJobStatus row for this user (removes the duplicated/hidden entry)."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    async with get_session() as session:
        # Try as UserJobStatus.id first
        ujs_result = await session.execute(
            select(UserJobStatus).where(UserJobStatus.id == job_id, UserJobStatus.user_id == user_id)
        )
        ujs = ujs_result.scalar_one_or_none()
        if ujs:
            await session.delete(ujs)
        else:
            ujs_repo = UserJobStatusRepository(session)
            deleted = await ujs_repo.delete(user_id, job_id)
            if not deleted:
                logger.warning("delete_invalid_job_not_found", job_id=job_id)
                raise HTTPException(status_code=404, detail="Job status entry not found")

        await session.commit()
        logger.info("delete_invalid_job_success", job_id=job_id)
        return {"success": True}


@router.post("/jobs/invalid/delete/batch", dependencies=[Depends(get_current_user)])
async def delete_invalid_jobs_batch(
    body: DuplicatedJobStatusBatchRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """Delete UserJobStatus rows for this user in batch."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    ids = list(dict.fromkeys(i for i in body.user_job_status_ids if i and str(i).strip()))
    if not ids:
        raise HTTPException(status_code=400, detail="No IDs provided")

    async with get_session() as session:
        deleted = 0
        for ujs_id in ids:
            ujs_result = await session.execute(
                select(UserJobStatus).where(UserJobStatus.id == ujs_id, UserJobStatus.user_id == user_id)
            )
            ujs = ujs_result.scalar_one_or_none()
            if ujs:
                await session.delete(ujs)
                deleted += 1

        await session.commit()
    logger.info(
        "delete_invalid_jobs_batch",
        deleted=deleted,
        requested=len(ids),
    )
    return {
        "success": True,
        "deleted": deleted,
    }


@router.post("/jobs/invalid/dismiss/batch", dependencies=[Depends(get_current_user)])
async def dismiss_duplicates_batch(
    body: DismissDuplicatesBatchRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """Hide duplicate-list entries for this user by setting status='manual_hidden'."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    entry_ids = list(dict.fromkeys(eid for eid in body.user_job_status_ids if eid and str(eid).strip()))
    if not entry_ids:
        raise HTTPException(status_code=400, detail="No entry IDs provided")

    async with get_session() as session:
        updated = 0
        for eid in entry_ids:
            ujs_result = await session.execute(
                select(UserJobStatus).where(
                    UserJobStatus.id == eid,
                    UserJobStatus.user_id == user_id,
                )
            )
            ujs = ujs_result.scalar_one_or_none()
            if ujs and ujs.status != "manual_hidden":
                ujs.status = "manual_hidden"
                ujs.updated_at = _utcnow()
                updated += 1

        await session.commit()

    logger.info(
        "dismiss_duplicates_batch",
        user_id=user_id,
        requested=len(entry_ids),
        updated=updated,
    )
    return {"success": True, "dismissed": updated}


# ── Resume build endpoints ─────────────────────────────────────────────────

@router.get(
    "/jobs/valid/{job_id}/resume-build",
    response_model=ResumeBuildStatusResponse,
    dependencies=[Depends(get_current_user)],
)
async def get_resume_build_status(
    job_id: str,
    current_user: dict = Depends(get_current_user),
) -> ResumeBuildStatusResponse:
    """Return current resume/cover letter build status for a valid job."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    async with get_session() as session:
        repo = ResumeBuildRepository(session)
        row = await repo.get(job_id, user_id)
        if not row:
            raise HTTPException(status_code=404, detail="No resume build found for this job")

        return ResumeBuildStatusResponse(
            job_id=row.job_id,
            content_generation_status=getattr(row, "content_generation_status", None) or "pending",
            content_generation_error=getattr(row, "content_generation_error", None),
            resume_docx_status=row.resume_docx_status,
            resume_pdf_status=row.resume_pdf_status,
            cover_letter_docx_status=row.cover_letter_docx_status,
            cover_letter_pdf_status=row.cover_letter_pdf_status,
            output_directory=row.output_directory,
            error_message=row.error_message,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )


@router.post(
    "/jobs/valid/{job_id}/resume-build/trigger",
    dependencies=[Depends(get_current_user)],
)
async def trigger_resume_build(
    job_id: str,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """Manually (re-)trigger tailored content generation or resume DOCX/PDF build."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    async with get_session() as session:
        repo = ResumeBuildRepository(session)
        row = await repo.get(job_id, user_id)

    if row and row.tailored_resume_data:
        async with get_session() as session:
            repo = ResumeBuildRepository(session)
            await repo.upsert(job_id, user_id, row.tailored_resume_data, row.cover_letter_data)
            await session.commit()
        from app.tasks.worker import get_resume_build_pool
        pool = await get_resume_build_pool()
        await pool.enqueue_job("build_resume_task", job_id, user_id)
        return {"success": True, "message": "Resume build enqueued"}

    from app.services.job_match_orchestrator import enqueue_tailored_content_generation
    enqueued = await enqueue_tailored_content_generation(job_id, user_id)
    if not enqueued:
        raise HTTPException(
            status_code=503,
            detail="Could not queue tailored content generation. Ensure Redis and analysis worker are running.",
        )
    return {"success": True, "message": "Tailored content generation enqueued"}


@router.get(
    "/jobs/valid/{job_id}/resume-build/download/{file_type}",
    dependencies=[Depends(get_current_user)],
)
async def download_resume_file(
    job_id: str,
    file_type: str,
    current_user: dict = Depends(get_current_user),
):
    """Download a generated resume or cover letter file."""
    from fastapi.responses import FileResponse
    from pathlib import Path

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    valid_types = {"resume_docx", "resume_pdf", "cover_letter_docx", "cover_letter_pdf"}
    if file_type not in valid_types:
        raise HTTPException(status_code=400, detail=f"Invalid file_type. Must be one of: {valid_types}")

    async with get_session() as session:
        repo = ResumeBuildRepository(session)
        row = await repo.get(job_id, user_id)
        if not row:
            raise HTTPException(status_code=404, detail="No resume build found")

    path_col = f"{file_type}_path"
    file_path = getattr(row, path_col, None)
    if not file_path:
        raise HTTPException(status_code=404, detail=f"{file_type} not generated yet")

    p = Path(file_path)
    if not p.exists():
        raise HTTPException(status_code=404, detail="File not found on disk")

    media_type = "application/pdf" if file_type.endswith("_pdf") else "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    return FileResponse(path=str(p), filename=p.name, media_type=media_type)


# ---------------------------------------------------------------------------
# Google Sheets integration
# ---------------------------------------------------------------------------

class SheetsConfigRequest(BaseModel):
    spreadsheet_url: str
    tab_groups: list[list[str]] = Field(default_factory=list)
    auto_post_threshold: int = 75


class SheetsPostJobsRequest(BaseModel):
    job_ids: list[str] = Field(..., min_length=1, max_length=200)


class SheetsAutoPostThresholdRequest(BaseModel):
    auto_post_threshold: int = Field(ge=0, le=100)


@router.get("/sheets/status", dependencies=[Depends(get_current_user)])
async def get_sheets_status():
    """Server-side Google Sheets credentials readiness."""
    from app.services.google_sheets_service import get_server_status

    return get_server_status()


@router.get("/sheets/tabs", dependencies=[Depends(get_current_user)])
async def get_sheets_tabs(url: str = Query(..., min_length=10)):
    """Verify spreadsheet access and fetch all tab names."""
    from app.services.google_sheets_service import SpreadsheetAccessError, verify_spreadsheet

    try:
        return await verify_spreadsheet(url)
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail="Google credentials file not configured. " + str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except SpreadsheetAccessError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:
        logger.error("sheets_get_tabs_failed", error=str(e))
        raise HTTPException(status_code=502, detail=f"Could not read spreadsheet: {e}")


@router.get("/sheets/config", dependencies=[Depends(get_current_user)])
async def get_sheets_config(current_user: dict = Depends(get_current_user)):
    """Get user's Google Sheets integration config."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    from app.services.google_sheets_service import get_user_config
    config = await get_user_config(user_id)
    if not config:
        return {"configured": False}
    tab_groups = config.tab_groups or []
    assigned_tabs = [t for group in tab_groups for t in group]
    return {
        "configured": True,
        "spreadsheet_url": config.spreadsheet_url,
        "tab_groups": tab_groups,
        "auto_post_threshold": config.auto_post_threshold,
        "group_count": len(tab_groups),
        "assigned_tab_count": len(assigned_tabs),
    }


@router.post("/sheets/config", dependencies=[Depends(get_current_user)])
async def save_sheets_config(
    body: SheetsConfigRequest,
    current_user: dict = Depends(get_current_user),
):
    """Save or update user's Google Sheets integration config."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    from app.services.google_sheets_service import (
        save_config,
        get_all_tabs,
        _resolve_worksheet_name,
        _canonicalize_tab_groups,
    )

    # get_all_tabs uses a 60-second TTL cache, so this won't make a fresh API
    # call if the user just loaded the modal (which already fetched tabs).
    try:
        tabs = await get_all_tabs(body.spreadsheet_url)
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail="Google credentials file not configured. " + str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("sheets_validate_tabs_failed", error=str(e))
        raise HTTPException(status_code=400, detail=f"Cannot access spreadsheet: {e}")

    canonical_groups, tab_warnings = _canonicalize_tab_groups(body.tab_groups, tabs)
    invalid_tabs = [
        tab
        for group in body.tab_groups
        for tab in group
        if _resolve_worksheet_name(tab, tabs) is None
    ]
    if invalid_tabs:
        raise HTTPException(
            status_code=400,
            detail={
                "message": f"Tabs not found in spreadsheet: {invalid_tabs}",
                "available_tabs": tabs,
            },
        )

    try:
        config = await save_config(
            user_id, body.spreadsheet_url, canonical_groups, body.auto_post_threshold
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("sheets_save_config_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail=f"Failed to save Google Sheets config: {e}")

    return {
        "success": True,
        "spreadsheet_url": config.spreadsheet_url,
        "tab_groups": config.tab_groups,
        "auto_post_threshold": config.auto_post_threshold,
        "group_count": len(config.tab_groups or []),
        "assigned_tab_count": len([t for g in (config.tab_groups or []) for t in g]),
        "tab_warnings": tab_warnings,
    }


@router.patch("/sheets/config/auto-post-threshold", dependencies=[Depends(get_current_user)])
async def patch_sheets_auto_post_threshold(
    body: SheetsAutoPostThresholdRequest,
    current_user: dict = Depends(get_current_user),
):
    """Update auto-post match score threshold without changing tab groups."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    from app.services.google_sheets_service import update_auto_post_threshold

    try:
        config = await update_auto_post_threshold(user_id, body.auto_post_threshold)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("sheets_patch_auto_post_threshold_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail=f"Failed to update auto-post threshold: {e}")

    tab_groups = config.tab_groups or []
    return {
        "success": True,
        "auto_post_threshold": config.auto_post_threshold,
        "spreadsheet_url": config.spreadsheet_url,
        "tab_groups": tab_groups,
        "group_count": len(tab_groups),
        "assigned_tab_count": len([t for g in tab_groups for t in g]),
    }


@router.delete("/sheets/config", dependencies=[Depends(get_current_user)])
async def delete_sheets_config(current_user: dict = Depends(get_current_user)):
    """Disconnect Google Sheets integration for the current user."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    from app.services.google_sheets_service import delete_user_config

    removed = await delete_user_config(user_id)
    return {"success": True, "removed": removed}


@router.post("/sheets/post-jobs", dependencies=[Depends(get_current_user)])
async def post_jobs_to_sheet(
    body: SheetsPostJobsRequest,
    current_user: dict = Depends(get_current_user),
):
    """Manually post selected jobs to Google Sheets."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    from app.services.google_sheets_service import get_user_config, distribute_jobs

    try:
        config = await get_user_config(user_id)
    except Exception as e:
        logger.error("sheets_get_config_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail=f"Failed to read Google Sheets config: {e}")

    if not config or not config.tab_groups:
        raise HTTPException(status_code=400, detail="Google Sheets integration not configured. Set it up in your profile first.")

    try:
        summary = await distribute_jobs(user_id, body.job_ids)
    except Exception as e:
        logger.error("sheets_distribute_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=502, detail=f"Failed to post jobs to Google Sheet: {e}")

    return {
        "success": True,
        "posted_count": len(summary["posted"]),
        "partial_count": len(summary.get("partial", [])),
        "failed_count": len(summary.get("failed", [])),
        "skipped_already_in_sheet": summary["skipped_already_in_sheet"],
        "skipped_not_found": summary["skipped_not_found"],
        "results": summary["posted"],
        "partial_results": summary.get("partial", []),
        "failed_results": summary.get("failed", []),
    }


# ── Old jobs cleanup ───────────────────────────────────────────────────────

OLD_JOB_THRESHOLD_DAYS = 60


@router.get("/jobs/old-jobs/count", dependencies=[Depends(get_current_user)])
async def count_old_jobs() -> dict:
    """Count jobs created more than 2 months ago."""
    cutoff = _utcnow() - timedelta(days=OLD_JOB_THRESHOLD_DAYS)
    async with get_session() as session:
        old_count = (await session.execute(
            select(func.count()).select_from(Job).where(
                Job.created_at < cutoff,
            )
        )).scalar_one()
    return {
        "total_old": old_count,
        "threshold_days": OLD_JOB_THRESHOLD_DAYS,
    }


@router.delete("/jobs/old-jobs", dependencies=[Depends(get_current_user)])
async def delete_old_jobs() -> dict:
    """Delete all jobs created more than 2 months ago."""
    cutoff = _utcnow() - timedelta(days=OLD_JOB_THRESHOLD_DAYS)
    async with get_session() as session:
        old_rows = await session.execute(
            select(Job.id).where(Job.created_at < cutoff)
        )
        old_ids = [r for r in old_rows.scalars().all()]

        deleted = 0
        for jid in old_ids:
            if await _purge_job_cascade(session, jid):
                deleted += 1

        await session.commit()

    logger.info(
        "delete_old_jobs_complete",
        deleted=deleted,
    )
    return {
        "success": True,
        "total_deleted": deleted,
    }
