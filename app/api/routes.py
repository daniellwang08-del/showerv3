from fastapi import APIRouter, HTTPException, Depends, BackgroundTasks, Request, Response, status, Cookie
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
    InvalidJobResponse,
    JobSubmissionResponse,
    JobMatchResponse,
)
from app.models.auth_schemas import SignupRequest, LoginRequest, AuthResponse, UserResponse, ProfileUpdateRequest
from app.models.profile_schemas import ProfileResponse, ProfileCreateRequest
from app.storage.database import get_session, check_database_connection
from app.storage.repository import JobExtractionRepository, JobMatchRepository, ValidJobRepository
from app.storage.user_repository import UserRepository, _profile_display_name
from app.services.url_manager import URLManager
from app.services.deduplication import DeduplicationService
from app.services.duplication_checker import DuplicationChecker
from app.extractors.browser_extractor import get_browser_pool_safe
from app.core.config import get_settings
from app.core.logging import get_logger
from app.models.database import ValidJob, InvalidJob, JobExtraction, JobMatchResult, JobMatchInProgress
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from datetime import datetime

router = APIRouter()
logger = get_logger(__name__)


class JobUrlUpdateRequest(BaseModel):
    url: str = Field(..., min_length=1, max_length=2048)


class JobReportRequest(BaseModel):
    duplication_reason: str | None = Field(default=None, max_length=500)
    duplicate_of_job_id: str | None = Field(default=None, max_length=36)


async def get_current_user(request: Request):
    token = request.cookies.get("access_token")
    if not token:
        logger.warning("auth_required_missing_token")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    payload = AuthService.verify_token(token)
    if not payload:
        logger.warning("auth_required_invalid_token")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
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
            is_active=user.is_active,
            created_at=user.created_at
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
            is_active=user.is_active,
            created_at=user.created_at
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


async def _has_active_arq_worker(pool) -> bool:
    """Check if at least one arq worker is actively consuming the queue."""
    try:
        keys = await pool.keys("arq:worker:*")
        return len(keys) > 0
    except Exception:
        return False


async def enqueue_extraction(
    extraction_id: str,
    url: str,
    *,
    user_id: str | None = None,
    background_tasks: BackgroundTasks | None = None,
) -> None:
    pool = await try_get_redis_pool()
    if pool and await _has_active_arq_worker(pool):
        if user_id:
            await pool.enqueue_job("extract_job", extraction_id, url, user_id)
        else:
            await pool.enqueue_job("extract_job", extraction_id, url)
        await pool.close()
        logger.info(
            "extraction_enqueued_redis",
            extraction_id=extraction_id,
            url=url,
            queue="job_extraction",
        )
    else:
        if pool:
            await pool.close()
            logger.warning(
                "redis_available_but_no_worker",
                extraction_id=extraction_id,
                hint="Redis is reachable but no arq worker is running. Falling back to in-process execution. Start worker: python run_worker.py",
            )
        if background_tasks:
            background_tasks.add_task(process_extraction_sync, extraction_id, url, user_id)
            logger.info("extraction_enqueued_sync", extraction_id=extraction_id, url=url)
        else:
            logger.error("extraction_not_enqueued", extraction_id=extraction_id, reason="No worker and no background_tasks available")


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
    from app.services.job_match_orchestrator import run_job_match_analysis

    try:
        service = ExtractionService()
        result = await service.process_job(job_id, url)
        # Run job match analysis when extraction completes (sync fallback path)
        if user_id and result.get("status") == "completed":
            async with get_session() as session:
                valid_repo = ValidJobRepository(session)
                valid_job = await valid_repo.get_by_extraction_id(job_id)
                if valid_job:
                    try:
                        await run_job_match_analysis(valid_job.id, user_id)
                    except Exception as match_err:
                        logger.warning("sync_job_match_failed", valid_job_id=valid_job.id, error=str(match_err))
    except Exception as e:
        logger.error("sync_extraction_failed", job_id=job_id, error=str(e))


@router.post("/extract", response_model=ExtractionResponse, dependencies=[Depends(get_current_user)])
async def extract_job(
    request: ExtractionRequest,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
) -> ExtractionResponse:
    url = str(request.url)

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
            await enqueue_extraction(
                extraction.id, url, user_id=current_user.get("user_id"), background_tasks=background_tasks
            )
            logger.info("extract_job_created", job_id=extraction.id, url=url, is_duplicate=is_duplicate)
        else:
            logger.debug("extract_job_existing", job_id=extraction.id, status=extraction.status.value)

        return _build_response(extraction)


