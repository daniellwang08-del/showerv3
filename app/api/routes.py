from fastapi import APIRouter, HTTPException, Depends, BackgroundTasks, Request, Response, status, Cookie, File, UploadFile, Query
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
    ValidJobResponse,
    ValidJobIdsBatchRequest,
    AiJobSearchRequest,
    AiJobSearchResponse,
    InvalidJobResponse,
    JobSubmissionResponse,
    JobMatchResponse,
    JobAnalysisResponse,
    JobPromotionInfo,
)
from app.models.auth_schemas import SignupRequest, LoginRequest, AuthResponse, UserResponse, ProfileUpdateRequest
from app.models.profile_schemas import ProfileResponse, ProfileCreateRequest, ResumeParseResponse
from app.storage.database import get_session, check_database_connection
from app.storage.repository import (
    JobExtractionRepository,
    JobMatchRepository,
    JobMatchInProgressRepository,
    ValidJobRepository,
    ValidJobUserApplicationRepository,
)
from app.storage.user_repository import UserRepository, _profile_display_name, user_applied_by_display_name
from app.services.url_manager import URLManager
from app.services.deduplication import DeduplicationService
from app.services.duplication_checker import DuplicationChecker
from app.extractors.browser_extractor import get_browser_pool_safe
from app.core.config import get_settings
from app.core.logging import bind_logging_context, get_logger
from openai import APIError as OpenAIAPIError
from app.core.exceptions import AIParsingError
from app.services.job_ai_search_service import apply_job_search_spec, interpret_job_search_prompt
from app.services.resume_parse_service import parse_resume_bytes
from app.models.database import (
    ValidJob,
    InvalidJob,
    JobExtraction,
    JobMatchResult,
    JobMatchInProgress,
    ValidJobUserApplication,
)
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
import asyncio
from datetime import datetime, timezone
from app.utils.text_sanitizer import sanitize_for_postgres_text

router = APIRouter()
logger = get_logger(__name__)


class JobUrlUpdateRequest(BaseModel):
    url: str = Field(..., min_length=1, max_length=2048)


class JobReportRequest(BaseModel):
    duplication_reason: str | None = Field(default=None, max_length=500)
    duplicate_of_job_id: str | None = Field(default=None, max_length=36)


class PromoteInvalidRequest(BaseModel):
    reason: str = Field(..., min_length=1, max_length=500)


class InvalidJobIdsBatchRequest(BaseModel):
    invalid_job_ids: list[str] = Field(..., min_length=1, max_length=200)


async def _purge_valid_job_cascade(session, job_id: str) -> bool:
    """
    Delete a valid job row and related match/progress/application rows.
    Remove JobExtraction when no other valid job references it.
    Returns False if the valid job row was not found.
    """
    result = await session.execute(select(ValidJob).where(ValidJob.id == job_id))
    job = result.scalar_one_or_none()
    if not job:
        return False

    extraction_id = job.extraction_id

    match_rows = await session.execute(
        select(JobMatchResult).where(JobMatchResult.valid_job_id == job_id)
    )
    for row in match_rows.scalars().all():
        await session.delete(row)

    progress_rows = await session.execute(
        select(JobMatchInProgress).where(JobMatchInProgress.valid_job_id == job_id)
    )
    for row in progress_rows.scalars().all():
        await session.delete(row)

    app_rows = await session.execute(
        select(ValidJobUserApplication).where(ValidJobUserApplication.valid_job_id == job_id)
    )
    for row in app_rows.scalars().all():
        await session.delete(row)

    await session.delete(job)

    if extraction_id:
        other_ref = await session.execute(
            select(ValidJob.id).where(
                ValidJob.extraction_id == extraction_id,
                ValidJob.id != job_id,
            ).limit(1)
        )
        if other_ref.scalar_one_or_none() is None:
            extraction_result = await session.execute(
                select(JobExtraction).where(JobExtraction.id == extraction_id)
            )
            extraction = extraction_result.scalar_one_or_none()
            if extraction:
                await session.delete(extraction)
    return True


async def _purge_invalid_job_cascade(session, invalid_job_id: str) -> bool:
    """
    Remove an invalid (duplicate) job row. Also removes shadow inactive ValidJob rows
    for the same normalized URL (created when reporting/demoting) and their extractions.
    """
    result = await session.execute(select(InvalidJob).where(InvalidJob.id == invalid_job_id))
    inv = result.scalar_one_or_none()
    if not inv:
        return False

    shadow = await session.execute(
        select(ValidJob).where(
            ValidJob.normalized_url == inv.normalized_url,
            ValidJob.is_active == False,
        )
    )
    for v in shadow.scalars().all():
        await _purge_valid_job_cascade(session, v.id)

    await session.delete(inv)
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
    # Normalize email (lowercase and strip whitespace)
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
                max_age=86400,  # 24 hours
                samesite="lax",
                secure=False  # Set to True in production with HTTPS
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
    # Normalize email (lowercase and strip whitespace)
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
            max_age=86400,  # 24 hours
            samesite="lax",
            secure=False  # Set to True in production with HTTPS
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
        user = await repo.update_profile(user_id, _request_to_profile_data(request))
        if not user:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
        await session.refresh(user)
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
        result = await parse_resume_bytes(raw=raw, filename=file.filename or "")
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