@router.post("/extract/batch", response_model=BatchExtractionResponse, dependencies=[Depends(get_current_user)])
async def extract_batch(
    request: BatchExtractionRequest,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
) -> BatchExtractionResponse:
    job_ids = []
    duplicate_count = 0
    seen_normalized: set[str] = set()

    async with get_session() as session:
        repository = JobExtractionRepository(session)
        dedup_service = DeduplicationService(repository)

        for url in request.urls:
            url_str = str(url)

            is_valid, _ = URLManager.validate_url(url_str)
            if not is_valid:
                continue

            normalized_url = URLManager.normalize_url(url_str)
            if normalized_url in seen_normalized:
                duplicate_count += 1
                continue
            seen_normalized.add(normalized_url)

            extraction, is_duplicate = await dedup_service.check_and_create(
                url_str,
                request.force_refresh,
            )

            job_ids.append(extraction.id)

            if is_duplicate:
                duplicate_count += 1
            elif extraction.status == ExtractionStatus.PENDING:
                await enqueue_extraction(
                    extraction.id,
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
    """Submit a job link for duplication checking"""
    
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

        # Idempotency / safety: if the URL is already stored, return the existing row instead
        # of attempting to insert again (normalized_url is unique).
        existing_invalid_stmt = select(InvalidJob).where(InvalidJob.normalized_url == normalized_url)
        existing_invalid_result = await session.execute(existing_invalid_stmt)
        existing_invalid = existing_invalid_result.scalar_one_or_none()
        if existing_invalid:
            logger.info("jobs_submit_duplicate_invalid", job_id=existing_invalid.id, url=request.url)
            return JobSubmissionResponse(
                success=True,
                job_id=existing_invalid.id,
                is_duplicate=True,
                duplicate_job_id=existing_invalid.duplicate_of_job_id,
                message=f"Duplicate job detected: {existing_invalid.duplication_reason or 'Exact URL match'}",
            )

        existing_valid_stmt = select(ValidJob).where(ValidJob.normalized_url == normalized_url)
        existing_valid_result = await session.execute(existing_valid_stmt)
        existing_valid = existing_valid_result.scalar_one_or_none()
        if existing_valid:
            # If the URL is already in the valid table, treat this submission as a duplicate.
            invalid_job = InvalidJob(
                source_url=request.url,
                normalized_url=normalized_url,
                domain=duplication_checker.extract_domain(request.url),
                title=request.title or existing_valid.title,
                company=(request.company or existing_valid.company) or "Unknown",
                location=request.location or existing_valid.location,
                description=request.description or existing_valid.description,
                posted_date=request.posted_date or existing_valid.posted_date,
                experience_level=request.experience_level or existing_valid.experience_level,
                industry=request.industry or existing_valid.industry,
                duplicate_of_job_id=existing_valid.id,
                duplication_reason="Exact URL match",
                similarity_score=1.0,
                similarity_hash=duplication_checker.generate_content_hash(
                    request.title or existing_valid.title or "",
                    request.company or existing_valid.company or "",
                    request.description or existing_valid.description or "",
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

            session.add(invalid_job)
            try:
                await session.commit()
            except IntegrityError:
                await session.rollback()
                existing_invalid_result = await session.execute(
                    select(InvalidJob).where(InvalidJob.normalized_url == normalized_url)
                )
                existing_invalid = existing_invalid_result.scalar_one_or_none()
                if existing_invalid:
                    return JobSubmissionResponse(
                        success=True,
                        job_id=existing_invalid.id,
                        is_duplicate=True,
                        duplicate_job_id=existing_invalid.duplicate_of_job_id,
                        message=f"Duplicate job detected: {existing_invalid.duplication_reason or 'Exact URL match'}",
                    )
                raise

            logger.info("jobs_submit_duplicate_valid_url", valid_job_id=existing_valid.id, invalid_job_id=invalid_job.id, url=request.url)
            return JobSubmissionResponse(
                success=True,
                job_id=invalid_job.id,
                is_duplicate=True,
                duplicate_job_id=existing_valid.id,
                message="Duplicate job detected: Exact URL match",
            )
        
        # Check for duplicates
        is_duplicate, duplicate_info = await duplication_checker.comprehensive_duplicate_check(
            url=request.url,
            title=request.title or "",
            company=request.company or "",
            description=request.description or ""
        )
        
        if is_duplicate and duplicate_info:
            # If the duplication checker matched an existing invalid row (exact URL), do not insert another.
            if duplicate_info.get("match_type") == "exact_url" and duplicate_info.get("job_id"):
                existing_invalid_by_id_result = await session.execute(
                    select(InvalidJob).where(InvalidJob.id == duplicate_info.get("job_id"))
                )
                existing_invalid_by_id = existing_invalid_by_id_result.scalar_one_or_none()
                if existing_invalid_by_id:
                    return JobSubmissionResponse(
                        success=True,
                        job_id=existing_invalid_by_id.id,
                        is_duplicate=True,
                        duplicate_job_id=existing_invalid_by_id.duplicate_of_job_id,
                        message=f"Duplicate job detected: {existing_invalid_by_id.duplication_reason or 'Exact URL match'}",
                    )

            # Save to invalid jobs table
            invalid_job = InvalidJob(
                source_url=request.url,
                normalized_url=normalized_url,
                domain=duplication_checker.extract_domain(request.url),
                title=request.title,
                company=request.company or "Unknown",
                location=request.location,
                description=request.description,
                posted_date=request.posted_date,
                experience_level=request.experience_level,
                industry=request.industry,
                duplicate_of_job_id=duplicate_info.get("job_id"),
                duplication_reason=duplicate_info.get("duplication_reason"),
                similarity_score=duplicate_info.get("similarity_score"),
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
                        "industry": request.industry
                    }
                }
            )
            
            session.add(invalid_job)
            try:
                await session.commit()
            except IntegrityError:
                await session.rollback()
                # Another request inserted the same normalized_url (or it already exists).
                existing_invalid_result = await session.execute(
                    select(InvalidJob).where(InvalidJob.normalized_url == normalized_url)
                )
                existing_invalid = existing_invalid_result.scalar_one_or_none()
                if existing_invalid:
                    return JobSubmissionResponse(
                        success=True,
                        job_id=existing_invalid.id,
                        is_duplicate=True,
                        duplicate_job_id=existing_invalid.duplicate_of_job_id,
                        message=f"Duplicate job detected: {existing_invalid.duplication_reason or 'Exact URL match'}",
                    )
                raise
            
            logger.info(
                "jobs_submit_duplicate_detected",
                job_id=invalid_job.id,
                duplicate_of=duplicate_info.get("job_id"),
                reason=duplicate_info.get("duplication_reason"),
                url=request.url,
            )
            return JobSubmissionResponse(
                success=True,
                job_id=invalid_job.id,
                is_duplicate=True,
                duplicate_job_id=duplicate_info.get("job_id"),
                message=f"Duplicate job detected: {duplicate_info.get('duplication_reason')}"
            )
        else:
            # Save to valid jobs table
            valid_job = ValidJob(
                source_url=request.url,
                normalized_url=normalized_url,
                domain=duplication_checker.extract_domain(request.url),
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
                        "industry": request.industry
                    }
                }
            )
            
            session.add(valid_job)
            try:
                await session.commit()
            except IntegrityError:
                await session.rollback()
                existing_valid_result = await session.execute(
                    select(ValidJob).where(ValidJob.normalized_url == normalized_url)
                )
                existing_valid = existing_valid_result.scalar_one_or_none()
                if existing_valid:
                    return JobSubmissionResponse(
                        success=True,
                        job_id=existing_valid.id,
                        is_duplicate=False,
                        duplicate_job_id=None,
                        message="Job submitted successfully",
                    )
                raise

            extraction_repo = JobExtractionRepository(session)
            extraction, created = await extraction_repo.get_or_create(
                source_url=request.url,
                normalized_url=normalized_url,
                domain=duplication_checker.extract_domain(request.url),
            )
            valid_job.extraction_id = extraction.id
            if extraction.status == ExtractionStatus.COMPLETED and extraction.completed_at:
                valid_job.scraped_at = extraction.completed_at
            await session.commit()

            # Enqueue whenever extraction is not completed (new or stuck PENDING).
            # Only requiring "created" left existing-but-never-processed extractions (e.g. from
            # /extract or a previous submit when worker was down) stuck in PENDING forever.
            if extraction.status != ExtractionStatus.COMPLETED:
                await enqueue_extraction(
                    extraction.id,
                    request.url,
                    user_id=current_user.get("user_id"),
                    background_tasks=background_tasks,
                )

            logger.info("jobs_submit_valid_created", job_id=valid_job.id, url=request.url, extraction_id=extraction.id)
            return JobSubmissionResponse(
                success=True,
                job_id=valid_job.id,
                is_duplicate=False,
                duplicate_job_id=None,
                message="Job submitted successfully"
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
    async with get_session() as session:
        stmt = (
            select(
                ValidJob,
                JobExtraction.status,
                JobMatchResult.overall_score,
                JobMatchInProgress.id.label("match_progress_id"),
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
                is_active=job.is_active,
                created_at=job.created_at,
                updated_at=job.updated_at,
            )
            for job, ext_status, match_score, match_progress_id in rows
        ]


@router.get("/jobs/valid/{job_id}", response_model=ValidJobResponse, dependencies=[Depends(get_current_user)])
async def get_valid_job(job_id: str) -> ValidJobResponse:
    async with get_session() as session:
        stmt = (
            select(ValidJob, JobExtraction.status)
            .select_from(ValidJob)
            .outerjoin(JobExtraction, ValidJob.extraction_id == JobExtraction.id)
            .where(ValidJob.id == job_id)
        )
        result = await session.execute(stmt)
        row = result.one_or_none()
        if not row:
            logger.warning("get_valid_job_not_found", job_id=job_id)
            raise HTTPException(status_code=404, detail="Valid job not found")
        job, ext_status = row
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
            is_active=job.is_active,
            created_at=job.created_at,
            updated_at=job.updated_at,
        )


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