async def try_get_redis_pool():
    """Get Redis/Memurai pool for job queue. Returns None on any connection failure."""
    try:
        from app.tasks.worker import get_redis_pool
        pool = await get_redis_pool()
        await pool.ping()
        return pool
    except Exception as e:
        logger.warning(
            "redis_pool_unavailable",
            error=str(e),
            hint="Jobs will use background_tasks fallback. For async processing, ensure Memurai/Redis is running and worker is started: python run_worker.py",
        )
        return None


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
    pool = await try_get_redis_pool()
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
                queue="job_extraction",
            )
            return
        except Exception as e:
            logger.warning("extraction_redis_enqueue_failed", extraction_id=extraction_id, error=str(e))
        finally:
            await pool.close()

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
    valid_job_id: str,
    user_id: str,
    *,
    background_tasks: BackgroundTasks | None = None,
) -> None:
    """
    Prefer Redis/arq for match analysis; fall back to FastAPI BackgroundTasks.
    """
    pool = await try_get_redis_pool()
    bind_logging_context(valid_job_id=valid_job_id, user_id=user_id)
    if pool:
        try:
            await pool.enqueue_job("analyze_job_match", valid_job_id, user_id)
            logger.info(
                "job_match_enqueued_redis",
                valid_job_id=valid_job_id,
                user_id=user_id,
                queue="job_extraction",
            )
            return
        except Exception as e:
            logger.warning("job_match_redis_enqueue_failed", valid_job_id=valid_job_id, error=str(e))
        finally:
            await pool.close()

    if background_tasks:
        from app.services.job_match_orchestrator import run_job_match_analysis

        background_tasks.add_task(run_job_match_analysis, valid_job_id, user_id)
        logger.info("job_match_enqueued_in_process", valid_job_id=valid_job_id, user_id=user_id)
    else:
        logger.error(
            "job_match_not_enqueued",
            valid_job_id=valid_job_id,
            user_id=user_id,
            reason="No Redis and no background_tasks available",
        )


async def _fallback_job_match_after_extraction(valid_job_id: str, user_id: str) -> None:
    """Run match in a separate task so extraction (BackgroundTasks) does not block on OpenAI."""
    from app.services.job_match_orchestrator import run_job_match_analysis

    try:
        await run_job_match_analysis(valid_job_id, user_id)
    except Exception as match_err:
        logger.warning(
            "fallback_job_match_failed",
            valid_job_id=valid_job_id,
            user_id=user_id,
            error=str(match_err),
        )


async def _fallback_match_batch_parallel(user_id: str, valid_job_ids: list[str]) -> None:
    """
    When Redis is unavailable, run many matches with bounded concurrency (not one-by-one
    Starlette background tasks, which would serialize all match calls).
    """
    from app.services.job_match_orchestrator import run_job_match_analysis

    sem = asyncio.Semaphore(4)

    async def one(jid: str) -> None:
        async with sem:
            try:
                await run_job_match_analysis(jid, user_id)
            except Exception as e:
                logger.warning("fallback_batch_job_match_failed", valid_job_id=jid, error=str(e))

    await asyncio.gather(*(one(jid) for jid in valid_job_ids))