@router.post("/jobs/valid/{job_id}/match", status_code=status.HTTP_202_ACCEPTED, dependencies=[Depends(get_current_user)])
async def trigger_job_match(
    job_id: str,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
):
    """Trigger AI job–profile match analysis. Returns 202 when queued, or 200 if already cached."""
    from app.storage.repository import JobMatchInProgressRepository

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    async with get_session() as session:
        match_repo = JobMatchRepository(session)
        existing = await match_repo.get(job_id, user_id)
        if existing:
            return {"status": "cached", "message": "Match already computed"}
        progress_repo = JobMatchInProgressRepository(session)
        in_prog = await session.execute(
            select(JobMatchInProgress).where(
                JobMatchInProgress.valid_job_id == job_id,
                JobMatchInProgress.user_id == user_id,
            )
        )
        if in_prog.scalar_one_or_none():
            return {"status": "queued", "message": "Match analysis already in progress"}
        valid_repo = ValidJobRepository(session)
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
    pool = await try_get_redis_pool()
    if pool and await _has_active_arq_worker(pool):
        await pool.enqueue_job("analyze_job_match", job_id, user_id)
        await pool.close()
        return {"status": "queued", "message": "Match analysis queued"}
    if background_tasks:
        from app.services.job_match_orchestrator import run_job_match_analysis
        background_tasks.add_task(run_job_match_analysis, job_id, user_id)
        return {"status": "queued", "message": "Match analysis started in background"}
    raise HTTPException(status_code=503, detail="No worker available to process match analysis")