@router.get("/health", response_model=HealthResponse)
async def health_check() -> HealthResponse:
    settings = get_settings()
    db_connected = await check_database_connection()

    redis_connected = False
    try:
        pool = await try_get_redis_pool()
        if pool:
            redis_connected = True
            await pool.close()
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
    job_id: str,
    url: str,
    user_id: str | None = None,
) -> None:
    from app.services.extraction_service import ExtractionService
    from app.storage.repository import ValidJobRepository

    try:
        service = ExtractionService()
        result = await service.process_job(job_id, url)
        # Match runs in a separate asyncio task so this extraction job finishes quickly and
        # does not serialize with other BackgroundTasks work (same pattern as worker: scrape then match).
        if user_id and result.get("status") == "completed":
            valid_job_id: str | None = None
            async with get_session() as session:
                valid_repo = ValidJobRepository(session)
                valid_job = await valid_repo.get_by_extraction_id(job_id)
                if valid_job:
                    valid_job_id = valid_job.id
                    progress_repo = JobMatchInProgressRepository(session)
                    await progress_repo.add(valid_job.id, user_id)
                    await session.commit()
            if valid_job_id:
                asyncio.create_task(_fallback_job_match_after_extraction(valid_job_id, user_id))
    except Exception as e:
        logger.error("sync_extraction_failed", job_id=job_id, error=str(e))


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

    async with get_session() as session:
        repository = JobExtractionRepository(session)
        dedup_service = DeduplicationService(repository)

        extraction, is_duplicate = await dedup_service.check_and_create(
            url,
            request.force_refresh,
        )

        if is_duplicate and extraction.status == ExtractionStatus.COMPLETED:
            return _build_response(extraction)

        if is_duplicate and extraction.status in (ExtractionStatus.PENDING, ExtractionStatus.PROCESSING):
            return _build_response(extraction)

        if extraction.status == ExtractionStatus.PENDING:
            # Commit DB row before enqueue to avoid worker seeing uncommitted state.
            should_enqueue = True
            extraction_id = extraction.id
            logger.info("extract_job_created", job_id=extraction.id, url=url, is_duplicate=is_duplicate)
        else:
            logger.debug("extract_job_existing", job_id=extraction.id, status=extraction.status.value)

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
    duplicate_count = 0
    to_enqueue: list[tuple[str, str]] = []

    async with get_session() as session:
        repository = JobExtractionRepository(session)
        dedup_service = DeduplicationService(repository)

        for url in request.urls:
            url_str = str(url)

            is_valid, _ = URLManager.validate_url(url_str)
            if not is_valid:
                continue

            extraction, _ = await dedup_service.check_and_create(
                url_str,
                request.force_refresh,
            )

            job_ids.append(extraction.id)

            if extraction.status == ExtractionStatus.PENDING:
                # Queue only after transaction commits to avoid read-before-commit races.
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
        duplicate_urls=duplicate_count,
        job_ids=job_ids,
    )
    return BatchExtractionResponse(
        batch_id=f"batch_{datetime.utcnow().strftime('%Y%m%d%H%M%S')}",
        total_urls=len(request.urls),
        accepted_urls=len(job_ids),
        duplicate_urls=duplicate_count,
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
    if extraction.status == ExtractionStatus.COMPLETED and extraction.title:
        job_data = JobDescriptionSchema(
            title=extraction.title,
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
        confidence_score=extraction.confidence_score,
    )


@router.post("/jobs/submit", response_model=JobSubmissionResponse, dependencies=[Depends(get_current_user)])
async def submit_job(
    request: JobSubmissionRequest,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
) -> JobSubmissionResponse:
    """Submit a job link. Duplicate detection happens after LLM extraction/matching."""
    
    # Validate URL
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
    
    async with get_session() as session:
        duplication_checker = DuplicationChecker(session)
        normalized_url = duplication_checker.normalize_url(request.url)
        domain = duplication_checker.extract_domain(request.url)

        valid_job = ValidJob(
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
            similarity_hash=duplication_checker.generate_content_hash(
                request.title or "", request.company or "", request.description or ""
            ),
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
        session.add(valid_job)
        await session.flush()

        extraction_repo = JobExtractionRepository(session)
        extraction, _ = await extraction_repo.get_or_create(
            source_url=request.url,
            normalized_url=normalized_url,
            domain=domain,
        )
        valid_job.extraction_id = extraction.id
        if extraction.status == ExtractionStatus.COMPLETED and extraction.completed_at:
            valid_job.scraped_at = extraction.completed_at
        await session.commit()

        if extraction.status != ExtractionStatus.COMPLETED:
            await enqueue_extraction(
                extraction.id,
                request.url,
                user_id=current_user.get("user_id"),
                background_tasks=background_tasks,
            )
        else:
            user_id = current_user.get("user_id")
            if user_id:
                existing_match = await session.execute(
                    select(JobMatchResult).where(
                        JobMatchResult.valid_job_id == valid_job.id,
                        JobMatchResult.user_id == user_id,
                    )
                )
                existing_progress = await session.execute(
                    select(JobMatchInProgress).where(
                        JobMatchInProgress.valid_job_id == valid_job.id,
                        JobMatchInProgress.user_id == user_id,
                    )
                )
                if not existing_match.scalar_one_or_none() and not existing_progress.scalar_one_or_none():
                    progress_repo = JobMatchInProgressRepository(session)
                    await progress_repo.add(valid_job.id, user_id)
                    await session.commit()
                    await enqueue_job_match_analysis(
                        valid_job.id,
                        user_id,
                        background_tasks=background_tasks,
                    )

        logger.info("jobs_submit_valid_created", job_id=valid_job.id, url=request.url, extraction_id=extraction.id)
        return JobSubmissionResponse(
            success=True,
            job_id=valid_job.id,
            is_duplicate=False,
            duplicate_job_id=None,
            message="Job submitted successfully",
        )


@router.get("/jobs/valid", response_model=list[ValidJobResponse], dependencies=[Depends(get_current_user)])
async def get_valid_jobs(
    limit: int = 50,
    offset: int = 0,
    current_user: dict = Depends(get_current_user),
) -> list[ValidJobResponse]:
    """Get valid jobs (todo-jobs)"""
    logger.debug("get_valid_jobs", limit=limit, offset=offset)
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    async with get_session() as session:
        stmt = (
            select(
                ValidJob,
                JobExtraction.status,
                JobMatchResult.overall_score,
                JobMatchInProgress.id.label("match_progress_id"),
                ValidJobUserApplication.applied_at,
                ValidJobUserApplication.applied_by_name,
            )
            .select_from(ValidJob)
            .outerjoin(JobExtraction, ValidJob.extraction_id == JobExtraction.id)
            .outerjoin(
                JobMatchResult,
                (JobMatchResult.valid_job_id == ValidJob.id) & (JobMatchResult.user_id == user_id),
            )
            .outerjoin(
                JobMatchInProgress,
                (JobMatchInProgress.valid_job_id == ValidJob.id) & (JobMatchInProgress.user_id == user_id),
            )
            .outerjoin(
                ValidJobUserApplication,
                (ValidJobUserApplication.valid_job_id == ValidJob.id)
                & (ValidJobUserApplication.user_id == user_id),
            )
            .where(ValidJob.is_active == True)
            .order_by(ValidJob.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
        result = await session.execute(stmt)
        rows = result.all()
        return [
            ValidJobResponse(
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
                match_overall_score=match_score,
                match_status="processing" if (match_progress_id and match_score is None) else None,
                click_count=getattr(job, "click_count", 0) or 0,
                applied_at=applied_at,
                applied_by_name=applied_by_name,
                is_active=job.is_active,
                created_at=job.created_at,
                updated_at=job.updated_at,
            )
            for job, ext_status, match_score, match_progress_id, applied_at, applied_by_name in rows
        ]


@router.post("/jobs/valid/ai-search", response_model=AiJobSearchResponse, dependencies=[Depends(get_current_user)])
async def ai_search_valid_jobs(
    body: AiJobSearchRequest,
    current_user: dict = Depends(get_current_user),
) -> AiJobSearchResponse:
    """Interpret a natural language prompt via OpenAI and return valid job ids that match."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        spec = await interpret_job_search_prompt(body.prompt)
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
        matching_ids, total = await apply_job_search_spec(session, user_id, spec)
    logger.info("ai_search_valid_jobs_ok", matches=len(matching_ids), candidates=total)
    return AiJobSearchResponse(matching_job_ids=matching_ids, query=spec, total_candidates=total)


@router.get("/jobs/valid/{job_id}", response_model=ValidJobResponse, dependencies=[Depends(get_current_user)])
async def get_valid_job(job_id: str, current_user: dict = Depends(get_current_user)) -> ValidJobResponse:
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    async with get_session() as session:
        stmt = (
            select(
                ValidJob,
                JobExtraction.status,
                ValidJobUserApplication.applied_at,
                ValidJobUserApplication.applied_by_name,
            )
            .select_from(ValidJob)
            .outerjoin(JobExtraction, ValidJob.extraction_id == JobExtraction.id)
            .outerjoin(
                ValidJobUserApplication,
                (ValidJobUserApplication.valid_job_id == ValidJob.id)
                & (ValidJobUserApplication.user_id == user_id),
            )
            .where(ValidJob.id == job_id)
        )
        result = await session.execute(stmt)
        row = result.one_or_none()
        if not row:
            logger.warning("get_valid_job_not_found", job_id=job_id)
            raise HTTPException(status_code=404, detail="Valid job not found")
        job, ext_status, applied_at, applied_by_name = row
        return ValidJobResponse(
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
            click_count=getattr(job, "click_count", 0) or 0,
            applied_at=applied_at,
            applied_by_name=applied_by_name,
            is_active=job.is_active,
            created_at=job.created_at,
            updated_at=job.updated_at,
        )


@router.post(
    "/jobs/valid/applied/batch",
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(get_current_user)],
)
async def mark_valid_jobs_applied_batch(
    body: ValidJobIdsBatchRequest,
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
        n = await app_repo.upsert_batch(user_id, body.valid_job_ids, label)
        await session.commit()
    # ISO timestamp so the client can align charts without waiting for a list refetch parse edge cases
    applied_at_iso = datetime.now(timezone.utc).isoformat()
    return {"marked": n, "applied_by_name": label, "applied_at": applied_at_iso}


@router.post(
    "/jobs/valid/unapplied/batch",
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(get_current_user)],
)
async def mark_valid_jobs_unapplied_batch(
    body: ValidJobIdsBatchRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    async with get_session() as session:
        app_repo = ValidJobUserApplicationRepository(session)
        n = await app_repo.delete_batch(user_id, body.valid_job_ids)
        await session.commit()
    return {"cleared": n}


@router.post("/jobs/valid/{job_id}/click", response_model=dict)
async def record_job_click(
    job_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Record a click on a job URL. Returns updated click_count."""
    from sqlalchemy import update

    async with get_session() as session:
        r = await session.execute(
            select(ValidJob).where(ValidJob.id == job_id, ValidJob.is_active == True)
        )
        job = r.scalar_one_or_none()
        if not job:
            raise HTTPException(status_code=404, detail="Valid job not found")
        new_count = (getattr(job, "click_count", 0) or 0) + 1
        await session.execute(
            update(ValidJob).where(ValidJob.id == job_id).values(click_count=new_count)
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
            valid_job_id=match_result.valid_job_id,
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
        r = await session.execute(select(ValidJob).where(ValidJob.id == job_id, ValidJob.is_active == True))
        job = r.scalar_one_or_none()
        if not job:
            raise HTTPException(status_code=404, detail="Valid job not found")

        extraction = None
        extraction_status = None
        extraction_method = None
        confidence_score = None
        job_data = None
        content_enriched_by_ai = False

        if job.extraction_id:
            ext_repo = JobExtractionRepository(session)
            extraction = await ext_repo.get_by_id(job.extraction_id)
            if extraction:
                extraction_status = extraction.status
                extraction_method = extraction.extraction_method
                confidence_score = extraction.confidence_score
                content_enriched_by_ai = _ai_enriched_extraction(extraction)
                if extraction.status == ExtractionStatus.COMPLETED and extraction.title:
                    job_data = JobDescriptionSchema(
                        title=extraction.title,
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
                JobMatchInProgress.valid_job_id == job_id,
                JobMatchInProgress.user_id == user_id,
            )
        )
        match_in_progress = in_prog.scalar_one_or_none() is not None

        match_payload = None
        if match_row:
            match_payload = JobMatchResponse(
                valid_job_id=match_row.valid_job_id,
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

        return JobAnalysisResponse(
            valid_job_id=job.id,
            extraction_id=job.extraction_id,
            extraction_status=extraction_status,
            source_url=job.source_url,
            job_data=job_data,
            extraction_method=extraction_method,
            confidence_score=confidence_score,
            content_enriched_by_ai=content_enriched_by_ai,
            match=match_payload,
            match_in_progress=match_in_progress,
            promotion=promotion_payload,
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
                JobMatchInProgress.valid_job_id == job_id,
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
        r = await session.execute(select(ValidJob).where(ValidJob.id == job_id, ValidJob.is_active == True))
        valid_job = r.scalar_one_or_none()
        if not valid_job or not valid_job.extraction_id:
            raise HTTPException(status_code=400, detail="Job has no scraped description yet")
        extraction_repo = JobExtractionRepository(session)
        extraction = await extraction_repo.get_by_id(valid_job.extraction_id)
        if not extraction or extraction.status != ExtractionStatus.COMPLETED:
            raise HTTPException(status_code=400, detail="Job description not yet scraped")
        await progress_repo.add(job_id, user_id)
        await session.commit()
    await enqueue_job_match_analysis(job_id, user_id, background_tasks=background_tasks)
    return {"status": "queued", "message": "Match analysis queued"}


class RescrapeRequest(BaseModel):
    url: str = Field(..., min_length=1, max_length=2048)


class RescrapeBatchRequest(BaseModel):
    valid_job_ids: list[str] = Field(..., min_length=1, max_length=50)


async def _prepare_valid_job_rescrape_in_session(
    session,
    valid_job: ValidJob,
    source_url: str,
    user_id: str | None,
) -> str:
    """
    Reset extraction (or attach a new one), clear cached match for the user, return extraction_id.
    Caller must commit, then call enqueue_extraction (same pipeline as a new job posting).
    """
    source_url = source_url.strip()
    is_valid, error = URLManager.validate_url(source_url)
    if not is_valid:
        raise ValueError(error or "Invalid URL")

    duplication_checker = DuplicationChecker(session)
    normalized_url = duplication_checker.normalize_url(source_url)
    domain = duplication_checker.extract_domain(source_url)

    extraction_id = valid_job.extraction_id
    repo = JobExtractionRepository(session)

    if not extraction_id:
        extraction, _ = await repo.get_or_create(
            source_url=source_url,
            normalized_url=normalized_url,
            domain=domain,
        )
        valid_job.extraction_id = extraction.id
        valid_job.scraped_at = None
        extraction_id = extraction.id
    else:
        await repo.reset_for_refresh(extraction_id, source_url, domain)
        valid_job.scraped_at = None

    if user_id:
        match_repo = JobMatchRepository(session)
        await match_repo.delete(valid_job.id, user_id)
        progress_repo = JobMatchInProgressRepository(session)
        await progress_repo.remove(valid_job.id, user_id)

    return extraction_id


class RerunJobMatchBatchRequest(BaseModel):
    valid_job_ids: list[str] = Field(..., min_length=1, max_length=100)


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
    for jid in body.valid_job_ids:
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
                    JobMatchInProgress.valid_job_id == job_id,
                    JobMatchInProgress.user_id == user_id,
                )
            )
            if in_prog.scalar_one_or_none():
                skipped.append({"id": job_id, "reason": "already_in_progress"})
                continue

            await match_repo.delete(job_id, user_id)

            r = await session.execute(select(ValidJob).where(ValidJob.id == job_id, ValidJob.is_active == True))
            valid_job = r.scalar_one_or_none()
            if not valid_job or not valid_job.extraction_id:
                skipped.append({"id": job_id, "reason": "no_extraction"})
                continue

            extraction_repo = JobExtractionRepository(session)
            extraction = await extraction_repo.get_by_id(valid_job.extraction_id)
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
    pool = await try_get_redis_pool()
    if pool:
        redis_failed: list[str] = []
        try:
            for jid in enqueued_ids:
                try:
                    await pool.enqueue_job("analyze_job_match", jid, user_id)
                except Exception as e:
                    logger.warning(
                        "job_match_rerun_redis_enqueue_failed",
                        valid_job_id=jid,
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
        finally:
            await pool.close()

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
    body: RescrapeBatchRequest,
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
    for jid in body.valid_job_ids:
        if jid in seen:
            continue
        seen.add(jid)
        unique_ids.append(jid)

    jobs_out: list[dict[str, str]] = []
    skipped: list[dict[str, str]] = []

    for job_id in unique_ids:
        async with get_session() as session:
            r = await session.execute(select(ValidJob).where(ValidJob.id == job_id, ValidJob.is_active == True))
            valid_job = r.scalar_one_or_none()
            if not valid_job:
                skipped.append({"id": job_id, "reason": "not_found"})
                continue
            source_url = (valid_job.source_url or "").strip()
            if not source_url:
                skipped.append({"id": job_id, "reason": "no_url"})
                continue
            try:
                extraction_id = await _prepare_valid_job_rescrape_in_session(session, valid_job, source_url, user_id)
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
        jobs_out.append({"valid_job_id": job_id, "extraction_id": extraction_id})
        logger.info("rescrape_batch_enqueued", valid_job_id=job_id, extraction_id=extraction_id)

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
        result = await session.execute(select(ValidJob).where(ValidJob.id == job_id, ValidJob.is_active == True))
        valid_job = result.scalar_one_or_none()
        if not valid_job:
            raise HTTPException(status_code=404, detail="Valid job not found")
        try:
            extraction_id = await _prepare_valid_job_rescrape_in_session(session, valid_job, source_url, user_id)
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


@router.get("/jobs/invalid", response_model=list[InvalidJobResponse], dependencies=[Depends(get_current_user)])
async def get_invalid_jobs(limit: int = 50, offset: int = 0) -> list[InvalidJobResponse]:
    """Get invalid jobs (check-required jobs)"""
    logger.debug("get_invalid_jobs", limit=limit, offset=offset)
    async with get_session() as session:
        stmt = select(InvalidJob).where(InvalidJob.is_active == True).order_by(
            InvalidJob.created_at.desc()
        ).limit(limit).offset(offset)
        
        result = await session.execute(stmt)
        jobs = result.scalars().all()
        
        return [
            InvalidJobResponse(
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
                duplicate_of_job_id=job.duplicate_of_job_id,
                duplication_reason=job.duplication_reason,
                similarity_score=job.similarity_score,
                similarity_hash=job.similarity_hash,
                is_active=job.is_active,
                created_at=job.created_at,
                updated_at=job.updated_at
            )
            for job in jobs
        ]


@router.get("/jobs/invalid/{job_id}", response_model=InvalidJobResponse, dependencies=[Depends(get_current_user)])
async def get_invalid_job(job_id: str) -> InvalidJobResponse:
    async with get_session() as session:
        stmt = select(InvalidJob).where(InvalidJob.id == job_id)
        result = await session.execute(stmt)
        job = result.scalar_one_or_none()
        if not job:
            logger.warning("get_invalid_job_not_found", job_id=job_id)
            raise HTTPException(status_code=404, detail="Invalid job not found")

        return InvalidJobResponse(
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
            duplicate_of_job_id=job.duplicate_of_job_id,
            duplication_reason=job.duplication_reason,
            similarity_score=job.similarity_score,
            similarity_hash=job.similarity_hash,
            is_active=job.is_active,
            created_at=job.created_at,
            updated_at=job.updated_at,
        )


@router.post("/jobs/invalid/{job_id}/promote-to-valid", dependencies=[Depends(get_current_user)])
async def promote_invalid_to_valid(
    job_id: str,
    request: PromoteInvalidRequest,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """
    Move a duplicate (invalid) job to the valid list with a user reason stored on the new row.
    """
    reason_clean = sanitize_for_postgres_text(request.reason.strip())
    if not reason_clean:
        raise HTTPException(status_code=400, detail="Reason is required")
    user_id = current_user.get("user_id")

    async with get_session() as session:
        duplication_checker = DuplicationChecker(session)
        inv_result = await session.execute(
            select(InvalidJob).where(InvalidJob.id == job_id, InvalidJob.is_active == True)
        )
        invalid = inv_result.scalar_one_or_none()
        if not invalid:
            logger.warning("promote_invalid_not_found", job_id=job_id)
            raise HTTPException(status_code=404, detail="Invalid job not found")

        meta = dict(invalid.raw_metadata or {})
        promoted_at_iso = datetime.utcnow().isoformat()
        meta["promotion_reason"] = reason_clean
        meta["promoted_from_invalid_job_id"] = invalid.id
        meta["promoted_at"] = promoted_at_iso
        if user_id:
            meta["promoted_by_user_id"] = user_id
        sub_email = current_user.get("sub")
        if sub_email:
            meta["promoted_by_email"] = str(sub_email).strip()
        if user_id:
            user_repo = UserRepository(session)
            promoter = await user_repo.get_by_id(user_id)
            if promoter and promoter.name and str(promoter.name).strip():
                meta["promoted_by_name"] = str(promoter.name).strip()

        sim_hash = invalid.similarity_hash
        if not sim_hash:
            sim_hash = duplication_checker.generate_content_hash(
                invalid.title or "",
                invalid.company or "",
                invalid.description or "",
            )

        valid_job = ValidJob(
            source_url=invalid.source_url,
            normalized_url=invalid.normalized_url,
            domain=invalid.domain,
            title=invalid.title,
            company=invalid.company or "Unknown",
            location=invalid.location,
            description=invalid.description,
            posted_date=invalid.posted_date,
            experience_level=invalid.experience_level,
            industry=invalid.industry,
            similarity_hash=sim_hash,
            raw_metadata=meta,
        )
        session.add(valid_job)
        await session.flush()

        extraction_repo = JobExtractionRepository(session)
        extraction, _ = await extraction_repo.get_or_create(
            source_url=invalid.source_url,
            normalized_url=invalid.normalized_url,
            domain=invalid.domain,
        )
        valid_job.extraction_id = extraction.id
        if extraction.status == ExtractionStatus.COMPLETED and extraction.completed_at:
            valid_job.scraped_at = extraction.completed_at

        await session.delete(invalid)
        await session.commit()

        valid_job_id = valid_job.id
        extraction_id = extraction.id
        extraction_status = extraction.status
        source_url = valid_job.source_url

    if extraction_status != ExtractionStatus.COMPLETED:
        await enqueue_extraction(
            extraction_id,
            source_url,
            user_id=user_id,
            background_tasks=background_tasks,
        )
    elif user_id:
        async with get_session() as session:
            existing_match = await session.execute(
                select(JobMatchResult).where(
                    JobMatchResult.valid_job_id == valid_job_id,
                    JobMatchResult.user_id == user_id,
                )
            )
            existing_progress = await session.execute(
                select(JobMatchInProgress).where(
                    JobMatchInProgress.valid_job_id == valid_job_id,
                    JobMatchInProgress.user_id == user_id,
                )
            )
            if not existing_match.scalar_one_or_none() and not existing_progress.scalar_one_or_none():
                progress_repo = JobMatchInProgressRepository(session)
                await progress_repo.add(valid_job_id, user_id)
                await session.commit()
                await enqueue_job_match_analysis(
                    valid_job_id,
                    user_id,
                    background_tasks=background_tasks,
                )

    logger.info("promote_invalid_to_valid_success", invalid_job_id=job_id, valid_job_id=valid_job_id)
    return {"success": True, "valid_job_id": valid_job_id}


@router.get("/jobs/stats", dependencies=[Depends(get_current_user)])
async def get_job_stats() -> dict:
    """Get statistics about valid and invalid jobs"""
    
    async with get_session() as session:
        # Count valid jobs
        valid_stmt = select(ValidJob).where(ValidJob.is_active == True)
        valid_result = await session.execute(valid_stmt)
        valid_count = len(valid_result.scalars().all())
        
        # Count invalid jobs
        invalid_stmt = select(InvalidJob).where(InvalidJob.is_active == True)
        invalid_result = await session.execute(invalid_stmt)
        invalid_count = len(invalid_result.scalars().all())
        
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
        result = await session.execute(select(ValidJob).where(ValidJob.id == job_id))
        job = result.scalar_one_or_none()
        if not job:
            logger.warning("update_valid_job_url_not_found", job_id=job_id)
            raise HTTPException(status_code=404, detail="Valid job not found")

        duplication_checker = DuplicationChecker(session)
        job.source_url = request.url
        job.normalized_url = duplication_checker.normalize_url(request.url)
        job.domain = duplication_checker.extract_domain(request.url)
        job.extraction_id = None
        job.scraped_at = None
        job.updated_at = datetime.utcnow()

        try:
            await session.commit()
            logger.info("update_valid_job_url_success", job_id=job_id, url=request.url)
        except IntegrityError:
            await session.rollback()
            logger.warning("update_valid_job_url_conflict", job_id=job_id, url=request.url)
            raise HTTPException(status_code=409, detail="URL already exists")

        return {"success": True}


@router.patch("/jobs/invalid/{job_id}/url", dependencies=[Depends(get_current_user)])
async def update_invalid_job_url(job_id: str, request: JobUrlUpdateRequest) -> dict:
    is_valid, error = URLManager.validate_url(request.url)
    if not is_valid:
        logger.warning("update_invalid_job_url_invalid", job_id=job_id, error=error)
        raise HTTPException(status_code=400, detail=f"Invalid URL: {error}")

    async with get_session() as session:
        result = await session.execute(select(InvalidJob).where(InvalidJob.id == job_id))
        job = result.scalar_one_or_none()
        if not job:
            logger.warning("update_invalid_job_url_not_found", job_id=job_id)
            raise HTTPException(status_code=404, detail="Invalid job not found")

        duplication_checker = DuplicationChecker(session)
        job.source_url = request.url
        job.normalized_url = duplication_checker.normalize_url(request.url)
        job.domain = duplication_checker.extract_domain(request.url)
        job.updated_at = datetime.utcnow()

        try:
            await session.commit()
            logger.info("update_invalid_job_url_success", job_id=job_id, url=request.url)
        except IntegrityError:
            await session.rollback()
            logger.warning("update_invalid_job_url_conflict", job_id=job_id, url=request.url)
            raise HTTPException(status_code=409, detail="URL already exists")

        return {"success": True}


@router.post("/jobs/valid/{job_id}/report-invalid", dependencies=[Depends(get_current_user)])
async def report_valid_as_invalid(job_id: str, request: JobReportRequest) -> dict:
    async with get_session() as session:
        result = await session.execute(select(ValidJob).where(ValidJob.id == job_id))
        job = result.scalar_one_or_none()
        if not job:
            logger.warning("report_valid_as_invalid_not_found", job_id=job_id)
            raise HTTPException(status_code=404, detail="Valid job not found")

        invalid_job = InvalidJob(
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
            duplicate_of_job_id=None,
            duplication_reason=request.duplication_reason or "Manually reported as invalid job",
            similarity_score=None,
            similarity_hash=job.similarity_hash,
            raw_metadata=job.raw_metadata or {},
            is_active=True,
        )

        job.is_active = False
        job.updated_at = datetime.utcnow()

        session.add(invalid_job)
        try:
            await session.commit()
            logger.info("report_valid_as_invalid_success", job_id=job_id, invalid_job_id=invalid_job.id)
        except IntegrityError:
            await session.rollback()
            logger.warning("report_valid_as_invalid_conflict", job_id=job_id)
            raise HTTPException(status_code=409, detail="Job already exists in invalid jobs")

        return {"success": True, "invalid_job_id": invalid_job.id}


@router.post("/jobs/valid/{job_id}/report-duplicate", dependencies=[Depends(get_current_user)])
async def report_valid_as_duplicate(job_id: str, request: JobReportRequest) -> dict:
    async with get_session() as session:
        result = await session.execute(select(ValidJob).where(ValidJob.id == job_id))
        job = result.scalar_one_or_none()
        if not job:
            logger.warning("report_valid_as_duplicate_not_found", job_id=job_id)
            raise HTTPException(status_code=404, detail="Valid job not found")

        invalid_job = InvalidJob(
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
            duplicate_of_job_id=request.duplicate_of_job_id,
            duplication_reason=request.duplication_reason or "Manually reported as duplicated job",
            similarity_score=None,
            similarity_hash=job.similarity_hash,
            raw_metadata=job.raw_metadata or {},
            is_active=True,
        )

        job.is_active = False
        job.updated_at = datetime.utcnow()

        session.add(invalid_job)
        try:
            await session.commit()
            logger.info("report_valid_as_duplicate_success", job_id=job_id, invalid_job_id=invalid_job.id, duplicate_of=request.duplicate_of_job_id)
        except IntegrityError:
            await session.rollback()
            logger.warning("report_valid_as_duplicate_conflict", job_id=job_id)
            raise HTTPException(status_code=409, detail="Job already exists in invalid jobs")

        return {"success": True, "invalid_job_id": invalid_job.id}


@router.post("/jobs/invalid/{job_id}/report-invalid", dependencies=[Depends(get_current_user)])
async def report_invalid_as_invalid(job_id: str, request: JobReportRequest) -> dict:
    async with get_session() as session:
        result = await session.execute(select(InvalidJob).where(InvalidJob.id == job_id))
        job = result.scalar_one_or_none()
        if not job:
            logger.warning("report_invalid_as_invalid_not_found", job_id=job_id)
            raise HTTPException(status_code=404, detail="Invalid job not found")

        job.duplicate_of_job_id = None
        job.duplication_reason = request.duplication_reason or "Manually reported as invalid job"
        job.updated_at = datetime.utcnow()
        await session.commit()
        logger.info("report_invalid_as_invalid_success", job_id=job_id)
        return {"success": True}


@router.post("/jobs/invalid/{job_id}/report-duplicate", dependencies=[Depends(get_current_user)])
async def report_invalid_as_duplicate(job_id: str, request: JobReportRequest) -> dict:
    async with get_session() as session:
        result = await session.execute(select(InvalidJob).where(InvalidJob.id == job_id))
        job = result.scalar_one_or_none()
        if not job:
            logger.warning("report_invalid_as_duplicate_not_found", job_id=job_id)
            raise HTTPException(status_code=404, detail="Invalid job not found")

        job.duplicate_of_job_id = request.duplicate_of_job_id
        job.duplication_reason = request.duplication_reason or "Manually reported as duplicated job"
        job.updated_at = datetime.utcnow()
        await session.commit()
        logger.info("report_invalid_as_duplicate_success", job_id=job_id, duplicate_of=request.duplicate_of_job_id)
        return {"success": True}


@router.delete("/jobs/valid/{job_id}", dependencies=[Depends(get_current_user)])
async def delete_valid_job(job_id: str) -> dict:
    async with get_session() as session:
        ext_row = await session.execute(select(ValidJob.extraction_id).where(ValidJob.id == job_id))
        extraction_id = ext_row.scalar_one_or_none()
        ok = await _purge_valid_job_cascade(session, job_id)
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
async def delete_invalid_job(job_id: str) -> dict:
    async with get_session() as session:
        ok = await _purge_invalid_job_cascade(session, job_id)
        if not ok:
            logger.warning("delete_invalid_job_not_found", job_id=job_id)
            raise HTTPException(status_code=404, detail="Invalid job not found")

        await session.commit()
        logger.info("delete_invalid_job_success", job_id=job_id)
        return {"success": True}


@router.post("/jobs/invalid/delete/batch", dependencies=[Depends(get_current_user)])
async def delete_invalid_jobs_batch(body: InvalidJobIdsBatchRequest) -> dict:
    """Delete multiple invalid jobs with the same cascade as DELETE /jobs/invalid/{id}."""
    ids = list(dict.fromkeys(i for i in body.invalid_job_ids if i and str(i).strip()))
    async with get_session() as session:
        deleted = 0
        for jid in ids:
            if await _purge_invalid_job_cascade(session, jid):
                deleted += 1
        await session.commit()
    logger.info("delete_invalid_jobs_batch", count=deleted, requested=len(ids))
    return {"success": True, "deleted": deleted}