class RescrapeRequest(BaseModel):
    url: str = Field(..., min_length=1, max_length=2048)


@router.post("/jobs/valid/{job_id}/rescrape", dependencies=[Depends(get_current_user)])
async def rescrape_valid_job(
    job_id: str,
    request: RescrapeRequest,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
):
    """Reset extraction for a valid job and re-enqueue it for scraping. Uses the URL from the request to ensure we scrape exactly the URL the user clicked on."""
    is_valid, error = URLManager.validate_url(request.url)
    if not is_valid:
        raise HTTPException(status_code=400, detail=f"Invalid URL: {error}")

    async with get_session() as session:
        stmt = (
            select(ValidJob)
            .where(ValidJob.id == job_id, ValidJob.is_active == True)
        )
        result = await session.execute(stmt)
        valid_job = result.scalar_one_or_none()
        if not valid_job:
            raise HTTPException(status_code=404, detail="Valid job not found")

        extraction_id = valid_job.extraction_id
        source_url = request.url.strip()
        duplication_checker = DuplicationChecker(session)
        normalized_url = duplication_checker.normalize_url(source_url)
        domain = duplication_checker.extract_domain(source_url)

        if not extraction_id:
            repo = JobExtractionRepository(session)
            extraction, _ = await repo.get_or_create(
                source_url=source_url,
                normalized_url=normalized_url,
                domain=domain,
            )
            valid_job.extraction_id = extraction.id
            valid_job.scraped_at = None
            await session.commit()
            extraction_id = extraction.id
        else:
            repo = JobExtractionRepository(session)
            await repo.reset_for_refresh(extraction_id, source_url, domain)
            valid_job.scraped_at = None
            await session.commit()

    await enqueue_extraction(
        extraction_id,
        source_url,
        user_id=current_user.get("user_id"),
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
        result = await session.execute(select(ValidJob).where(ValidJob.id == job_id))
        job = result.scalar_one_or_none()
        if not job:
            logger.warning("delete_valid_job_not_found", job_id=job_id)
            raise HTTPException(status_code=404, detail="Valid job not found")

        await session.delete(job)
        await session.commit()
        logger.info("delete_valid_job_success", job_id=job_id)
        return {"success": True}


@router.delete("/jobs/invalid/{job_id}", dependencies=[Depends(get_current_user)])
async def delete_invalid_job(job_id: str) -> dict:
    async with get_session() as session:
        result = await session.execute(select(InvalidJob).where(InvalidJob.id == job_id))
        job = result.scalar_one_or_none()
        if not job:
            logger.warning("delete_invalid_job_not_found", job_id=job_id)
            raise HTTPException(status_code=404, detail="Invalid job not found")

        await session.delete(job)
        await session.commit()
        logger.info("delete_invalid_job_success", job_id=job_id)
        return {"success": True}
