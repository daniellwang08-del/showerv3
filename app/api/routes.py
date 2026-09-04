from fastapi import APIRouter, HTTPException, Depends, BackgroundTasks, Request, Response, status, Cookie, File, UploadFile, Query
from fastapi.responses import FileResponse, StreamingResponse
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
    DashboardRevisionResponse,
    DashboardSyncResponse,
)
from app.models.auth_schemas import SignupRequest, LoginRequest, AuthResponse, UserResponse, ProfileUpdateRequest
from app.models.profile_schemas import ProfileResponse, ProfileCreateRequest, ResumeParseResponse
from app.models.profile_source_schemas import (
    ProfileSourceDocumentListResponse,
    ProfileSourceDocumentResponse,
    ProfileSourceDocumentUpdateRequest,
    ProfileSourceDocumentUploadResponse,
)
from app.models.resume_design_schemas import ResumeDesign, ResumeDesignSaveRequest
from app.models.resume_ai_schemas import ResumeAiChatRequest
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
from sqlalchemy import delete as sa_delete, select, func, update as sa_update, nullslast, text, and_, or_
from sqlalchemy.exc import IntegrityError
import asyncio
from datetime import datetime, timedelta, timezone
from app.utils.text_sanitizer import sanitize_for_postgres_text
from app.services.attachment_text_extract import combine_file_texts, extract_text_from_bytes
from app.services.attachment_job_url_ai import extract_job_urls_from_text_combined
from app.services.job_field_utils import resolve_display_work_mode, resolve_job_display_title
from app.storage.repository import _utcnow
from app.utils.date_bounds import day_bounds_for_timezone
from app.utils.profile_errors import format_profile_unexpected_error

router = APIRouter()
logger = get_logger(__name__)


def _openai_api_error() -> type[Exception]:
    """Lazily resolve ``openai.APIError`` for ``except`` clauses.

    Importing the OpenAI SDK at module load added ~1 s to API startup. These
    handlers only run after an LLM call (which already imported the SDK), so
    resolving the class on demand keeps startup fast without changing behavior.
    """
    from openai import APIError

    return APIError

def _check_domain_blocked(domain: str) -> str | None:
    """Return block reason if the domain (or its parent) is in the blocklist, else None."""
    from app.services.blocked_domains_service import get_blocked_reason

    return get_blocked_reason(domain)


def _check_extraction_blocked(url: str) -> str | None:
    """Return a block reason when *url* must not enter extraction, else None."""
    from app.services.linkedin_job_filter import linkedin_job_block_reason

    domain = URLManager.extract_domain(url)
    domain_reason = _check_domain_blocked(domain)
    if domain_reason:
        return domain_reason
    return linkedin_job_block_reason(url)


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


class ValidJobDeleteBatchRequest(BaseModel):
    """Job ids to remove. For admins this hard-deletes the shared job (platform
    curation); for applicants it only hides the job from their own list."""
    job_ids: list[str] = Field(default_factory=list, max_length=2000)


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


async def _hide_job_for_user(session, job_id: str, user_id: str) -> bool:
    """Applicant-scoped 'delete': hide the shared job from this user's list only.

    `jobs` is a shared multi-tenant table — a non-admin must never cascade-delete
    the row (that would destroy every other user's match/application/resume data).
    Instead we upsert a per-user manual_hidden status, exactly like report-invalid.
    Returns False when the job does not exist.
    """
    exists = await session.execute(select(Job.id).where(Job.id == job_id).limit(1))
    if exists.scalar_one_or_none() is None:
        return False
    await UserJobStatusRepository(session).upsert(
        user_id=user_id,
        job_id=job_id,
        status="manual_hidden",
        exclusion_type="manual_invalid",
        reason="Removed from your list",
    )
    return True


def _extract_bearer_token(request: Request) -> str | None:
    """Return the JWT from an `Authorization: Bearer <token>` header, if present.

    Non-cookie clients (e.g. the browser extension) authenticate this way; the
    web app continues to rely on the HttpOnly `access_token` cookie.
    """
    header = request.headers.get("authorization") or request.headers.get("Authorization")
    if not header:
        return None
    parts = header.split(" ", 1)
    if len(parts) == 2 and parts[0].lower() == "bearer" and parts[1].strip():
        return parts[1].strip()
    return None


def _request_access_token(request: Request) -> str | None:
    """Pick the JWT for this request.

    An explicit `Authorization: Bearer` header always wins. Chrome may attach
    the web app's `access_token` cookie to extension fetches (host permissions),
    and that cookie can be expired or revoked even while the extension is
    signing in with a fresh bearer token. Cookie-only clients (the dashboard)
    are unchanged: they do not send Bearer.
    """
    return _extract_bearer_token(request) or request.cookies.get("access_token")


def _auth_cookie_params(*, max_age: int | None = None) -> dict:
    """Shared flags for access_token cookies across apex + logs subdomain."""
    from urllib.parse import urlparse

    from app.core.config import get_settings

    settings = get_settings()
    params: dict = {
        "httponly": True,
        "samesite": "lax",
        "secure": settings.app_env == "production",
        "path": "/",
    }
    if max_age is not None:
        params["max_age"] = max_age

    domain = (settings.auth_cookie_domain or "").strip()
    if not domain and settings.app_env == "production":
        frontend = (settings.frontend_url or "").strip()
        if frontend:
            host = (urlparse(frontend).hostname or "").lower()
            if host.startswith("www."):
                host = host[4:]
            if host and "." in host and not host.startswith("localhost"):
                domain = f".{host}"
    if domain:
        params["domain"] = domain
    return params


async def get_current_user(request: Request):
    token = _request_access_token(request)
    if not token:
        logger.warning("auth_required_missing_token")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    payload = AuthService.verify_token(token)
    if not payload:
        logger.warning("auth_required_invalid_token")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    # Reject tokens explicitly revoked at logout (fail-open if Redis is down).
    from app.services.token_denylist import is_jti_revoked

    if await is_jti_revoked(payload.get("jti")):
        logger.warning("auth_required_revoked_token")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token revoked")

    user_id: str | None = None
    uid = payload.get("user_id")
    if uid is not None and str(uid).strip():
        user_id = str(uid).strip()
    elif isinstance(payload.get("sub"), str) and payload["sub"].strip():
        async with get_session() as session:
            user_repo = UserRepository(session)
            user = await user_repo.get_by_email(payload["sub"].lower().strip())
            if user:
                user_id = user.id

    if not user_id:
        bind_logging_context(user_email=payload.get("sub"))
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    # Reject deactivated accounts even if the JWT is still valid.
    async with get_session() as session:
        user_repo = UserRepository(session)
        user = await user_repo.get_by_id(user_id)
        if not user or not user.is_active:
            logger.warning("auth_required_inactive_user", user_id=user_id)
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Account disabled")
        bind_logging_context(user_id=user.id, user_email=user.email)
        try:
            request.state.user_id = user.id
        except Exception:
            pass
        return {
            **payload,
            "user_id": user.id,
            "is_admin": bool(getattr(user, "is_admin", False)),
            "is_active": True,
        }


async def require_admin(current_user: dict = Depends(get_current_user)) -> dict:
    """Require an active admin user. Use as Depends(require_admin) on admin routes."""
    if not current_user.get("is_admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return current_user


async def require_applicant(current_user: dict = Depends(get_current_user)) -> dict:
    """Applicant-only routes (Integrations, Sheets/Pumble posting, AI assistant)."""
    if current_user.get("is_admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Available to applicant accounts only",
        )
    return current_user


@router.post("/auth/signup", response_model=AuthResponse)
async def signup(request: SignupRequest, response: Response, http_request: Request) -> AuthResponse:
    """Register a new user with email and password"""
    normalized_email = request.email.lower().strip()

    from app.api.rate_limit import enforce_auth_rate_limit

    await enforce_auth_rate_limit(http_request, scope="signup", email=normalized_email)

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
                **_auth_cookie_params(max_age=86400),
            )
            
            logger.info("user_signup_success", email=user.email, user_id=user.id)
            
            return AuthResponse(
                success=True,
                message="Account created successfully",
                email=user.email,
                user_id=user.id,
                access_token=access_token,
                token_type="bearer",
                expires_in=86400,
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
async def login(request: LoginRequest, response: Response, http_request: Request) -> AuthResponse:
    """Login with email and password"""
    normalized_email = request.email.lower().strip()

    from app.api.rate_limit import enforce_auth_rate_limit

    await enforce_auth_rate_limit(http_request, scope="login", email=normalized_email)

    async with get_session() as session:
        user_repo = UserRepository(session)

        existing = await user_repo.get_by_email(normalized_email)
        if not existing:
            logger.warning("user_login_failed", email=normalized_email, reason="not_registered")
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="You are not registered in this system. Please sign up first.",
            )

        user = await user_repo.verify_credentials(normalized_email, request.password)
        if not user:
            reason = "inactive" if not existing.is_active else "invalid_password"
            logger.warning("user_login_failed", email=normalized_email, reason=reason)
            if not existing.is_active:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="This account is inactive. Contact an administrator.",
                )
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid email or password",
            )
        
        # Long-lived token for non-cookie clients (extension); default 24h otherwise.
        if request.long_lived:
            from app.services.system_settings_service import get_effective_value

            expire_days = int(await get_effective_value("extension_token_expire_days", session))
            expires_seconds = expire_days * 86400
            expires_delta = timedelta(days=expire_days)
        else:
            expires_seconds = 86400
            expires_delta = None

        access_token = AuthService.create_access_token(
            data={"sub": user.email, "user_id": user.id},
            expires_delta=expires_delta,
        )
        # Bearer-only clients (the extension) must not overwrite or share the
        # dashboard cookie: logging out of the web app would denylist the same
        # jti and immediately invalidate the extension session.
        if not request.long_lived:
            response.set_cookie(
                key="access_token",
                value=access_token,
                **_auth_cookie_params(max_age=expires_seconds),
            )
        
        logger.info("user_login_success", email=user.email, user_id=user.id, long_lived=request.long_lived)
        
        return AuthResponse(
            success=True,
            message="Logged in successfully",
            email=user.email,
            user_id=user.id,
            access_token=access_token,
            token_type="bearer",
            expires_in=expires_seconds,
        )


@router.post("/auth/logout")
async def logout(response: Response, request: Request):
    # Revoke the presented token so a stolen/long-lived bearer (extension tokens
    # live up to 30 days) cannot be reused after logout. Best-effort/fail-open.
    token = _request_access_token(request)
    if token:
        payload = AuthService.verify_token(token)
        if payload and payload.get("jti"):
            exp = payload.get("exp")
            now_ts = int(datetime.now(timezone.utc).timestamp())
            ttl = int(exp) - now_ts if isinstance(exp, (int, float)) else 0
            if ttl > 0:
                from app.services.token_denylist import revoke_jti

                await revoke_jti(payload["jti"], ttl)

    response.delete_cookie(
        key="access_token",
        **{k: v for k, v in _auth_cookie_params().items() if k != "max_age"},
    )
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
            is_admin=bool(getattr(user, "is_admin", False)),
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
            is_admin=bool(getattr(user, "is_admin", False)),
            created_at=user.created_at,
        )


# ---- User profile (single profile per account) ----

def _as_dict_list(value) -> list[dict]:
    if not isinstance(value, list):
        return []
    return [item if isinstance(item, dict) else {} for item in value]


def _as_str_list(value) -> list[str]:
    if isinstance(value, str):
        return [ln.strip() for ln in value.splitlines() if ln.strip()]
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        if isinstance(item, str) and item.strip():
            out.append(item)
    return out


def _as_dict(value) -> dict:
    return value if isinstance(value, dict) else {}


def _user_to_profile_response(u) -> ProfileResponse:
    """Build a ProfileResponse, coercing legacy / malformed JSON columns.

    Stored JSON can predate schema changes (string ``extra``, non-dict skill
    rows). Coercing here keeps GET /profile from raising a validation error
    that would blank the profile page.
    """
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
        technical_skills=_as_dict_list(getattr(u, "technical_skills", None)),
        work_experience=_as_dict_list(getattr(u, "work_experience", None)),
        education=_as_dict_list(getattr(u, "education", None)),
        certificates=_as_dict_list(getattr(u, "certificates", None)),
        extra=_as_str_list(getattr(u, "extra", None)),
        eeo_preferences=_as_dict(getattr(u, "eeo_preferences", None)),
        address=_as_dict(getattr(u, "address", None)),
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
        "eeo_preferences": req.eeo_preferences.model_dump(),
        "address": req.address.model_dump(),
    }


@router.get("/profile", response_model=ProfileResponse)
async def get_profile(current_user: dict = Depends(get_current_user)) -> ProfileResponse:
    """Get current user's profile."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    try:
        async with get_session() as session:
            repo = UserRepository(session)
            user = await repo.get_by_id(user_id)
            if not user:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
            return _user_to_profile_response(user)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("get_profile_failed", user_id=user_id, error=str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=format_profile_unexpected_error(e, "Failed to load profile"),
        )


@router.put("/profile", response_model=ProfileResponse)
async def put_profile(
    request: ProfileCreateRequest,
    current_user: dict = Depends(get_current_user),
) -> ProfileResponse:
    """Create or update current user's profile."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    try:
        async with get_session() as session:
            repo = UserRepository(session)
            user, _ = await repo.update_profile(user_id, _request_to_profile_data(request))
            if not user:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
            await session.commit()

        # Vector match engine: refresh the profile encoding (skips when unchanged).
        try:
            from app.tasks.worker import enqueue_encode_user

            await enqueue_encode_user(user_id)
        except Exception as enc_err:
            logger.warning(
                "encode_user_enqueue_after_profile_save_failed",
                user_id=user_id,
                error=str(enc_err),
            )

        async with get_session() as session:
            repo = UserRepository(session)
            user = await repo.get_by_id(user_id)
            if not user:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
            return _user_to_profile_response(user)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("put_profile_failed", user_id=user_id, error=str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=format_profile_unexpected_error(e, "Failed to save profile"),
        )


async def _apply_detected_countries_from_resume(user_id: str, result) -> None:
    """Auto-set country preferences from a parsed resume (never over manual).

    Mutates ``result`` with the detection outcome and schedules a location
    reconcile so existing jobs re-bucket under the new preference.
    """
    from app.services.resume_parse_service import infer_country_preferences

    detected = infer_country_preferences(result.draft)
    result.detected_countries = detected
    if not detected:
        return
    async with get_session() as session:
        repo = UserRepository(session)
        applied = await repo.autoset_country_preferences_from_resume(user_id, detected)
        await session.commit()
    if applied is None:
        return
    result.country_preferences_applied = True
    logger.info(
        "country_preferences_autodetected_from_resume",
        user_id=user_id,
        countries=applied,
    )
    from app.services.job_location_reconcile import reconcile_job_locations_for_user

    async def _reconcile() -> None:
        try:
            await reconcile_job_locations_for_user(user_id)
        except Exception as e:
            logger.warning(
                "country_preferences_reconcile_failed",
                user_id=user_id,
                error=str(e),
            )

    asyncio.create_task(_reconcile())


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
        try:
            await _apply_detected_countries_from_resume(user_id, result)
        except Exception as country_err:
            # Country auto-detect must never fail the parse itself.
            logger.warning(
                "resume_parse_country_autodetect_failed",
                user_id=user_id,
                error=str(country_err),
            )
        logger.info(
            "resume_parse_ok",
            user_id=user_id,
            source_kind=result.source_kind,
            detected_countries=result.detected_countries,
            country_preferences_applied=result.country_preferences_applied,
        )
        return result
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=format_profile_unexpected_error(e, str(e) or "Could not read this file"),
        )
    except AIParsingError as e:
        logger.warning("resume_parse_ai_failed", error=str(e))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=format_profile_unexpected_error(
                e,
                "Résumé parsing failed. Check your AI API key in My Preferences and try again.",
            ),
        )
    except _openai_api_error() as e:
        logger.warning("resume_parse_openai_error", error=str(e))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=format_profile_unexpected_error(
                e,
                "Résumé parsing is temporarily unavailable. Please try again later.",
            ),
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
            detail=format_profile_unexpected_error(e, "Résumé parsing failed. See server logs for details."),
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
    """Upload a PDF, DOCX, or Markdown (.md) file with detailed per-company project descriptions."""
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
            content_type=file.content_type,
        )
        logger.info(
            "profile_source_document_uploaded",
            user_id=user_id,
            doc_id=result.document.id,
            parse_status=result.document.parse_status,
        )
        return result
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=format_profile_unexpected_error(e, str(e) or "Could not read this file"),
        )
    except AIParsingError as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=format_profile_unexpected_error(e, "Document parsing failed."),
        )
    except Exception as e:
        logger.exception("profile_source_document_upload_failed", error=str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=format_profile_unexpected_error(e, "Upload failed. See server logs for details."),
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
            hint=(
                "Start Redis (docker compose up -d redis) and run workers via "
                "run_worker.py (systemd on the VPS)."
            ),
        )
        return None


async def try_get_extraction_pool():
    from app.tasks.worker import get_extraction_pool, EXTRACTION_QUEUE
    return await _try_pool(get_extraction_pool, EXTRACTION_QUEUE)


async def try_get_analysis_pool():
    from app.tasks.worker import get_analysis_pool, ANALYSIS_QUEUE
    return await _try_pool(get_analysis_pool, ANALYSIS_QUEUE)


async def try_get_save_pool():
    from app.tasks.worker import get_save_pool, SAVE_QUEUE
    return await _try_pool(get_save_pool, SAVE_QUEUE)


def _raise_queue_unavailable(operation: str) -> None:
    from app.core.redis_support import require_redis_for_jobs

    if require_redis_for_jobs():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                f"Job queue unavailable (Redis). Cannot {operation}. "
                "Retry after Redis and workers are healthy."
            ),
        )


async def enqueue_extraction(
    extraction_id: str,
    url: str,
    *,
    user_id: str | None = None,
    background_tasks: BackgroundTasks | None = None,
    skip_phase_b: bool = False,
    chain_analysis: bool = True,
) -> None:
    """
    Prefer Redis/arq whenever Redis is reachable (jobs wait in queue until a worker runs).
    Fall back in-process only when Redis is down and APP_ENV is not production.

    ``chain_analysis`` / ``skip_phase_b`` control post-extract personal pipeline depth
    when ``user_id`` is set (manual submit preference).
    """
    from app.core.redis_support import allow_in_process_job_fallback, pipeline_job_id
    from app.tasks.worker import EXTRACTION_QUEUE

    pool = await try_get_extraction_pool()
    bind_logging_context(extraction_id=extraction_id, target_url=url, user_id=user_id)
    if pool:
        try:
            job_id = pipeline_job_id("extract", extraction_id)
            job = await pool.enqueue_job(
                "extract_job",
                extraction_id,
                url,
                user_id,
                bool(skip_phase_b),
                bool(chain_analysis),
                _job_id=job_id,
            )
            logger.info(
                "extraction_enqueued_redis",
                extraction_id=extraction_id,
                url=url,
                queue=EXTRACTION_QUEUE,
                arq_job_id=job_id,
                already_queued=job is None,
                skip_phase_b=bool(skip_phase_b),
                chain_analysis=bool(chain_analysis),
            )
            return
        except Exception as e:
            logger.warning("extraction_redis_enqueue_failed", extraction_id=extraction_id, error=str(e))

    if allow_in_process_job_fallback() and background_tasks:
        background_tasks.add_task(
            process_extraction_sync,
            extraction_id,
            url,
            user_id,
            bool(skip_phase_b),
            bool(chain_analysis),
        )
        logger.info("extraction_enqueued_in_process", extraction_id=extraction_id, url=url)
        return

    _raise_queue_unavailable("enqueue extraction")
    logger.error(
        "extraction_not_enqueued",
        extraction_id=extraction_id,
        reason="No Redis and no in-process fallback available",
    )


async def _run_analyze_and_enqueue_save(
    job_id: str,
    user_id: str,
    *,
    extraction_id: str | None = None,
    skip_phase_b: bool = False,
) -> None:
    """In-process Phase A then enqueue (or run) save → tailor chain.

    ``run_job_match_analysis`` alone does not persist the match or start Phase B;
    the Redis worker does that via ``save_analyzed_job``. This mirrors that chain
    when Redis analysis queue is unavailable.
    """
    from app.core.redis_support import pipeline_job_id
    from app.services.job_match_orchestrator import run_job_match_analysis

    result = await run_job_match_analysis(
        job_id,
        user_id,
        extraction_id=extraction_id,
        skip_phase_b=bool(skip_phase_b),
    )
    if not result:
        await publish_ws_event({
            "type": "match_failed",
            "user_id": user_id,
            "valid_job_id": job_id,
            "error": "Match analysis returned no result",
        })
        return

    pool = await try_get_save_pool()
    if pool:
        try:
            import uuid

            arq_id = pipeline_job_id("save", job_id, user_id)
            job = await pool.enqueue_job(
                "save_analyzed_job",
                job_id,
                user_id,
                extraction_id,
                result,
                _job_id=arq_id,
            )
            if job is None:
                retry_id = pipeline_job_id(
                    "save", job_id, user_id, f"r{uuid.uuid4().hex[:10]}"
                )
                job = await pool.enqueue_job(
                    "save_analyzed_job",
                    job_id,
                    user_id,
                    extraction_id,
                    result,
                    _job_id=retry_id,
                )
                logger.info(
                    "save_after_match_enqueued_unique_retry",
                    job_id=job_id,
                    user_id=user_id,
                    arq_job_id=retry_id,
                    already_queued=job is None,
                )
            if job is not None:
                return
            logger.warning(
                "save_after_match_redis_enqueue_collision",
                job_id=job_id,
                user_id=user_id,
            )
        except Exception as e:
            logger.warning(
                "save_after_match_redis_enqueue_failed",
                job_id=job_id,
                user_id=user_id,
                error=str(e),
            )

    from app.tasks.worker import save_analyzed_job

    await save_analyzed_job(
        {"redis": None},
        job_id,
        user_id,
        extraction_id,
        result,
    )


async def enqueue_job_match_analysis(
    job_id: str,
    user_id: str,
    *,
    background_tasks: BackgroundTasks | None = None,
    extraction_id: str | None = None,
    force_requeue: bool = False,
    skip_phase_b: bool = False,
) -> None:
    """
    Prefer Redis/arq for match analysis; fall back to FastAPI BackgroundTasks
    only outside production. Uses the dedicated analysis queue.

    The analysis worker enqueues ``save_analyzed_job`` (persist + Phase B). The
    in-process fallback must do the same via ``_run_analyze_and_enqueue_save``.

    ``force_requeue`` uses an alternate arq id when the stable id is already
    reserved (stale/in-flight), so Prepare/retry never silently no-ops.
    """
    from app.core.redis_support import allow_in_process_job_fallback, pipeline_job_id
    from app.tasks.worker import ANALYSIS_QUEUE

    pool = await try_get_analysis_pool()
    bind_logging_context(job_id=job_id, user_id=user_id)
    skip_b = bool(skip_phase_b)
    if pool:
        try:
            arq_id = pipeline_job_id("analyze", job_id, user_id)
            job = await pool.enqueue_job(
                "analyze_job_match",
                job_id,
                user_id,
                extraction_id,
                skip_b,
                _job_id=arq_id,
            )
            if job is None and force_requeue:
                import uuid

                retry_id = pipeline_job_id("analyze", job_id, user_id, "retry")
                job = await pool.enqueue_job(
                    "analyze_job_match",
                    job_id,
                    user_id,
                    extraction_id,
                    skip_b,
                    _job_id=retry_id,
                )
                if job is None:
                    uniq_id = pipeline_job_id(
                        "analyze", job_id, user_id, f"r{uuid.uuid4().hex[:10]}"
                    )
                    job = await pool.enqueue_job(
                        "analyze_job_match",
                        job_id,
                        user_id,
                        extraction_id,
                        skip_b,
                        _job_id=uniq_id,
                    )
                    retry_id = uniq_id
                logger.info(
                    "job_match_enqueued_redis_retry",
                    job_id=job_id,
                    user_id=user_id,
                    queue=ANALYSIS_QUEUE,
                    arq_job_id=retry_id,
                    already_queued=job is None,
                    skip_phase_b=skip_b,
                )
            else:
                logger.info(
                    "job_match_enqueued_redis",
                    job_id=job_id,
                    user_id=user_id,
                    queue=ANALYSIS_QUEUE,
                    arq_job_id=arq_id,
                    already_queued=job is None,
                    skip_phase_b=skip_b,
                )
            return
        except Exception as e:
            logger.warning("job_match_redis_enqueue_failed", job_id=job_id, error=str(e))

    if allow_in_process_job_fallback() and background_tasks:
        background_tasks.add_task(
            _run_analyze_and_enqueue_save,
            job_id,
            user_id,
            extraction_id=extraction_id,
            skip_phase_b=skip_b,
        )
        logger.info("job_match_enqueued_in_process", job_id=job_id, user_id=user_id)
        return

    if allow_in_process_job_fallback():
        await _run_analyze_and_enqueue_save(
            job_id, user_id, extraction_id=extraction_id, skip_phase_b=skip_b
        )
        return

    _raise_queue_unavailable("enqueue match analysis")
    logger.error(
        "job_match_not_enqueued",
        job_id=job_id,
        user_id=user_id,
        reason="No Redis and no in-process fallback available",
    )


async def _fallback_job_match_after_extraction(
    job_id: str,
    user_id: str,
    *,
    skip_phase_b: bool = False,
) -> None:
    """Run match+save chain so extraction (BackgroundTasks) does not block on OpenAI."""
    try:
        await _run_analyze_and_enqueue_save(
            job_id, user_id, skip_phase_b=bool(skip_phase_b)
        )
    except Exception as match_err:
        logger.warning(
            "fallback_job_match_failed",
            job_id=job_id,
            user_id=user_id,
            error=str(match_err),
        )


async def start_personal_job_analysis(
    job_id: str,
    user_id: str,
    *,
    background_tasks: BackgroundTasks | None = None,
    force: bool = False,
    skip_phase_b: bool = False,
) -> dict:
    """Queue per-user analysis for a job that already has (or will use) shared JD.

    Returns a small status dict: queued | cached | in_progress | error detail keys.

    If a progress row already exists (stuck/aborted worker), still re-enqueue
    analysis so Prepare never silently no-ops.
    """
    from app.services.job_pipeline_mode import extraction_has_shared_jd
    from app.storage.repository import JobMatchInProgressRepository

    already_in_progress = False
    extraction_id: str | None = None

    async with get_session() as session:
        progress_repo = JobMatchInProgressRepository(session)
        match_repo = JobMatchRepository(session)
        in_prog = await session.execute(
            select(JobMatchInProgress).where(
                JobMatchInProgress.job_id == job_id,
                JobMatchInProgress.user_id == user_id,
            )
        )
        already_in_progress = in_prog.scalar_one_or_none() is not None

        existing = await match_repo.get(job_id, user_id)
        if existing and not force and not already_in_progress:
            return {"status": "cached", "message": "Match already computed"}
        if existing and force:
            await match_repo.delete(job_id, user_id)

        r = await session.execute(select(Job).where(Job.id == job_id, Job.status == "active"))
        job = r.scalar_one_or_none()
        if not job or not job.extraction_id:
            return {"status": "error", "message": "Job has no scraped description yet"}

        extraction_repo = JobExtractionRepository(session)
        extraction = await extraction_repo.get_by_id(job.extraction_id)
        if not extraction_has_shared_jd(extraction):
            return {"status": "error", "message": "Job description not yet scraped"}

        if not already_in_progress:
            await progress_repo.add(job_id, user_id)
        await session.commit()
        extraction_id = job.extraction_id

    await enqueue_job_match_analysis(
        job_id,
        user_id,
        background_tasks=background_tasks,
        extraction_id=extraction_id,
        force_requeue=already_in_progress or force,
        skip_phase_b=bool(skip_phase_b),
    )
    return {
        "status": "queued",
        "message": (
            "Match analysis re-queued"
            if already_in_progress
            else "Match analysis queued"
        ),
    }


async def prepare_job_for_user(
    job_id: str,
    user_id: str,
    *,
    background_tasks: BackgroundTasks | None = None,
    force_rescrape: bool = False,
    allow_force_rescrape: bool = False,
) -> dict:
    """Smart entry for applicants: analyze if JD ready, else extract then analyze.

    Applicants cannot force re-extract when a shared JD already exists
    (``allow_force_rescrape`` is admin-only). When extraction is already
    pending/processing, we wait for that shared extract and then analyze —
    never reset mid-flight.
    """
    from app.services.job_pipeline_mode import extraction_has_shared_jd

    async with get_session() as session:
        job = await _get_job_for_rescrape(session, job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Valid job not found")

        source_url = (job.source_url or "").strip()
        if not source_url:
            raise HTTPException(status_code=400, detail="This job has no URL")

        extraction_repo = JobExtractionRepository(session)
        extraction = None
        if job.extraction_id:
            extraction = await extraction_repo.get_by_id(job.extraction_id)

        jd_ready = bool(extraction_has_shared_jd(extraction))
        if force_rescrape and jd_ready and not allow_force_rescrape:
            raise HTTPException(
                status_code=403,
                detail=(
                    "Shared job description already exists. "
                    "Re-extract is admin-only; use prepare/analyze instead."
                ),
            )

        # In-flight shared extract: do not reset; chain personal analysis after it.
        status_l = (getattr(extraction, "status", None) or "").lower() if extraction else ""
        if extraction and status_l in ("pending", "processing") and not (
            force_rescrape and allow_force_rescrape
        ):
            await session.commit()
            await enqueue_extraction(
                extraction.id,
                source_url,
                user_id=user_id,
                background_tasks=background_tasks,
            )
            return {
                "status": "queued",
                "mode": "extract_then_analyze",
                "job_id": job_id,
                "extraction_id": extraction.id,
                "message": "Extraction already in progress; analysis will follow for your profile.",
            }

        if jd_ready and not (force_rescrape and allow_force_rescrape):
            pass
        else:
            try:
                extraction_id = await _prepare_job_rescrape_in_session(
                    session, job, source_url, user_id
                )
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e)) from e
            await session.commit()
            await enqueue_extraction(
                extraction_id,
                source_url,
                user_id=user_id,
                background_tasks=background_tasks,
            )
            return {
                "status": "queued",
                "mode": "extract_then_analyze",
                "job_id": job_id,
                "extraction_id": extraction_id,
                "message": "Extraction queued; analysis will follow for your profile.",
            }

    result = await start_personal_job_analysis(
        job_id,
        user_id,
        background_tasks=background_tasks,
        force=True,
    )
    if result.get("status") == "error":
        raise HTTPException(status_code=400, detail=result["message"])
    return {
        "status": result["status"],
        "mode": "analyze",
        "job_id": job_id,
        "message": result.get("message")
        or "Analysis queued using the saved job description.",
    }


async def prepare_shared_job_extraction(
    job_id: str,
    *,
    background_tasks: BackgroundTasks | None = None,
    force_rescrape: bool = False,
) -> dict:
    """Admin / platform: ensure shared JD exists (extract-only, never analyze)."""
    from app.services.job_pipeline_mode import extraction_has_shared_jd

    async with get_session() as session:
        job = await _get_job_for_rescrape(session, job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Valid job not found")

        source_url = (job.source_url or "").strip()
        if not source_url:
            raise HTTPException(status_code=400, detail="This job has no URL")

        extraction_repo = JobExtractionRepository(session)
        extraction = None
        if job.extraction_id:
            extraction = await extraction_repo.get_by_id(job.extraction_id)

        if extraction_has_shared_jd(extraction) and not force_rescrape:
            return {
                "status": "ready",
                "mode": "extract_only",
                "job_id": job_id,
                "extraction_id": job.extraction_id,
                "message": "Shared job description already prepared.",
            }

        try:
            extraction_id = await _prepare_job_rescrape_in_session(
                session, job, source_url, None
            )
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        await session.commit()

    await enqueue_extraction(
        extraction_id,
        source_url,
        user_id=None,
        background_tasks=background_tasks,
    )
    return {
        "status": "queued",
        "mode": "extract_only",
        "job_id": job_id,
        "extraction_id": extraction_id,
        "message": "Extraction queued (admin inventory prep).",
    }


async def _fallback_match_batch_parallel(user_id: str, job_ids: list[str]) -> None:
    """
    When Redis is unavailable, run many matches with bounded concurrency (not one-by-one
    Starlette background tasks, which would serialize all match calls).
    """
    from app.services.system_settings_service import get_effective_value_sync

    sem = asyncio.Semaphore(max(1, int(get_effective_value_sync("analysis_worker_max_jobs"))))

    async def one(jid: str) -> None:
        async with sem:
            try:
                await _run_analyze_and_enqueue_save(jid, user_id)
            except Exception as e:
                logger.warning("fallback_batch_job_match_failed", job_id=jid, error=str(e))

    await asyncio.gather(*(one(jid) for jid in job_ids))


@router.get("/health", response_model=HealthResponse)
async def health_check() -> HealthResponse:
    settings = get_settings()
    db_connected = await check_database_connection()

    redis_connected = False
    try:
        from app.core.redis_support import redis_health

        health = await redis_health()
        redis_connected = bool(health.get("ok"))
    except Exception:
        redis_connected = False

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
    skip_phase_b: bool = False,
    chain_analysis: bool = True,
) -> None:
    from app.services.extraction_service import ExtractionService
    from app.storage.repository import JobRepository

    try:
        service = ExtractionService()
        result = await service.process_job(extraction_id, url)
        if result.get("status") == "extracted":
            # Scrape-only stays EXTRACTED (shared JD ready). Do not promote to
            # COMPLETED — that status means Phase A structured the posting.
            if user_id and chain_analysis:
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
                    asyncio.create_task(
                        _fallback_job_match_after_extraction(
                            found_job_id,
                            user_id,
                            skip_phase_b=bool(skip_phase_b),
                        )
                    )
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

    block_reason = _check_extraction_blocked(url)
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
        from app.services.job_pipeline_mode import ingest_chain_user_id

        await enqueue_extraction(
            extraction_id,
            url,
            user_id=ingest_chain_user_id(
                is_admin=bool(current_user.get("is_admin")),
                user_id=current_user.get("user_id"),
            ),
            background_tasks=background_tasks,
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
            if _check_extraction_blocked(url_str):
                continue

            extraction = await repository.create(
                source_url=url_str,
                normalized_url=url_str,
                domain=domain,
            )

            job_ids.append(extraction.id)
            to_enqueue.append((extraction.id, url_str))

    from app.services.job_pipeline_mode import ingest_chain_user_id

    chain_user_id = ingest_chain_user_id(
        is_admin=bool(current_user.get("is_admin")),
        user_id=current_user.get("user_id"),
    )
    for extraction_id, url_str in to_enqueue:
        await enqueue_extraction(
            extraction_id,
            url_str,
            user_id=chain_user_id,
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
            remote_policy=extraction.remote_policy,
            work_mode=extraction.work_mode,
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

    Pipeline ownership:
    - Admin: extraction only (shared JD inventory).
    - Applicant: depth from ``manual_submit_pipeline`` (extract | match | full).
    """
    from app.services.job_pipeline_mode import (
        extraction_has_shared_jd,
        manual_submit_enqueue_flags,
        normalize_manual_submit_pipeline,
    )

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
    is_admin = bool(current_user.get("is_admin"))
    pipeline = "full"
    if user_id and not is_admin:
        async with get_session() as session:
            user_repo = UserRepository(session)
            user = await user_repo.get_by_id(user_id)
            pipeline = normalize_manual_submit_pipeline(
                getattr(user, "manual_submit_pipeline", None) if user else None
            )
    extract_user_id, chain_analysis, skip_phase_b = manual_submit_enqueue_flags(
        pipeline, is_admin=is_admin, user_id=user_id
    )
    analysis_user_id = extract_user_id  # None for admin / extract-only
    normalized_url = request.url
    domain = URLManager.extract_domain(request.url)

    async with get_session() as session:
        block_reason = _check_extraction_blocked(request.url)
        if block_reason:
            from app.services.job_exclusion_types import BLOCKED_DOMAIN_EXCLUSION, LINKEDIN_JOB_EXCLUSION
            from app.services.linkedin_job_filter import is_linkedin_job_url

            exclusion_type = (
                LINKEDIN_JOB_EXCLUSION
                if is_linkedin_job_url(request.url)
                else BLOCKED_DOMAIN_EXCLUSION
            )
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
                    exclusion_type=exclusion_type,
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
            already_in_pool = existing_ujs is not None
            if not already_in_pool:
                await ujs_repo.upsert(
                    user_id=user_id,
                    job_id=existing_job.id,
                    status="active",
                )

            extraction_id = existing_job.extraction_id
            extraction = None
            extraction_status = None
            if extraction_id:
                extraction_repo = JobExtractionRepository(session)
                extraction = await extraction_repo.get_by_id(extraction_id)
                extraction_status = extraction.status if extraction else None
            jd_ready = extraction_has_shared_jd(extraction)

            await session.commit()

            logger.info(
                "jobs_submit_existing_job_linked",
                job_id=existing_job.id,
                url=request.url,
                already_in_pool=already_in_pool,
                is_admin=is_admin,
                extraction_status=str(extraction_status) if extraction_status else None,
            )
            await _publish_job_submitted(user_id, existing_job.id, request.url)

            # Applicants: start personal analysis on shared JD, or finish extraction first.
            # Depth follows manual_submit_pipeline (extract | match | full).
            if analysis_user_id:
                if jd_ready:
                    await start_personal_job_analysis(
                        existing_job.id,
                        analysis_user_id,
                        background_tasks=background_tasks,
                        force=False,
                        skip_phase_b=skip_phase_b,
                    )
                elif extraction_id:
                    await enqueue_extraction(
                        extraction_id,
                        request.url,
                        user_id=analysis_user_id,
                        background_tasks=background_tasks,
                        skip_phase_b=skip_phase_b,
                        chain_analysis=True,
                    )
            elif not is_admin and extraction_id and not jd_ready:
                # Extract-only: scrape shared JD without chaining personal analysis.
                await enqueue_extraction(
                    extraction_id,
                    request.url,
                    user_id=None,
                    background_tasks=background_tasks,
                    chain_analysis=False,
                )

            return JobSubmissionResponse(
                success=True,
                job_id=existing_job.id,
                is_duplicate=already_in_pool,
                duplicate_job_id=existing_job.id if already_in_pool else None,
                message=(
                    "Already in your pool"
                    if already_in_pool
                    else "Job submitted successfully"
                ),
            )

        if existing_job and not user_id:
            return JobSubmissionResponse(
                success=True,
                job_id=existing_job.id,
                is_duplicate=True,
                duplicate_job_id=existing_job.id,
                message="Already in your pool",
            )

        # New URL - create Job + extraction + UserJobStatus
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
                },
                # Admin inventory URL adds are FA (from admin), not FM (from me).
                "submitted_by_admin": bool(is_admin),
                "submitted_by_user_id": user_id,
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

        if not extraction_has_shared_jd(extraction):
            # Admin / extract-only: shared scrape. Match/full: extract then analyze.
            await enqueue_extraction(
                extraction.id,
                request.url,
                user_id=extract_user_id,
                background_tasks=background_tasks,
                skip_phase_b=skip_phase_b,
                chain_analysis=chain_analysis,
            )
        elif analysis_user_id:
            await start_personal_job_analysis(
                new_job.id,
                analysis_user_id,
                background_tasks=background_tasks,
                force=False,
                skip_phase_b=skip_phase_b,
            )

        logger.info(
            "jobs_submit_created",
            job_id=new_job.id,
            url=request.url,
            extraction_id=extraction.id,
            is_admin=is_admin,
            pipeline=pipeline,
            extract_user_id=extract_user_id,
            chain_analysis=chain_analysis,
            skip_phase_b=skip_phase_b,
        )
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


DASHBOARD_VIEWS = {
    "all",
    "today",
    "mine",
    "suggested",
    "applied_today",
    "applied",
    "available",
    "ready",
    "sheet_posted",
    "pumble_posted",
    "needs_extraction",
    "extracted",
    "extraction_failed",
    "manual",
}

VIEWS_NEEDING_APPLICATION_JOIN = frozenset({"applied_today", "applied", "available", "ready"})
VIEWS_NEEDING_RESUME_JOIN = frozenset({"ready", "available"})
# Extraction is always joined on the dashboard list query; this set documents
# views whose WHERE clauses depend on JobExtraction columns (also required on count).
VIEWS_NEEDING_EXTRACTION_CLAUSE = frozenset(
    {"needs_extraction", "extracted", "extraction_failed", "available"}
)


def _dashboard_view_clauses(
    view: str,
    *,
    min_score: int = 0,
    day_start: datetime | None = None,
    day_end: datetime | None = None,
    is_admin: bool = False,
) -> tuple[list, bool]:
    """Extra WHERE clauses for a dashboard view tab.

    Returns ``(clauses, needs_match_join)`` where *needs_match_join* signals that
    the ``JobMatchResult`` outer-join must be present for the clauses to resolve.
    """
    clauses: list = []
    needs_match_join = False

    if view == "today":
        if day_start is not None and day_end is not None:
            if is_admin:
                # Admin ops board uses platform Job.created_at (today_fetched).
                clauses.append(Job.created_at >= day_start)
                clauses.append(Job.created_at < day_end)
            else:
                # Applicant: when the job entered (or re-entered) this user's pool,
                # falling back to the job row's own creation date.
                added_at = func.coalesce(UserJobStatus.created_at, Job.created_at)
                clauses.append(added_at >= day_start)
                clauses.append(added_at < day_end)
    elif view == "mine":
        # Applicant "Jobs from me": URL/attachment they (or any applicant) submitted —
        # never admin inventory FA adds.
        clauses.append(UserJobStatus.status == "active")
        clauses.append(Job.raw_metadata["submitted_data"].isnot(None))
        clauses.append(
            or_(
                Job.raw_metadata["submitted_by_admin"].as_string().is_(None),
                Job.raw_metadata["submitted_by_admin"].as_string() != "true",
            )
        )
    elif view == "manual":
        # Admin ops: any job that entered via URL/attachment (system-wide),
        # including admin FA adds and applicant FM adds.
        clauses.append(Job.raw_metadata["submitted_data"].isnot(None))
    elif view == "suggested":
        needs_match_join = True
        clauses.append(JobMatchResult.overall_score.isnot(None))
        clauses.append(JobMatchResult.overall_score >= min_score)
    elif view == "applied_today":
        if day_start is not None and day_end is not None:
            if is_admin:
                # Any applicant marked applied today (ops signal; avoid join fan-out).
                clauses.append(
                    Job.id.in_(
                        select(ValidJobUserApplication.job_id).where(
                            ValidJobUserApplication.applied_at.isnot(None),
                            ValidJobUserApplication.applied_at >= day_start,
                            ValidJobUserApplication.applied_at < day_end,
                        )
                    )
                )
            else:
                clauses.append(ValidJobUserApplication.applied_at.isnot(None))
                clauses.append(ValidJobUserApplication.applied_at >= day_start)
                clauses.append(ValidJobUserApplication.applied_at < day_end)
    elif view == "applied":
        clauses.append(ValidJobUserApplication.id.is_not(None))
    elif view == "available":
        from app.models.schemas import ExtractionStatus

        # Upcoming jobs: shared JD scraped, not yet resume-ready, not applied —
        # the pool where applicants run match / tailor / resume pipelines.
        clauses.append(
            JobExtraction.status.in_(
                (ExtractionStatus.EXTRACTED, ExtractionStatus.COMPLETED)
            )
        )
        clauses.append(
            or_(
                ResumeBuildResult.id.is_(None),
                ResumeBuildResult.resume_docx_status.is_(None),
                ResumeBuildResult.resume_docx_status != "completed",
            )
        )
        clauses.append(ValidJobUserApplication.id.is_(None))
    elif view == "ready":
        # Tailored resume ready AND not yet applied — "Ready to apply".
        clauses.append(ResumeBuildResult.resume_docx_status == "completed")
        clauses.append(ValidJobUserApplication.id.is_(None))
    elif view == "sheet_posted":
        clauses.append(Job.sheet_posted_at.is_not(None))
    elif view == "pumble_posted":
        clauses.append(Job.pumble_posted_at.is_not(None))
    elif view == "needs_extraction":
        from app.models.schemas import ExtractionStatus

        clauses.append(
            or_(
                Job.extraction_id.is_(None),
                JobExtraction.status.is_(None),
                JobExtraction.status.in_(
                    (
                        ExtractionStatus.PENDING,
                        ExtractionStatus.PROCESSING,
                    )
                ),
            )
        )
    elif view == "extracted":
        from app.models.schemas import ExtractionStatus

        # Shared JD ready (scrape done) and/or Phase A structured.
        clauses.append(
            JobExtraction.status.in_(
                (ExtractionStatus.EXTRACTED, ExtractionStatus.COMPLETED)
            )
        )
    elif view == "extraction_failed":
        from app.models.schemas import ExtractionStatus

        clauses.append(JobExtraction.status == ExtractionStatus.FAILED)

    return clauses, needs_match_join


def _dashboard_search_clauses(
    *,
    q: str | None = None,
    title: str | None = None,
    company: str | None = None,
    source: str | None = None,
    remote_only: bool = False,
) -> list:
    """Shared text/source/remote filters for the dashboard list + counts.

    ``title`` and ``company`` are independent column filters (combined with AND),
    while ``q`` is the legacy combined title-or-company search. When ``q`` looks
    like an http(s) URL, also match ``source_url`` / ``normalized_url``.
    """
    clauses: list = []
    if q and q.strip():
        raw_q = q.strip()
        pattern = f"%{raw_q}%"
        text_match = (Job.title.ilike(pattern)) | (Job.company.ilike(pattern))
        if raw_q.lower().startswith("http://") or raw_q.lower().startswith("https://"):
            clauses.append(
                text_match
                | Job.source_url.ilike(pattern)
                | Job.normalized_url.ilike(pattern)
            )
        else:
            clauses.append(text_match)
    if title and title.strip():
        clauses.append(Job.title.ilike(f"%{title.strip()}%"))
    if company and company.strip():
        clauses.append(Job.company.ilike(f"%{company.strip()}%"))
    if source:
        src = source.strip()
        clauses.append(
            or_(
                Job.raw_metadata["source"].as_string().ilike(src),
                Job.raw_metadata["scraped_source"].as_string().ilike(src),
            )
        )
    if remote_only:
        # Keep in sync with dashboard_stats._is_remote_expr (work_mode, metadata, location).
        clauses.append(
            or_(
                Job.work_mode == "remote",
                Job.raw_metadata["is_remote"].as_boolean() == True,  # noqa: E712
                Job.location.ilike("%remote%"),
            )
        )
    return clauses


def _is_admin_manual_submission(meta: dict) -> bool:
    """True when a manual URL/attachment add was done by an admin (FA)."""
    flag = meta.get("submitted_by_admin")
    if flag is True:
        return True
    if isinstance(flag, str) and flag.strip().lower() in {"true", "1", "yes"}:
        return True
    if meta.get("submitted_by") == "admin":
        return True
    return False


def resolve_dashboard_added_from(meta: dict | None) -> str:
    """Origin for the Jobs table "Added from" column.

    Prefer the concrete scraper slug stored at promote time (``scraped_source``),
    so the UI can show RemoteRocketship / Jobright / etc. instead of a generic
    "Job sites" bucket.

    Manual URL/attachment submissions:
      - applicant → ``manual`` (FM / from me)
      - admin → ``admin_manual`` (FA / from admin)
    """
    data = meta if isinstance(meta, dict) else {}
    if data.get("submitted_data"):
        if _is_admin_manual_submission(data):
            return "admin_manual"
        return "manual"
    scraped = data.get("scraped_source")
    if isinstance(scraped, str):
        slug = scraped.strip().lower()
        if slug and slug not in {"manual", "admin_manual", "scraper", "unknown", "job_sites"}:
            return slug
    return "job_sites"


def _dashboard_min_score_clauses(min_match_score: int | None) -> tuple[list, bool]:
    """WHERE clauses for the optional minimum match-score filter.

    Returns ``(clauses, needs_match_join)``; the ``JobMatchResult`` outer-join must
    be present whenever clauses are returned. A threshold of 0/None disables it.
    """
    if min_match_score and min_match_score > 0:
        return (
            [
                JobMatchResult.overall_score.isnot(None),
                JobMatchResult.overall_score >= min_match_score,
            ],
            True,
        )
    return [], False


def _dashboard_visible_base_filter(user_id: str, min_match_score: int | None = None) -> tuple[list, bool]:
    """Shared visibility filter for dashboard list / revision / sync (view=all)."""
    base_filter = [
        Job.status != "blocked",
        (UserJobStatus.status.is_(None)) | (UserJobStatus.status == "active"),
    ]
    score_clauses, needs_match_join = _dashboard_min_score_clauses(min_match_score)
    base_filter.extend(score_clauses)
    return base_filter, needs_match_join


def _dashboard_select_columns():
    """Columns shared by dashboard list + incremental sync upserts."""
    return (
        Job,
        JobExtraction.status.label("ext_status"),
        JobExtraction.is_job_posting,
        JobExtraction.salary_range,
        JobExtraction.work_mode,
        JobExtraction.remote_policy,
        JobMatchResult.overall_score,
        JobMatchInProgress.id.label("match_progress_id"),
        ResumeBuildResult.id.label("rb_id"),
        ResumeBuildResult.resume_docx_status,
        ResumeBuildResult.content_generation_status,
        ResumeBuildResult.resume_pdf_status,
        ResumeBuildResult.resume_pdf_path,
        ResumeBuildResult.cover_letter_pdf_status,
        ResumeBuildResult.cover_letter_pdf_path,
        ValidJobUserApplication.applied_at,
        ValidJobUserApplication.applied_by_name,
        UserJobStatus.status.label("ujs_status"),
        UserJobStatus.created_at.label("ujs_created_at"),
    )


def _dashboard_apply_joins(stmt, user_id: str, *, team_applications: bool = False):
    """Outer-joins needed to hydrate a DashboardJobResponse row."""
    app_on = ValidJobUserApplication.job_id == Job.id
    if not team_applications:
        app_on = app_on & (ValidJobUserApplication.user_id == user_id)
    return (
        stmt.select_from(Job)
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
        .outerjoin(ValidJobUserApplication, app_on)
    )


def _row_to_dashboard_job(row) -> DashboardJobResponse:
    (
        job,
        ext_status,
        is_job_posting,
        ext_salary_range,
        ext_work_mode,
        ext_remote_policy,
        match_score,
        match_progress_id,
        rb_id,
        rb_docx_status,
        cg_status,
        rb_pdf_status,
        rb_pdf_path,
        cl_pdf_status,
        cl_pdf_path,
        applied_at,
        applied_by_name,
        ujs_status,
        ujs_created_at,
    ) = row
    meta = job.raw_metadata or {}
    work_mode = resolve_display_work_mode(
        analysis_work_mode=ext_work_mode or job.work_mode,
        location=job.location,
        remote_policy=ext_remote_policy,
        title=job.title,
        is_remote=bool(meta.get("is_remote", False)),
    )
    pool_added_at = ujs_created_at or job.created_at
    return DashboardJobResponse(
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
        resume_build_id=rb_id,
        resume_pdf_status=rb_pdf_status,
        resume_pdf_path=rb_pdf_path,
        cover_letter_pdf_status=cl_pdf_status,
        cover_letter_pdf_path=cl_pdf_path,
        applied_at=applied_at,
        applied_by_name=applied_by_name,
        sheet_posted_at=job.sheet_posted_at,
        pumble_posted_at=job.pumble_posted_at,
        user_status=ujs_status,
        source=meta.get("source"),
        is_remote=work_mode == "remote" or bool(meta.get("is_remote", False)),
        work_mode=work_mode,
        salary_raw=ext_salary_range or meta.get("salary_raw"),
        job_type=meta.get("job_type"),
        from_me=bool(meta.get("submitted_data")) and not _is_admin_manual_submission(meta),
        added_from=resolve_dashboard_added_from(meta),
        pool_added_at=pool_added_at,
    )


async def _dashboard_revision_for_user(
    session,
    user_id: str,
    *,
    min_match_score: int | None = None,
) -> tuple[str, int, datetime]:
    """Return (revision, total, server_time) for the user's visible job catalog."""
    base_filter, needs_match_join = _dashboard_visible_base_filter(user_id, min_match_score)
    # Fingerprint from visible row count + newest related activity timestamps.
    activity = func.greatest(
        Job.updated_at,
        func.coalesce(UserJobStatus.updated_at, Job.updated_at),
        func.coalesce(ResumeBuildResult.updated_at, Job.updated_at),
        func.coalesce(ValidJobUserApplication.applied_at, Job.updated_at),
        func.coalesce(JobMatchResult.created_at, Job.updated_at),
        func.coalesce(JobMatchInProgress.created_at, Job.updated_at),
    )
    stmt = (
        select(func.count(), func.max(activity))
        .select_from(Job)
        .outerjoin(
            UserJobStatus,
            (UserJobStatus.job_id == Job.id) & (UserJobStatus.user_id == user_id),
        )
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
            (ValidJobUserApplication.job_id == Job.id)
            & (ValidJobUserApplication.user_id == user_id),
        )
        .where(*base_filter)
    )
    # needs_match_join is already satisfied by the always-present match join above.
    del needs_match_join
    total, max_activity = (await session.execute(stmt)).one()
    total = int(total or 0)
    server_time = _utcnow()
    stamp = max_activity.isoformat() if max_activity is not None else "none"
    revision = f"{total}:{stamp}"
    return revision, total, server_time


DASHBOARD_SYNC_UPSERT_CAP = 500


@router.get("/jobs/dashboard", response_model=DashboardJobsPage, dependencies=[Depends(get_current_user)])
async def get_dashboard_jobs(
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    sort: str = Query("created_at"),
    order: str = Query("desc"),
    q: str | None = Query(None),
    title: str | None = Query(None),
    company: str | None = Query(None),
    source: str | None = Query(None),
    remote_only: bool = Query(False),
    min_match_score: int | None = Query(None, ge=0, le=100),
    view: str = Query("all"),
    timezone: str | None = Query(None),
    current_user: dict = Depends(get_current_user),
) -> DashboardJobsPage:
    """Paginated jobs list. ``view`` narrows results (all/today/mine/suggested/
    applied/available/ready/sheet_posted/pumble_posted/applied_today/
    needs_extraction/extracted/extraction_failed/manual).
    """
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    is_admin = bool(current_user.get("is_admin"))
    if view not in DASHBOARD_VIEWS:
        view = "all"

    day_start = day_end = None
    if view in ("today", "applied_today"):
        day_start, day_end = day_bounds_for_timezone(timezone)

    # Admin applied_today: filter via EXISTS in view clauses (no join fan-out).
    team_applied_view = False

    SORT_COLUMNS = {
        "created_at": Job.created_at,
        "title": Job.title,
        "company": Job.company,
        "posted_date": Job.posted_date,
        "updated_at": Job.updated_at,
        "match_score": JobMatchResult.overall_score,
        "applied_at": ValidJobUserApplication.applied_at,
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
        min_score = 0
        if view == "suggested":
            min_score = await UserRepository(session).get_effective_min_match_score(user_id)

        # Admins see the full non-blocked pool (matches admin stats). Applicants
        # still hide jobs they marked duplicated / manual_hidden via UJS.
        base_filter = [Job.status != "blocked"]
        if not is_admin:
            base_filter.append(
                (UserJobStatus.status.is_(None)) | (UserJobStatus.status == "active")
            )
        base_filter.extend(
            _dashboard_search_clauses(
                q=q, title=title, company=company, source=source, remote_only=remote_only,
            )
        )

        view_clauses, needs_match_join = _dashboard_view_clauses(
            view,
            min_score=min_score,
            day_start=day_start,
            day_end=day_end,
            is_admin=is_admin,
        )
        base_filter.extend(view_clauses)

        # Admin main table: extraction failures live on the dedicated
        # Extraction failed board — never mix them into All / other ops views.
        needs_extraction_join = view in VIEWS_NEEDING_EXTRACTION_CLAUSE
        if is_admin and view != "extraction_failed":
            base_filter.append(Job.status != "extraction_failed")
            base_filter.append(
                (JobExtraction.status.is_(None))
                | (JobExtraction.status != ExtractionStatus.FAILED)
            )
            needs_extraction_join = True

        score_clauses, score_needs_join = _dashboard_min_score_clauses(min_match_score)
        base_filter.extend(score_clauses)
        needs_match_join = needs_match_join or score_needs_join

        count_stmt = (
            select(func.count())
            .select_from(Job)
            .outerjoin(
                UserJobStatus,
                (UserJobStatus.job_id == Job.id) & (UserJobStatus.user_id == user_id),
            )
        )
        if needs_match_join:
            count_stmt = count_stmt.outerjoin(
                JobMatchResult,
                (JobMatchResult.job_id == Job.id) & (JobMatchResult.user_id == user_id),
            )
        if view in VIEWS_NEEDING_APPLICATION_JOIN:
            if team_applied_view:
                count_stmt = count_stmt.outerjoin(
                    ValidJobUserApplication,
                    ValidJobUserApplication.job_id == Job.id,
                )
            else:
                count_stmt = count_stmt.outerjoin(
                    ValidJobUserApplication,
                    (ValidJobUserApplication.job_id == Job.id)
                    & (ValidJobUserApplication.user_id == user_id),
                )
        if view in VIEWS_NEEDING_RESUME_JOIN:
            count_stmt = count_stmt.outerjoin(
                ResumeBuildResult,
                (ResumeBuildResult.job_id == Job.id) & (ResumeBuildResult.user_id == user_id),
            )
        if needs_extraction_join:
            count_stmt = count_stmt.outerjoin(
                JobExtraction, Job.extraction_id == JobExtraction.id
            )
        count_stmt = count_stmt.where(*base_filter)
        total = (await session.execute(count_stmt)).scalar() or 0

        pages = max(1, -(-total // per_page))
        offset = (page - 1) * per_page

        stmt = _dashboard_apply_joins(
            select(*_dashboard_select_columns()),
            user_id,
            team_applications=team_applied_view,
        ).where(*base_filter).order_by(*order_clauses).limit(per_page).offset(offset)
        result = await session.execute(stmt)
        rows = result.all()

        items = [_row_to_dashboard_job(row) for row in rows]

        return DashboardJobsPage(
            items=items,
            total=total,
            page=page,
            per_page=per_page,
            pages=pages,
        )


@router.get(
    "/jobs/dashboard/revision",
    response_model=DashboardRevisionResponse,
    dependencies=[Depends(get_current_user)],
)
async def get_dashboard_revision(
    min_match_score: int | None = Query(None, ge=0, le=100),
    current_user: dict = Depends(get_current_user),
) -> DashboardRevisionResponse:
    """Cheap fingerprint so the extension can skip a full catalog sync."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    async with get_session() as session:
        revision, total, server_time = await _dashboard_revision_for_user(
            session, user_id, min_match_score=min_match_score
        )
        return DashboardRevisionResponse(
            revision=revision,
            total=total,
            server_time=server_time,
        )


@router.get(
    "/jobs/dashboard/sync",
    response_model=DashboardSyncResponse,
    dependencies=[Depends(get_current_user)],
)
async def get_dashboard_sync(
    since: str | None = Query(
        None,
        description="ISO watermark from the previous sync. Omit for a cold bootstrap reset.",
    ),
    min_match_score: int | None = Query(None, ge=0, le=100),
    timezone_name: str | None = Query(None, alias="timezone"),
    known_ids: str | None = Query(
        None,
        description="Comma-separated job ids the client currently caches (optional; used for removals).",
    ),
    current_user: dict = Depends(get_current_user),
) -> DashboardSyncResponse:
    """Incremental job-catalog sync for the browser extension.

    Without ``since``, returns ``reset=true`` so the client rebuilds via paginated
    ``/jobs/dashboard?view=all``. With ``since``, returns upserts for rows that
    changed after the watermark plus ``removed_ids`` for jobs that left the
    visible set. If too many rows changed, returns ``reset=true``.
    """
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    since_dt: datetime | None = None
    if since and since.strip():
        raw = since.strip().replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(raw)
            if parsed.tzinfo is not None:
                parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
            since_dt = parsed
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid since timestamp; use ISO-8601.",
            )

    day_start, day_end = day_bounds_for_timezone(timezone_name)

    async with get_session() as session:
        revision, total, server_time = await _dashboard_revision_for_user(
            session, user_id, min_match_score=min_match_score
        )

        min_score_pref = await UserRepository(session).get_effective_min_match_score(user_id)
        shared_filter = [
            Job.status != "blocked",
            (UserJobStatus.status.is_(None)) | (UserJobStatus.status == "active"),
        ]

        async def _count(view: str) -> int:
            view_clauses, needs_match_join = _dashboard_view_clauses(
                view, min_score=min_score_pref, day_start=day_start, day_end=day_end,
            )
            stmt_c = (
                select(func.count())
                .select_from(Job)
                .outerjoin(
                    UserJobStatus,
                    (UserJobStatus.job_id == Job.id) & (UserJobStatus.user_id == user_id),
                )
            )
            if needs_match_join:
                stmt_c = stmt_c.outerjoin(
                    JobMatchResult,
                    (JobMatchResult.job_id == Job.id) & (JobMatchResult.user_id == user_id),
                )
            if view in VIEWS_NEEDING_APPLICATION_JOIN:
                stmt_c = stmt_c.outerjoin(
                    ValidJobUserApplication,
                    (ValidJobUserApplication.job_id == Job.id)
                    & (ValidJobUserApplication.user_id == user_id),
                )
            if view in VIEWS_NEEDING_RESUME_JOIN:
                stmt_c = stmt_c.outerjoin(
                    ResumeBuildResult,
                    (ResumeBuildResult.job_id == Job.id) & (ResumeBuildResult.user_id == user_id),
                )
            stmt_c = stmt_c.where(*shared_filter, *view_clauses)
            return (await session.execute(stmt_c)).scalar() or 0

        counts = {
            "all": await _count("all"),
            "today": await _count("today"),
            "mine": await _count("mine"),
            "available": await _count("available"),
            "suggested": 0,
            "applied_today": await _count("applied_today"),
        }

        if since_dt is None:
            return DashboardSyncResponse(
                server_time=server_time,
                revision=revision,
                upserts=[],
                removed_ids=[],
                reset=True,
                counts=counts,
            )

        base_filter, _needs = _dashboard_visible_base_filter(user_id, min_match_score)
        changed_clause = or_(
            Job.updated_at >= since_dt,
            UserJobStatus.updated_at >= since_dt,
            ResumeBuildResult.updated_at >= since_dt,
            ValidJobUserApplication.applied_at >= since_dt,
            JobMatchResult.created_at >= since_dt,
            JobMatchInProgress.created_at >= since_dt,
        )

        count_changed = (
            select(func.count())
            .select_from(Job)
            .outerjoin(
                UserJobStatus,
                (UserJobStatus.job_id == Job.id) & (UserJobStatus.user_id == user_id),
            )
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
                (ValidJobUserApplication.job_id == Job.id)
                & (ValidJobUserApplication.user_id == user_id),
            )
            .where(*base_filter, changed_clause)
        )
        changed_total = (await session.execute(count_changed)).scalar() or 0
        if changed_total > DASHBOARD_SYNC_UPSERT_CAP:
            return DashboardSyncResponse(
                server_time=server_time,
                revision=revision,
                upserts=[],
                removed_ids=[],
                reset=True,
                counts=counts,
            )

        upsert_stmt = (
            _dashboard_apply_joins(select(*_dashboard_select_columns()), user_id)
            .where(*base_filter, changed_clause)
            .order_by(Job.updated_at.desc(), Job.id.desc())
            .limit(DASHBOARD_SYNC_UPSERT_CAP)
        )
        upsert_rows = (await session.execute(upsert_stmt)).all()
        upserts = [_row_to_dashboard_job(row) for row in upsert_rows]

        removed_ids: list[str] = []
        left_stmt = (
            select(Job.id)
            .select_from(Job)
            .outerjoin(
                UserJobStatus,
                (UserJobStatus.job_id == Job.id) & (UserJobStatus.user_id == user_id),
            )
            .where(
                or_(
                    and_(Job.status == "blocked", Job.updated_at >= since_dt),
                    and_(
                        UserJobStatus.status.isnot(None),
                        UserJobStatus.status != "active",
                        UserJobStatus.updated_at >= since_dt,
                    ),
                )
            )
            .limit(2000)
        )
        removed_ids.extend([r[0] for r in (await session.execute(left_stmt)).all()])

        if known_ids:
            client_ids = [x.strip() for x in known_ids.split(",") if x.strip()]
            client_ids = client_ids[:5000]
            if client_ids:
                visible_stmt = (
                    select(Job.id)
                    .select_from(Job)
                    .outerjoin(
                        UserJobStatus,
                        (UserJobStatus.job_id == Job.id) & (UserJobStatus.user_id == user_id),
                    )
                    .outerjoin(
                        JobMatchResult,
                        (JobMatchResult.job_id == Job.id) & (JobMatchResult.user_id == user_id),
                    )
                    .where(Job.id.in_(client_ids), *base_filter)
                )
                still_visible = {r[0] for r in (await session.execute(visible_stmt)).all()}
                for jid in client_ids:
                    if jid not in still_visible:
                        removed_ids.append(jid)

        seen: set[str] = set()
        deduped_removed: list[str] = []
        for jid in removed_ids:
            if jid not in seen:
                seen.add(jid)
                deduped_removed.append(jid)

        return DashboardSyncResponse(
            server_time=server_time,
            revision=revision,
            upserts=upserts,
            removed_ids=deduped_removed,
            reset=False,
            counts=counts,
        )



class DashboardCountsResponse(BaseModel):
    """Per-tab job counts powering the dashboard view switcher badges."""
    all: int
    today: int
    mine: int
    available: int = 0  # Upcoming jobs (JD ready, pipeline incomplete)
    suggested: int = 0  # Deprecated alias; kept for older clients
    applied_today: int = 0


@router.get(
    "/jobs/dashboard/counts",
    response_model=DashboardCountsResponse,
    dependencies=[Depends(get_current_user)],
)
async def get_dashboard_counts(
    q: str | None = Query(None),
    title: str | None = Query(None),
    company: str | None = Query(None),
    source: str | None = Query(None),
    remote_only: bool = Query(False),
    min_match_score: int | None = Query(
        None,
        ge=0,
        le=100,
        description=(
            "Ignored for tab badges. Match-score filtering is list-only so "
            "'All jobs in system' stays aligned with the Total jobs tile."
        ),
    ),
    timezone: str | None = Query(None),
    current_user: dict = Depends(get_current_user),
) -> DashboardCountsResponse:
    """Counts for every dashboard view tab, honoring the active search filters.

    Tab badges intentionally ignore ``min_match_score``. That toolbar filter only
    narrows the paginated list. Applying it here made ``counts.all`` collapse to
    the Best-jobs subset (e.g. 837) while the Total jobs tile still showed the
    full visible pool (e.g. 1133).
    """
    del min_match_score  # accepted for backward-compatible clients; not used
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    is_admin = bool(current_user.get("is_admin"))
    day_start, day_end = day_bounds_for_timezone(timezone)

    async with get_session() as session:
        # Preference threshold retained for legacy ``suggested`` view clauses only.
        min_score = await UserRepository(session).get_effective_min_match_score(user_id)

        shared_filter = [Job.status != "blocked"]
        if not is_admin:
            shared_filter.append(
                (UserJobStatus.status.is_(None)) | (UserJobStatus.status == "active")
            )
        shared_filter.extend(
            _dashboard_search_clauses(
                q=q, title=title, company=company, source=source, remote_only=remote_only,
            )
        )

        async def _count(view: str) -> int:
            view_clauses, needs_match_join = _dashboard_view_clauses(
                view,
                min_score=min_score,
                day_start=day_start,
                day_end=day_end,
                is_admin=is_admin,
            )
            filters = list(shared_filter)
            needs_extraction_join = False
            if is_admin and view != "extraction_failed":
                filters.append(Job.status != "extraction_failed")
                filters.append(
                    (JobExtraction.status.is_(None))
                    | (JobExtraction.status != ExtractionStatus.FAILED)
                )
                needs_extraction_join = True
            stmt = (
                select(func.count())
                .select_from(Job)
                .outerjoin(
                    UserJobStatus,
                    (UserJobStatus.job_id == Job.id) & (UserJobStatus.user_id == user_id),
                )
            )
            if needs_match_join:
                stmt = stmt.outerjoin(
                    JobMatchResult,
                    (JobMatchResult.job_id == Job.id) & (JobMatchResult.user_id == user_id),
                )
            if view in VIEWS_NEEDING_APPLICATION_JOIN:
                stmt = stmt.outerjoin(
                    ValidJobUserApplication,
                    (ValidJobUserApplication.job_id == Job.id)
                    & (ValidJobUserApplication.user_id == user_id),
                )
            if view in VIEWS_NEEDING_RESUME_JOIN:
                stmt = stmt.outerjoin(
                    ResumeBuildResult,
                    (ResumeBuildResult.job_id == Job.id) & (ResumeBuildResult.user_id == user_id),
                )
            if needs_extraction_join or view in VIEWS_NEEDING_EXTRACTION_CLAUSE:
                stmt = stmt.outerjoin(
                    JobExtraction, Job.extraction_id == JobExtraction.id
                )
            stmt = stmt.where(*filters, *view_clauses)
            return (await session.execute(stmt)).scalar() or 0

        return DashboardCountsResponse(
            all=await _count("all"),
            today=await _count("today"),
            mine=await _count("mine"),
            available=await _count("available"),
            suggested=0,
            applied_today=await _count("applied_today"),
        )


class WeeklyProgressDay(BaseModel):
    date: str
    label: str
    posted: int
    recommended: int
    applied: int


class WeeklyProgressTotals(BaseModel):
    posted: int
    recommended: int
    applied: int


class WeeklyProgressResponse(BaseModel):
    timezone: str
    days: int
    min_match_score: int
    series: list[WeeklyProgressDay]
    totals: WeeklyProgressTotals


@router.get(
    "/jobs/dashboard/weekly-progress",
    response_model=WeeklyProgressResponse,
    dependencies=[Depends(get_current_user)],
)
async def get_weekly_progress(
    timezone: str | None = Query(None),
    days: int = Query(7, ge=1, le=31),
    current_user: dict = Depends(get_current_user),
) -> WeeklyProgressResponse:
    """Last-N-days chart: posted / recommended (Preferences min score) / applied.

    Supports day (1), week (7), and month (~30) windows for the extension stats page.
    """
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    from app.services.weekly_progress import fetch_weekly_progress_series

    try:
        async with get_session() as session:
            payload = await fetch_weekly_progress_series(
                session, user_id, tz_name=timezone, days=days
            )
        return WeeklyProgressResponse(**payload)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/jobs/valid", response_model=list[JobResponse], dependencies=[Depends(get_current_user)])
async def get_valid_jobs(
    limit: int = 50,
    offset: int = 0,
    current_user: dict = Depends(get_current_user),
) -> list[JobResponse]:
    """Get active jobs for the current user - only jobs with UserJobStatus(status='active')."""
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
                scraped_at=job.scraped_at,
                extraction_id=job.extraction_id,
                extraction_status=ext_status.value if ext_status else None,
                is_job_posting=is_job_posting,
                match_overall_score=match_score,
                match_status="processing" if (match_progress_id and match_score is None) else None,
                applied_at=applied_at,
                applied_by_name=applied_by_name,
                sheet_posted_at=job.sheet_posted_at,
                pumble_posted_at=job.pumble_posted_at,
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
    except _openai_api_error() as e:
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
    from sqlalchemy.orm import undefer

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
            .options(undefer(Job.description))
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
            scraped_at=job.scraped_at,
            extraction_id=job.extraction_id,
            extraction_status=ext_status.value if ext_status else None,
            is_job_posting=is_job_posting,
            applied_at=applied_at,
            applied_by_name=applied_by_name,
            sheet_posted_at=job.sheet_posted_at,
            pumble_posted_at=job.pumble_posted_at,
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
        # Include extraction_failed so admins can open the JD modal and paste text.
        r = await session.execute(
            select(Job).where(
                Job.id == job_id,
                Job.status.in_(("active", "extraction_failed")),
            )
        )
        job = r.scalar_one_or_none()
        if not job:
            raise HTTPException(status_code=404, detail="Valid job not found")

        extraction = None
        extraction_status = None
        extraction_method = None
        is_job_posting = None
        job_data = None
        raw_plain_text = None
        content_enriched_by_ai = False

        if job.extraction_id:
            ext_repo = JobExtractionRepository(session)
            extraction = await ext_repo.get_by_id(job.extraction_id)
            if extraction:
                extraction_status = extraction.status
                extraction_method = extraction.extraction_method
                is_job_posting = extraction.is_job_posting
                content_enriched_by_ai = _ai_enriched_extraction(extraction)
                raw_plain_text = (getattr(extraction, "raw_plain_text", None) or "").strip() or None
                structured_desc = (extraction.description or "").strip() or None
                # Admin extract-only saves raw_plain_text; structured description may be empty.
                body_text = structured_desc or raw_plain_text or ""
                display_title = resolve_job_display_title(
                    job_title=extraction.title,
                    submitted_title=job.title,
                    description=body_text or None,
                )
                ready_statuses = {
                    ExtractionStatus.COMPLETED,
                    ExtractionStatus.EXTRACTED,
                }
                if extraction.status in ready_statuses and (display_title or body_text):
                    title = display_title or (job.title or "").strip() or "Job posting"
                    # JobDescriptionSchema requires description min_length=10.
                    description = body_text if len(body_text) >= 10 else (
                        raw_plain_text if raw_plain_text and len(raw_plain_text) >= 10 else None
                    )
                    if description:
                        job_data = JobDescriptionSchema(
                            title=title,
                            company=extraction.company or job.company,
                            location=extraction.location or job.location,
                            employment_type=extraction.employment_type,
                            salary_range=extraction.salary_range,
                            description=description,
                            responsibilities=extraction.responsibilities or [],
                            requirements=extraction.requirements or [],
                            benefits=extraction.benefits or [],
                            posted_date=job.posted_date,
                            remote_policy=extraction.remote_policy,
                            work_mode=extraction.work_mode,
                            experience_level=extraction.experience_level or job.experience_level,
                            industry=extraction.industry or job.industry,
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
            raw_plain_text=raw_plain_text,
            extraction_method=extraction_method,
            is_job_posting=is_job_posting,
            content_enriched_by_ai=content_enriched_by_ai,
            match=match_payload,
            match_in_progress=match_in_progress,
            promotion=promotion_payload,
            resume_build=resume_build_payload,
        )


class ManualJdRequest(BaseModel):
    plain_text: str = Field(..., min_length=10, max_length=500_000)


class ManualJdResponse(BaseModel):
    job_id: str
    extraction_id: str
    extraction_status: ExtractionStatus
    raw_plain_text: str


@router.put(
    "/jobs/valid/{job_id}/manual-jd",
    response_model=ManualJdResponse,
    dependencies=[Depends(require_admin)],
)
async def save_manual_job_description(
    job_id: str,
    body: ManualJdRequest,
    current_user: dict = Depends(require_admin),
) -> ManualJdResponse:
    """
    Admin: paste a job description when automatic extraction failed or returned no text.
    Saves as shared ``raw_plain_text`` and marks the extraction completed (same as a
    successful platform extract).
    """
    from app.services.extraction_cache import invalidate_extraction_cache
    from app.services.manual_jd import apply_manual_job_description

    user_id = current_user.get("user_id")

    async with get_session() as session:
        r = await session.execute(
            select(Job).where(
                Job.id == job_id,
                Job.status.in_(("active", "extraction_failed")),
            )
        )
        job = r.scalar_one_or_none()
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")

        try:
            extraction = await apply_manual_job_description(
                session,
                job=job,
                plain_text=body.plain_text,
                saved_by_user_id=user_id,
            )
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e

        await session.commit()
        extraction_id = extraction.id
        raw_text = (getattr(extraction, "raw_plain_text", None) or body.plain_text).strip()

    try:
        await invalidate_extraction_cache(extraction_id)
    except Exception as e:
        logger.warning("manual_jd_cache_invalidate_failed", extraction_id=extraction_id, error=str(e))

    await publish_ws_event({
        "type": "extraction_completed",
        "job_id": extraction_id,
        "valid_job_id": job_id,
        "method": "manual",
        "manual_jd": True,
    })

    return ManualJdResponse(
        job_id=job_id,
        extraction_id=extraction_id,
        extraction_status=ExtractionStatus.EXTRACTED,
        raw_plain_text=raw_text,
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
        from app.services.job_pipeline_mode import extraction_has_shared_jd

        if not extraction_has_shared_jd(extraction):
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

    block_reason = _check_extraction_blocked(source_url)
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

    async with get_session() as session:
        progress_repo = JobMatchInProgressRepository(session)
        match_repo = JobMatchRepository(session)
        extraction_repo = JobExtractionRepository(session)

        in_prog_rows = await session.execute(
            select(JobMatchInProgress.job_id).where(
                JobMatchInProgress.user_id == user_id,
                JobMatchInProgress.job_id.in_(unique_ids),
            )
        )
        already_in_progress = {row[0] for row in in_prog_rows.all()}

        job_rows = await session.execute(
            select(Job).where(Job.id.in_(unique_ids), Job.status == "active")
        )
        jobs_by_id = {j.id: j for j in job_rows.scalars().all()}

        extraction_ids = [
            j.extraction_id for j in jobs_by_id.values() if j.extraction_id
        ]
        extractions_by_id: dict[str, JobExtraction] = {}
        if extraction_ids:
            ext_rows = await session.execute(
                select(JobExtraction).where(JobExtraction.id.in_(extraction_ids))
            )
            extractions_by_id = {e.id: e for e in ext_rows.scalars().all()}

        for job_id in unique_ids:
            job = jobs_by_id.get(job_id)
            if not job or not job.extraction_id:
                skipped.append({"id": job_id, "reason": "no_extraction"})
                continue

            extraction = extractions_by_id.get(job.extraction_id)
            from app.services.job_pipeline_mode import extraction_has_shared_jd

            if not extraction_has_shared_jd(extraction):
                skipped.append({"id": job_id, "reason": "extraction_not_ready"})
                continue

            # Stuck/aborted in_progress must still be re-queued (unique arq ids below).
            was_in_progress = job_id in already_in_progress
            await match_repo.delete(job_id, user_id)
            await session.execute(
                text(
                    "DELETE FROM resume_build_results "
                    "WHERE job_id = :job_id AND user_id = :uid"
                ),
                {"job_id": job_id, "uid": user_id},
            )
            if not was_in_progress:
                await progress_repo.add(job_id, user_id)
            enqueued_ids.append(job_id)

        await session.commit()

    if not enqueued_ids:
        return {
            "status": "accepted",
            "enqueued": 0,
            "enqueued_ids": [],
            "skipped": skipped,
            "message": "Nothing queued; check skipped reasons.",
        }

    ids_for_in_process: list[str] = list(enqueued_ids)
    pool = await try_get_analysis_pool()
    if pool:
        from app.core.redis_support import pipeline_job_id
        import uuid

        redis_failed: list[str] = []
        for jid in enqueued_ids:
            try:
                await pool.enqueue_job(
                    "analyze_job_match",
                    jid,
                    user_id,
                    _job_id=pipeline_job_id(
                        "analyze", jid, user_id, uuid.uuid4().hex[:10]
                    ),
                )
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

    from app.core.redis_support import allow_in_process_job_fallback

    if allow_in_process_job_fallback() and background_tasks:
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
    dependencies=[Depends(require_admin)],
)
async def rescrape_valid_jobs_batch(
    body: JobIdsBatchRequest,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(require_admin),
):
    """
    Admin-only: force re-queue page extraction for many valid jobs (shared JD).

    Applicants must use ``POST /jobs/valid/prepare/batch`` (analyze without rescrape
    when JD is already saved).
    """
    from app.services.job_pipeline_mode import ingest_chain_user_id

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    chain_user_id = ingest_chain_user_id(
        is_admin=True,
        user_id=user_id,
    )

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
                extraction_id = await _prepare_job_rescrape_in_session(
                    session, job, source_url, chain_user_id
                )
            except ValueError as e:
                skipped.append({"id": job_id, "reason": str(e)[:200]})
                continue
            await session.commit()

        await enqueue_extraction(
            extraction_id,
            source_url,
            user_id=chain_user_id,
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


@router.post("/jobs/valid/{job_id}/prepare", dependencies=[Depends(get_current_user)])
async def prepare_valid_job(
    job_id: str,
    background_tasks: BackgroundTasks,
    force_rescrape: bool = Query(
        False,
        description="If true, reset shared extraction and re-scrape before analyzing.",
    ),
    current_user: dict = Depends(get_current_user),
):
    """Start personal analysis using saved JD when ready; otherwise extract then analyze.

    Admins: extract-only shared inventory (never personal analyze/tailor).
    Applicants: Jobs table Run/Rerun — analyze from saved JD when possible.
    """
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if current_user.get("is_admin"):
        return await prepare_shared_job_extraction(
            job_id,
            background_tasks=background_tasks,
            force_rescrape=force_rescrape,
        )

    # Applicants: never force re-extract via this endpoint when JD exists.
    return await prepare_job_for_user(
        job_id,
        user_id,
        background_tasks=background_tasks,
        force_rescrape=False,
        allow_force_rescrape=False,
    )


@router.post(
    "/jobs/valid/prepare/batch",
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(get_current_user)],
)
async def prepare_valid_jobs_batch(
    body: JobIdsBatchRequest,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
):
    """Smart prepare for many jobs.

    Admins: extract-only for jobs missing a shared JD.
    Applicants: analyze if JD ready, else extract then analyze.
    """
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    is_admin = bool(current_user.get("is_admin"))

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
        try:
            if is_admin:
                result = await prepare_shared_job_extraction(
                    job_id,
                    background_tasks=background_tasks,
                    force_rescrape=False,
                )
            else:
                result = await prepare_job_for_user(
                    job_id,
                    user_id,
                    background_tasks=background_tasks,
                    force_rescrape=False,
                )
            jobs_out.append(
                {
                    "job_id": job_id,
                    "mode": str(result.get("mode") or ""),
                    "status": str(result.get("status") or ""),
                    "extraction_id": str(result.get("extraction_id") or ""),
                }
            )
        except HTTPException as e:
            detail = e.detail if isinstance(e.detail, str) else str(e.detail)
            skipped.append({"id": job_id, "reason": detail[:200]})
        except Exception as e:
            skipped.append({"id": job_id, "reason": str(e)[:200]})

    return {
        "status": "queued",
        "enqueued": len(jobs_out),
        "jobs": jobs_out,
        "skipped": skipped,
    }


@router.post("/jobs/valid/{job_id}/rescrape", dependencies=[Depends(require_admin)])
async def rescrape_valid_job(
    job_id: str,
    request: RescrapeRequest,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(require_admin),
):
    """Admin-only: force-reset extraction and re-enqueue scraping (shared JD).

    Applicants must use ``/jobs/valid/{id}/prepare`` which analyzes from the
    saved JD when present and never re-extracts shared content.
    """
    from app.services.job_pipeline_mode import ingest_chain_user_id

    user_id = current_user.get("user_id")
    chain_user_id = ingest_chain_user_id(
        is_admin=True,
        user_id=user_id,
    )
    source_url = request.url.strip()

    async with get_session() as session:
        job = await _get_job_for_rescrape(session, job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Valid job not found")
        try:
            extraction_id = await _prepare_job_rescrape_in_session(
                session, job, source_url, chain_user_id
            )
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        await session.commit()

    await enqueue_extraction(
        extraction_id,
        source_url,
        user_id=chain_user_id,
        background_tasks=background_tasks,
    )
    logger.info(
        "rescrape_enqueued",
        job_id=job_id,
        extraction_id=extraction_id,
        url=source_url,
        chain_user_id=chain_user_id,
    )
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

    from sqlalchemy.orm import undefer

    async with get_session() as session:
        stmt = (
            select(UserJobStatus, Job, JobExtraction)
            .options(undefer(Job.description))
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
    """Counts for duplicates modal tabs - single query with conditional aggregation."""
    from app.services.job_exclusion_types import (
        BELOW_MIN_SCORE_EXCLUSION,
        EXTRACTION_FAILED_EXCLUSION,
        NON_US_LOCATION_EXCLUSION,
        OUTSIDE_PREFERRED_COUNTRIES_EXCLUSION,
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
                func.count().filter(
                    et.in_([NON_US_LOCATION_EXCLUSION, OUTSIDE_PREFERRED_COUNTRIES_EXCLUSION])
                ).label("non_us"),
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
    from sqlalchemy.orm import undefer

    async with get_session() as session:
        stmt = (
            select(UserJobStatus, Job, JobExtraction)
            .options(undefer(Job.description))
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
    llm_provider: str = "openai"
    default_llm_provider: str = "openai"
    available_providers: list[str] = Field(default_factory=lambda: ["openai"])
    llm_model: str | None = None
    default_llm_model: str = ""
    anthropic_key_mode: str = "default"
    anthropic_key_configured: bool = False
    anthropic_key_hint: str | None = None
    system_anthropic_available: bool = False
    gemini_key_mode: str = "default"
    gemini_key_configured: bool = False
    gemini_key_hint: str | None = None
    system_gemini_available: bool = False
    dedup_recycle_mode: str
    dedup_recycle_days: int
    dedup_recycle_days_custom: int
    default_dedup_recycle_days: int
    min_match_score_mode: str
    min_match_score: int
    min_match_score_custom: int
    default_min_match_score: int
    dedup_applied_company_mode: str = "default"
    dedup_applied_company_enabled: bool = False
    dedup_applied_company_enabled_custom: bool = False
    default_dedup_applied_company_enabled: bool = False
    dedup_score_comparison_mode: str = "default"
    dedup_score_comparison_enabled: bool = False
    dedup_score_comparison_enabled_custom: bool = False
    default_dedup_score_comparison_enabled: bool = False
    auto_prepare_match: bool = False
    auto_prepare_full: bool = False
    manual_submit_pipeline: str = "full"
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
    job_match_preferences: str = ""
    job_match_preferences_max_length: int = 4000
    country_preferences: list[str] = Field(default_factory=list)
    country_preferences_source: str = "unset"
    available_countries: list[dict] = Field(default_factory=list)
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
    llm_provider: str | None = Field(default=None, pattern="^(openai|anthropic|gemini)$")
    llm_model: str | None = Field(default=None, max_length=200)
    clear_llm_model: bool = False
    anthropic_key_mode: str | None = Field(default=None, pattern="^(default|custom)$")
    anthropic_api_key: str | None = Field(default=None, max_length=512)
    clear_anthropic_api_key: bool = False
    gemini_key_mode: str | None = Field(default=None, pattern="^(default|custom)$")
    gemini_api_key: str | None = Field(default=None, max_length=512)
    clear_gemini_api_key: bool = False
    dedup_recycle_mode: str | None = Field(default=None, pattern="^(default|custom)$")
    dedup_recycle_days: int | None = Field(default=None, ge=1, le=3650)
    min_match_score_mode: str | None = Field(default=None, pattern="^(default|custom)$")
    min_match_score: int | None = Field(default=None, ge=0, le=100)
    dedup_applied_company_mode: str | None = Field(default=None, pattern="^(default|custom)$")
    dedup_applied_company_enabled: bool | None = None
    dedup_score_comparison_mode: str | None = Field(default=None, pattern="^(default|custom)$")
    dedup_score_comparison_enabled: bool | None = None
    auto_prepare_match: bool | None = None
    auto_prepare_full: bool | None = None
    manual_submit_pipeline: str | None = None
    resume_tailoring_prompt_mode: str | None = Field(default=None, pattern="^(default|custom)$")
    resume_tailoring_prompt_custom: str | None = Field(default=None, max_length=12000)
    cover_letter_prompt_mode: str | None = Field(default=None, pattern="^(default|custom)$")
    cover_letter_prompt_custom: str | None = Field(default=None, max_length=12000)
    job_match_preferences: str | None = Field(default=None, max_length=4000)
    clear_job_match_preferences: bool = False
    # ISO alpha-2 codes (or country names); empty list = no location filter.
    country_preferences: list[str] | None = Field(default=None, max_length=30)


class OpenAiKeyTestRequest(BaseModel):
    """Test a key before save. Omit openai_api_key to test the user's stored custom key."""
    openai_api_key: str | None = Field(default=None, max_length=512)


class OpenAiKeyTestResponse(BaseModel):
    ok: bool
    message: str


class LlmKeyTestRequest(BaseModel):
    """Test a provider key before save. Omit api_key to test the user's stored key."""
    provider: str = Field(..., pattern="^(openai|anthropic|gemini)$")
    api_key: str | None = Field(default=None, max_length=512)


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
    from app.storage.user_repository import UserRepository
    from app.services.system_settings_service import get_effective_value_sync

    if mode == "default":
        return int(get_effective_value_sync("default_min_match_score"))
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


class DedupRulesPreviewSample(BaseModel):
    job_id: str
    title: str | None = None
    company: str | None = None
    exclusion_type: str | None = None
    action: str | None = None
    duplicated_because_id: str | None = None
    match_score: int | None = None
    best_score: int | None = None


class DedupRulesPreviewResponse(BaseModel):
    applied_company_enabled: bool
    score_comparison_enabled: bool
    recycle_days: int
    would_restore_count: int
    would_hide_applied_company_count: int
    would_hide_score_comparison_count: int
    already_hidden_applied_company_count: int
    already_hidden_score_comparison_count: int
    samples: list[DedupRulesPreviewSample]


class DedupRulesApplyResponse(BaseModel):
    success: bool
    restored: int
    restored_location_unknown: int
    hidden_applied_company: int
    hidden_score_comparison: int
    applied_company_enabled: bool
    score_comparison_enabled: bool
    recycle_days: int
    settings: UserSettingsResponse


@router.post(
    "/settings/dedup-rules/preview",
    response_model=DedupRulesPreviewResponse,
    dependencies=[Depends(get_current_user)],
)
async def preview_dedup_rules(
    current_user: dict = Depends(get_current_user),
) -> DedupRulesPreviewResponse:
    """Preview restore/hide impact using the user's saved effective dedup prefs."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    async with get_session() as session:
        user_repo = UserRepository(session)
        applied = await user_repo.get_effective_dedup_applied_company_enabled(user_id)
        score_cmp = await user_repo.get_effective_dedup_score_comparison_enabled(user_id)
        recycle_days = await user_repo.get_effective_dedup_recycle_days(user_id)

    from app.services.dedup_rules_reconcile import preview_dedup_rules_for_user

    data = await preview_dedup_rules_for_user(
        user_id,
        applied_company_enabled=applied,
        score_comparison_enabled=score_cmp,
        recycle_days=recycle_days,
    )
    return DedupRulesPreviewResponse(**data)


@router.post(
    "/settings/dedup-rules/apply",
    response_model=DedupRulesApplyResponse,
    dependencies=[Depends(get_current_user)],
)
async def apply_dedup_rules(
    current_user: dict = Depends(get_current_user),
) -> DedupRulesApplyResponse:
    """Apply saved effective dedup prefs to existing user_job_status rows."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    async with get_session() as session:
        user_repo = UserRepository(session)
        settings_data = await user_repo.get_user_settings(user_id)
        if not settings_data:
            raise HTTPException(status_code=404, detail="User not found")
        applied = await user_repo.get_effective_dedup_applied_company_enabled(user_id)
        score_cmp = await user_repo.get_effective_dedup_score_comparison_enabled(user_id)
        recycle_days = await user_repo.get_effective_dedup_recycle_days(user_id)

    from app.services.dedup_rules_reconcile import reconcile_dedup_rules_for_user

    result = await reconcile_dedup_rules_for_user(
        user_id,
        applied_company_enabled=applied,
        score_comparison_enabled=score_cmp,
        recycle_days=recycle_days,
    )
    logger.info(
        "dedup_rules_applied",
        user_id=user_id,
        restored=result["restored"],
        hidden_applied=result["hidden_applied_company"],
        hidden_score=result["hidden_score_comparison"],
    )
    return DedupRulesApplyResponse(
        success=True,
        settings=UserSettingsResponse(**settings_data),
        **{k: result[k] for k in (
            "restored",
            "restored_location_unknown",
            "hidden_applied_company",
            "hidden_score_comparison",
            "applied_company_enabled",
            "score_comparison_enabled",
            "recycle_days",
        )},
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


@router.post(
    "/settings/llm/test",
    response_model=OpenAiKeyTestResponse,
    dependencies=[Depends(get_current_user)],
)
async def test_llm_provider_key_endpoint(
    body: LlmKeyTestRequest,
    current_user: dict = Depends(get_current_user),
) -> OpenAiKeyTestResponse:
    from app.services.llm_key_test import test_provider_api_key
    from app.utils.secret_encryption import decrypt_secret

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    provider = body.provider.strip().lower()
    key_to_test = (body.api_key or "").strip()
    if not key_to_test:
        async with get_session() as session:
            user_repo = UserRepository(session)
            user = await user_repo.get_by_id(user_id)
            encrypted = getattr(user, f"{provider}_api_key_encrypted", None) if user else None
            if not encrypted:
                raise HTTPException(
                    status_code=400,
                    detail="Enter an API key to test, or save one first.",
                )
            try:
                key_to_test = decrypt_secret(encrypted)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))

    ok, message = await test_provider_api_key(provider, key_to_test)
    return OpenAiKeyTestResponse(ok=ok, message=message)


@router.get(
    "/settings/llm/models",
    dependencies=[Depends(get_current_user)],
)
async def list_user_llm_models(
    current_user: dict = Depends(get_current_user),
):
    """Discover chat models available on the user's OpenAI-compatible gateway key.

    Uses the same credential resolution as job analysis (admin binding → user key → .env).
    """
    from app.services.llm_model_discovery import list_models_for_api_key
    from app.services.llm_provider_keys_service import resolve_job_llm_credentials

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    async with get_session() as session:
        creds = await resolve_job_llm_credentials(
            session, job_type="job_analysis", user_id=user_id
        )
    api_key = (creds.get("openai_api_key") or "").strip()
    if not api_key:
        raise HTTPException(
            status_code=400,
            detail="No OpenAI-compatible API key available. Add one in Preferences or ask an admin.",
        )
    try:
        return await list_models_for_api_key(provider="openai", api_key=api_key)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


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
    from app.services.country_catalog import available_countries

    data["available_countries"] = available_countries()
    return UserSettingsResponse(**data)


@router.put(
    "/settings",
    response_model=UserSettingsResponse,
    dependencies=[Depends(get_current_user)],
)
async def update_user_settings(
    body: UserSettingsUpdateRequest,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
) -> UserSettingsResponse:
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    async with get_session() as session:
        user_repo = UserRepository(session)
        try:
            prev = await user_repo.get_user_settings(user_id)
            if not prev:
                raise HTTPException(status_code=404, detail="User not found")
            prev_match = bool(prev.get("auto_prepare_match"))
            prev_full = bool(prev.get("auto_prepare_full"))
            data = await user_repo.update_user_settings(
                user_id,
                openai_key_mode=body.openai_key_mode,
                openai_api_key=body.openai_api_key,
                clear_openai_api_key=body.clear_openai_api_key,
                llm_provider=body.llm_provider,
                llm_model=body.llm_model,
                clear_llm_model=body.clear_llm_model,
                anthropic_key_mode=body.anthropic_key_mode,
                anthropic_api_key=body.anthropic_api_key,
                clear_anthropic_api_key=body.clear_anthropic_api_key,
                gemini_key_mode=body.gemini_key_mode,
                gemini_api_key=body.gemini_api_key,
                clear_gemini_api_key=body.clear_gemini_api_key,
                dedup_recycle_mode=body.dedup_recycle_mode,
                dedup_recycle_days=body.dedup_recycle_days,
                min_match_score_mode=body.min_match_score_mode,
                min_match_score=body.min_match_score,
                dedup_applied_company_mode=body.dedup_applied_company_mode,
                dedup_applied_company_enabled=body.dedup_applied_company_enabled,
                dedup_score_comparison_mode=body.dedup_score_comparison_mode,
                dedup_score_comparison_enabled=body.dedup_score_comparison_enabled,
                auto_prepare_match=body.auto_prepare_match,
                auto_prepare_full=body.auto_prepare_full,
                manual_submit_pipeline=body.manual_submit_pipeline,
                resume_tailoring_prompt_mode=body.resume_tailoring_prompt_mode,
                resume_tailoring_prompt_custom=body.resume_tailoring_prompt_custom,
                cover_letter_prompt_mode=body.cover_letter_prompt_mode,
                cover_letter_prompt_custom=body.cover_letter_prompt_custom,
                job_match_preferences=body.job_match_preferences,
                clear_job_match_preferences=body.clear_job_match_preferences,
                country_preferences=body.country_preferences,
            )
            await session.commit()
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
    if not data:
        raise HTTPException(status_code=404, detail="User not found")

    if body.country_preferences is not None:
        # Re-bucket existing jobs under the new preferred countries.
        from app.services.job_location_reconcile import reconcile_job_locations_for_user

        background_tasks.add_task(reconcile_job_locations_for_user, user_id)
        logger.info(
            "country_preferences_reconcile_scheduled",
            user_id=user_id,
            countries=data.get("country_preferences"),
        )

    if (
        body.job_match_preferences is not None
        or body.clear_job_match_preferences
        or body.resume_tailoring_prompt_mode is not None
        or body.resume_tailoring_prompt_custom is not None
    ):
        # Vector match engine: preferences/guidance feed the profile encoding.
        try:
            from app.tasks.worker import enqueue_encode_user

            await enqueue_encode_user(user_id)
        except Exception as enc_err:
            logger.warning(
                "encode_user_enqueue_after_settings_failed",
                user_id=user_id,
                error=str(enc_err),
            )

    newly_match = bool(data.get("auto_prepare_match")) and not prev_match
    newly_full = bool(data.get("auto_prepare_full")) and not prev_full
    if newly_match or newly_full:
        from app.services.auto_prepare_service import backfill_auto_prepare_for_user

        full = bool(data.get("auto_prepare_full"))
        background_tasks.add_task(
            backfill_auto_prepare_for_user,
            user_id,
            match=True,
            full=full,
        )
        logger.info(
            "auto_prepare_backfill_scheduled",
            user_id=user_id,
            newly_match=newly_match,
            newly_full=newly_full,
            full=full,
        )

    logger.info("user_settings_saved", user_id=user_id)
    from app.services.country_catalog import available_countries

    data["available_countries"] = available_countries()
    return UserSettingsResponse(**data)


@router.post(
    "/settings/resume-template/preview",
    dependencies=[Depends(get_current_user)],
)
async def download_resume_design_docx(
    current_user: dict = Depends(get_current_user),
):
    """Download a .docx rendered from the user's saved Resume Builder design."""
    from app.services.resume_design_service import generate_saved_design_docx

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        docx_path = await generate_saved_design_docx(user_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("resume_design_docx_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail="Failed to generate document.")

    return FileResponse(
        path=str(docx_path),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename="resume.docx",
    )


@router.get(
    "/settings/resume-template/themes",
    dependencies=[Depends(get_current_user)],
)
async def get_resume_template_themes(
    current_user: dict = Depends(get_current_user),
):
    from app.services.resume_custom_theme_service import list_user_themes
    from app.services.resume_themes import build_catalog

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    catalog = build_catalog()
    catalog.themes = await list_user_themes(user_id)
    return catalog


@router.post(
    "/resume-builder/themes",
    dependencies=[Depends(get_current_user)],
)
async def save_resume_custom_theme(
    body: dict,
    current_user: dict = Depends(get_current_user),
):
    from app.models.resume_design_schemas import ResumeDesign, SaveCustomThemeRequest
    from app.services.resume_custom_theme_service import save_custom_theme

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        req = SaveCustomThemeRequest(
            name=str(body.get("name") or ""),
            design=ResumeDesign.model_validate(body.get("design") or {}),
        )
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    result = await save_custom_theme(user_id, req.name, req.design)
    return result


@router.post(
    "/resume-builder/themes/{theme_id}/love",
    dependencies=[Depends(get_current_user)],
)
async def toggle_resume_theme_love(
    theme_id: str,
    current_user: dict = Depends(get_current_user),
):
    from app.services.resume_custom_theme_service import toggle_theme_love

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        return await toggle_theme_love(user_id, theme_id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc


@router.delete(
    "/resume-builder/themes/{theme_id}",
    dependencies=[Depends(get_current_user)],
)
async def delete_resume_custom_theme(
    theme_id: str,
    current_user: dict = Depends(get_current_user),
):
    from app.services.resume_custom_theme_service import delete_custom_theme

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        themes = await delete_custom_theme(user_id, theme_id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return {"themes": themes}


@router.get(
    "/settings/resume-template/design",
    dependencies=[Depends(get_current_user)],
)
async def get_resume_template_design(
    current_user: dict = Depends(get_current_user),
):
    from app.models.resume_design_schemas import ResumeDesignResponse
    from app.services.resume_design_service import design_response_payload

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    async with get_session() as session:
        user_repo = UserRepository(session)
        user = await user_repo.get_by_id(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return ResumeDesignResponse(**design_response_payload(user))


@router.put(
    "/settings/resume-template/design",
    dependencies=[Depends(get_current_user)],
)
async def save_resume_template_design(
    body: ResumeDesignSaveRequest,
    current_user: dict = Depends(get_current_user),
):
    from app.models.resume_template_schemas import ResumeTemplateStatusResponse
    from app.services.resume_design_service import save_user_design

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        payload = await save_user_design(user_id, body.design)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("resume_design_save_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail="Failed to save resume design.")
    return ResumeTemplateStatusResponse(**payload)


@router.post(
    "/settings/resume-template/design/preview",
    dependencies=[Depends(get_current_user)],
)
async def preview_resume_template_design(
    body: ResumeDesignSaveRequest,
    current_user: dict = Depends(get_current_user),
):
    """Return the real dxpdf PDF for the builder's native PDF viewer embed."""
    from urllib.parse import quote

    from app.services.resume_builder_service import person_document_stem
    from app.services.resume_design_service import (
        generate_design_preview_pdf_bytes,
        register_preview_pdf_token,
    )
    from app.storage.user_repository import UserRepository

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        pdf_bytes, cache_key = await generate_design_preview_pdf_bytes(user_id, body.design)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("resume_design_preview_failed", user_id=user_id, error=str(e))
        raise HTTPException(
            status_code=503,
            detail="Failed to render the accurate PDF preview.",
        )

    # Named file so the browser PDF chrome shows ``Name_resume.pdf`` instead of a blob UUID.
    first = last = ""
    async with get_session() as session:
        user = await UserRepository(session).get_by_id(user_id)
        if user:
            first = (user.name_first or "").strip()
            last = (user.name_last or "").strip()
    filename = f"{person_document_stem(first, last, 'resume')}.pdf"
    token = register_preview_pdf_token(user_id, cache_key, filename)
    # Path ends with the real filename so Chromium's PDF viewer title is not a UUID.
    preview_path = f"/api/v1/settings/resume-template/design/preview-doc/{token}/{quote(filename)}"
    disposition = f"inline; filename=\"{filename}\"; filename*=UTF-8''{quote(filename)}"

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": disposition,
            "Cache-Control": "no-store",
            "X-Resume-Preview-Path": preview_path,
            "Access-Control-Expose-Headers": "Content-Disposition, X-Resume-Preview-Path",
        },
    )


@router.get(
    "/settings/resume-template/design/preview-doc/{token}/{filename}",
    dependencies=[Depends(get_current_user)],
)
async def preview_resume_template_design_doc(
    token: str,
    filename: str,
    current_user: dict = Depends(get_current_user),
):
    """Serve a cached preview PDF under a real ``Name_resume.pdf`` URL for the iframe."""
    from urllib.parse import quote

    from app.services.resume_design_service import get_preview_pdf_by_token

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    hit = get_preview_pdf_by_token(token, user_id)
    if not hit:
        raise HTTPException(status_code=404, detail="Preview expired — refresh the builder.")
    pdf_bytes, stored_name = hit
    safe_name = stored_name if stored_name.endswith(".pdf") else f"{stored_name}.pdf"
    disposition = f"inline; filename=\"{safe_name}\"; filename*=UTF-8''{quote(safe_name)}"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": disposition,
            "Cache-Control": "no-store",
        },
    )


@router.post(
    "/resume-builder/ai/chat",
    dependencies=[Depends(get_current_user)],
)
async def resume_builder_ai_chat(
    body: ResumeAiChatRequest,
    current_user: dict = Depends(get_current_user),
):
    """OneClick AI center: tailor a resume / score the match from a pasted job description.

    Streams Server-Sent Events so the builder can show live progress through the
    multi-step pipeline (routing → match analysis → evidence → tailoring). Event
    contract (one JSON object per `data:` line):
      {"stage": "routing"|"analyzing"|"evidence"|"tailoring", "label": "..."}  # progress
      {"stage": "done", "result": <ResumeAiChatResponse json>}                  # success
      {"stage": "error", "message": "..."}                                     # failure
    Job-less - nothing is persisted; the tailored content is returned to the builder."""
    import json as _json

    from app.services.resume_ai_chat_service import run_resume_ai_chat

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    def _sse(obj: dict) -> str:
        return f"data: {_json.dumps(obj, ensure_ascii=False)}\n\n"

    async def event_stream():
        queue: asyncio.Queue = asyncio.Queue()

        async def emit(ev: dict) -> None:
            await queue.put(ev)

        async def run() -> None:
            try:
                resp = await run_resume_ai_chat(
                    user_id, body.messages, body.last_job_description, emit=emit
                )
                await queue.put({"stage": "done", "result": resp.model_dump(mode="json")})
            except Exception as e:  # noqa: BLE001 - surface a clean SSE error
                logger.exception("resume_ai_chat_failed", user_id=user_id, error=str(e))
                await queue.put({"stage": "error", "message": "Failed to process request."})
            finally:
                await queue.put(None)  # sentinel: stream complete

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


# ─────────────────────────── Resume library (multi-resume) ───────────────────────────


class ResumeLibraryCreateRequest(BaseModel):
    name: str = ""
    design: ResumeDesign
    source: str = "manual"  # manual | tailored
    status: str = "draft"  # draft | completed
    job_title: str | None = None
    company: str | None = None
    activate: bool = True


class ResumeFromAiContentRequest(BaseModel):
    """Persist OneClick / extension AI-tailored sections into the library."""

    content: dict
    job_title: str | None = None
    company: str | None = None
    activate: bool = True


class ResumeLibraryUpdateRequest(BaseModel):
    name: str | None = None
    status: str | None = None  # draft | completed
    design: ResumeDesign | None = None


def _require_user_id(current_user: dict) -> str:
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return user_id


@router.get("/resume-builder/resumes", dependencies=[Depends(get_current_user)])
async def list_resume_library(current_user: dict = Depends(get_current_user)):
    """List the user's saved resumes (the library) + the active resume id."""
    from app.services.resume_design_service import list_resumes

    user_id = _require_user_id(current_user)
    try:
        return await list_resumes(user_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.exception("resume_library_list_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail="Failed to load resumes.")


@router.get("/resume-builder/resumes/search", dependencies=[Depends(get_current_user)])
async def search_resume_library(
    company: str | None = None,
    job_title: str | None = None,
    limit: int = 100,
    current_user: dict = Depends(get_current_user),
):
    """Search library resumes and completed job-workflow builds (company AND role)."""
    from app.services.resume_design_service import search_resumes

    user_id = _require_user_id(current_user)
    try:
        return await search_resumes(
            user_id,
            company=company,
            job_title=job_title,
            limit=limit,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.exception("resume_library_search_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail="Failed to search resumes.")


@router.post(
    "/resume-builder/resumes/from-job-build/{build_id}",
    dependencies=[Depends(get_current_user)],
)
async def open_job_build_resume(
    build_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Open a completed automated job resume in the builder (creates/updates library entry)."""
    from app.services.resume_design_service import open_job_build_as_library_resume

    user_id = _require_user_id(current_user)
    try:
        return await open_job_build_as_library_resume(user_id, build_id)
    except ValueError as e:
        detail = str(e)
        code = 404 if "not found" in detail.lower() else 400
        raise HTTPException(status_code=code, detail=detail)
    except Exception as e:
        logger.exception("resume_from_job_build_failed", user_id=user_id, build_id=build_id, error=str(e))
        raise HTTPException(status_code=500, detail="Failed to open job resume.")


@router.post(
    "/resume-builder/resumes/from-ai-content",
    dependencies=[Depends(get_current_user)],
)
async def save_ai_tailored_resume(
    body: ResumeFromAiContentRequest,
    current_user: dict = Depends(get_current_user),
):
    """Save OneClick / extension AI-tailored content into the resume library."""
    from app.services.resume_design_service import save_ai_tailored_as_library_resume

    user_id = _require_user_id(current_user)
    try:
        return await save_ai_tailored_as_library_resume(
            user_id,
            content=body.content,
            job_title=body.job_title,
            company=body.company,
            activate=body.activate,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("resume_from_ai_content_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail="Failed to save tailored resume.")


@router.post("/resume-builder/resumes", dependencies=[Depends(get_current_user)])
async def create_resume_library_entry(
    body: ResumeLibraryCreateRequest,
    current_user: dict = Depends(get_current_user),
):
    """Create a new saved resume (optionally activating it)."""
    from app.services.resume_design_service import create_resume

    user_id = _require_user_id(current_user)
    try:
        return await create_resume(
            user_id,
            name=body.name,
            design=body.design,
            source=body.source,
            status=body.status,
            job_title=body.job_title,
            company=body.company,
            activate=body.activate,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("resume_library_create_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail="Failed to create resume.")


@router.put("/resume-builder/resumes/{resume_id}", dependencies=[Depends(get_current_user)])
async def update_resume_library_entry(
    resume_id: str,
    body: ResumeLibraryUpdateRequest,
    current_user: dict = Depends(get_current_user),
):
    """Rename, change status (draft/completed), and/or replace the design of a resume."""
    from app.services.resume_design_service import update_resume

    user_id = _require_user_id(current_user)
    try:
        return await update_resume(
            user_id, resume_id, name=body.name, status=body.status, design=body.design
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.exception("resume_library_update_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail="Failed to update resume.")


@router.delete("/resume-builder/resumes/{resume_id}", dependencies=[Depends(get_current_user)])
async def delete_resume_library_entry(
    resume_id: str,
    current_user: dict = Depends(get_current_user),
):
    from app.services.resume_design_service import delete_resume

    user_id = _require_user_id(current_user)
    try:
        return await delete_resume(user_id, resume_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.exception("resume_library_delete_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail="Failed to delete resume.")


@router.post("/resume-builder/resumes/{resume_id}/duplicate", dependencies=[Depends(get_current_user)])
async def duplicate_resume_library_entry(
    resume_id: str,
    current_user: dict = Depends(get_current_user),
):
    from app.services.resume_design_service import duplicate_resume

    user_id = _require_user_id(current_user)
    try:
        return await duplicate_resume(user_id, resume_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.exception("resume_library_duplicate_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail="Failed to duplicate resume.")


@router.post("/resume-builder/resumes/{resume_id}/activate", dependencies=[Depends(get_current_user)])
async def activate_resume_library_entry(
    resume_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Make a saved resume the active one (loads it into the builder + mirrors it into
    the working template used by the extension / downloads / job-tailoring)."""
    from app.services.resume_design_service import activate_resume

    user_id = _require_user_id(current_user)
    try:
        return await activate_resume(user_id, resume_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.exception("resume_library_activate_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail="Failed to activate resume.")


@router.post(
    "/settings/cover-letter-template/from-resume-design",
    dependencies=[Depends(get_current_user)],
)
async def generate_cover_letter_template_from_resume_design(
    current_user: dict = Depends(get_current_user),
):
    from app.models.cover_letter_template_schemas import CoverLetterTemplateStatusResponse
    from app.services.resume_design_service import generate_cover_letter_from_design

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        payload = await generate_cover_letter_from_design(user_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("cover_letter_design_generate_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail="Failed to generate cover letter template.")
    return CoverLetterTemplateStatusResponse(**payload)


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
    """Stub - company-policy reconciliation is now handled by the post-analysis dedup service."""
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
        # job_id here is either the UserJobStatus.id or a Job.id - try both
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

        block_reason = _check_extraction_blocked(job.source_url or "")
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
    from app.services.job_pipeline_mode import ingest_chain_user_id, extraction_has_shared_jd

    chain_user_id = ingest_chain_user_id(
        is_admin=bool(current_user.get("is_admin")),
        user_id=user_id,
    )
    if extraction_id:
        async with get_session() as session:
            ext_repo = JobExtractionRepository(session)
            extraction = await ext_repo.get_by_id(extraction_id)
            if extraction and not extraction_has_shared_jd(extraction):
                await enqueue_extraction(
                    extraction_id,
                    source_url,
                    user_id=chain_user_id,
                    background_tasks=background_tasks,
                )
            elif extraction_has_shared_jd(extraction) and chain_user_id:
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
        # No extraction yet - create one and enqueue
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
                    extraction.id,
                    source_url,
                    user_id=chain_user_id,
                    background_tasks=background_tasks,
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


@router.post("/jobs/valid/delete/batch")
async def batch_delete_valid_jobs(
    body: ValidJobDeleteBatchRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """Remove multiple jobs. Admins hard-delete the shared rows (platform
    curation); applicants only hide them from their own list."""
    job_ids = list(dict.fromkeys(j for j in body.job_ids if j and str(j).strip()))
    if not job_ids:
        return {"deleted": 0}
    is_admin = bool(current_user.get("is_admin"))
    user_id = current_user.get("user_id")
    if not is_admin and not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    deleted = 0
    async with get_session() as session:
        for jid in job_ids:
            if is_admin:
                ok = await _purge_job_cascade(session, jid)
            else:
                ok = await _hide_job_for_user(session, jid, user_id)
            if ok:
                deleted += 1
        await session.commit()
    logger.info(
        "batch_delete_valid_jobs",
        deleted=deleted,
        requested=len(job_ids),
        mode="cascade" if is_admin else "user_hide",
    )
    return {"deleted": deleted}


@router.delete("/jobs/valid/{job_id}")
async def delete_valid_job(
    job_id: str,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """Admin: hard-delete the shared job and its cascade. Applicant: hide the
    job from their own list only (shared data is never destroyed)."""
    is_admin = bool(current_user.get("is_admin"))
    user_id = current_user.get("user_id")
    async with get_session() as session:
        if is_admin:
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
                mode="cascade",
            )
            return {"success": True}

        if not user_id:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
        ok = await _hide_job_for_user(session, job_id, user_id)
        if not ok:
            logger.warning("delete_valid_job_not_found", job_id=job_id)
            raise HTTPException(status_code=404, detail="Valid job not found")
        await session.commit()
        logger.info("delete_valid_job_success", job_id=job_id, user_id=user_id, mode="user_hide")
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
            detail="Could not queue tailored content generation. Ensure Redis and the tailoring worker are running.",
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

    # Resolve relative DB paths against project root / RESUME_OUTPUT_ROOT so
    # downloads (and the extension autofill attach flow) keep working after
    # local→VPS moves or CWD differences between API and workers.
    from app.services.resume_builder_service import resolve_resume_artifact_path

    p = resolve_resume_artifact_path(file_path)
    if p is None or not p.is_file():
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


class AutoPostFiltersPayload(BaseModel):
    """Auto-post filters: work mode allow-list + company exclude list."""

    work_modes: list[str] = Field(default_factory=list)
    exclude_companies: list[str] = Field(default_factory=list)


class SheetsAutoPostSettingsRequest(BaseModel):
    auto_post_threshold: int = Field(ge=0, le=100)
    auto_post_filters: AutoPostFiltersPayload = Field(default_factory=AutoPostFiltersPayload)


class SheetsEnabledRequest(BaseModel):
    is_enabled: bool


@router.get("/sheets/status", dependencies=[Depends(require_applicant)])
async def get_sheets_status():
    """Server-side Google Sheets credentials readiness."""
    from app.services.google_sheets_service import get_server_status

    return get_server_status()


@router.get("/sheets/tabs", dependencies=[Depends(require_applicant)])
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


@router.get("/sheets/config", dependencies=[Depends(require_applicant)])
async def get_sheets_config(current_user: dict = Depends(get_current_user)):
    """Get user's Google Sheets integration config."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    from app.services.google_sheets_service import get_user_config
    from app.services.auto_post_filters import normalize_auto_post_filters
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
        "auto_post_filters": normalize_auto_post_filters(getattr(config, "auto_post_filters", None)),
        "is_enabled": bool(getattr(config, "is_enabled", True)),
        "group_count": len(tab_groups),
        "assigned_tab_count": len(assigned_tabs),
    }


@router.post("/sheets/config", dependencies=[Depends(require_applicant)])
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
        "is_enabled": bool(getattr(config, "is_enabled", True)),
        "group_count": len(config.tab_groups or []),
        "assigned_tab_count": len([t for g in (config.tab_groups or []) for t in g]),
        "tab_warnings": tab_warnings,
    }


@router.patch("/sheets/config/auto-post-threshold", dependencies=[Depends(require_applicant)])
async def patch_sheets_auto_post_threshold(
    body: SheetsAutoPostThresholdRequest,
    current_user: dict = Depends(get_current_user),
):
    """Update auto-post match score threshold without changing tab groups."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    from app.services.auto_post_filters import normalize_auto_post_filters
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
        "auto_post_filters": normalize_auto_post_filters(getattr(config, "auto_post_filters", None)),
        "spreadsheet_url": config.spreadsheet_url,
        "tab_groups": tab_groups,
        "is_enabled": bool(getattr(config, "is_enabled", True)),
        "group_count": len(tab_groups),
        "assigned_tab_count": len([t for g in tab_groups for t in g]),
    }


@router.patch("/sheets/config/auto-post-settings", dependencies=[Depends(require_applicant)])
async def patch_sheets_auto_post_settings(
    body: SheetsAutoPostSettingsRequest,
    current_user: dict = Depends(get_current_user),
):
    """Update match-score threshold + dashboard-aligned auto-post filters together."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    from app.services.auto_post_filters import normalize_auto_post_filters
    from app.services.google_sheets_service import update_auto_post_settings

    try:
        config = await update_auto_post_settings(
            user_id,
            auto_post_threshold=body.auto_post_threshold,
            auto_post_filters=body.auto_post_filters.model_dump(),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("sheets_patch_auto_post_settings_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail=f"Failed to update auto-post settings: {e}")

    tab_groups = config.tab_groups or []
    return {
        "success": True,
        "auto_post_threshold": config.auto_post_threshold,
        "auto_post_filters": normalize_auto_post_filters(config.auto_post_filters),
        "spreadsheet_url": config.spreadsheet_url,
        "tab_groups": tab_groups,
        "is_enabled": bool(getattr(config, "is_enabled", True)),
        "group_count": len(tab_groups),
        "assigned_tab_count": len([t for g in tab_groups for t in g]),
    }


@router.patch("/sheets/config/enabled", dependencies=[Depends(require_applicant)])
async def patch_sheets_enabled(
    body: SheetsEnabledRequest,
    current_user: dict = Depends(get_current_user),
):
    """Soft-toggle Google Sheets auto-post without deleting the saved connection."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    from app.services.google_sheets_service import set_enabled

    try:
        config = await set_enabled(user_id, body.is_enabled)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("sheets_patch_enabled_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail=f"Failed to update Sheets enabled state: {e}")

    from app.services.auto_post_filters import normalize_auto_post_filters

    tab_groups = config.tab_groups or []
    return {
        "success": True,
        "is_enabled": bool(config.is_enabled),
        "configured": True,
        "spreadsheet_url": config.spreadsheet_url,
        "tab_groups": tab_groups,
        "auto_post_threshold": config.auto_post_threshold,
        "auto_post_filters": normalize_auto_post_filters(getattr(config, "auto_post_filters", None)),
        "group_count": len(tab_groups),
        "assigned_tab_count": len([t for g in tab_groups for t in g]),
    }


@router.delete("/sheets/config", dependencies=[Depends(require_applicant)])
async def delete_sheets_config(current_user: dict = Depends(get_current_user)):
    """Disconnect Google Sheets integration for the current user."""
    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    from app.services.google_sheets_service import delete_user_config

    removed = await delete_user_config(user_id)
    return {"success": True, "removed": removed}


@router.post("/sheets/post-jobs", dependencies=[Depends(require_applicant)])
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


# ── Pumble integration ─────────────────────────────────────────────────────


class PumbleVerifyRequest(BaseModel):
    api_key: str = Field(..., min_length=10)


class PumbleChannelsRequest(BaseModel):
    api_key: str | None = Field(default=None, min_length=10)
    integration_id: str | None = None


class PumbleConfigRequest(BaseModel):
    api_key: str = Field(..., min_length=10)
    channel_id: str = Field(..., min_length=1)
    channel_name: str = Field(..., min_length=1)
    workspace_id: str | None = None
    label: str | None = None
    auto_post_threshold: int = 75


class PumblePostJobsRequest(BaseModel):
    job_ids: list[str] = Field(..., min_length=1, max_length=200)
    integration_ids: list[str] | None = None


class PumbleAutoPostThresholdRequest(BaseModel):
    auto_post_threshold: int = Field(ge=0, le=100)


class PumbleAutoPostSettingsRequest(BaseModel):
    auto_post_threshold: int = Field(ge=0, le=100)
    auto_post_filters: AutoPostFiltersPayload = Field(default_factory=AutoPostFiltersPayload)


class PumbleEnabledRequest(BaseModel):
    is_enabled: bool


@router.get("/pumble/status", dependencies=[Depends(require_applicant)])
async def get_pumble_status():
    """Pumble integration is always available (user-provided API keys)."""
    return {"integration_available": True}


@router.post("/pumble/verify", dependencies=[Depends(require_applicant)])
async def verify_pumble_api_key(body: PumbleVerifyRequest):
    from app.services.pumble_service import verify_api_key

    try:
        return await verify_api_key(body.api_key)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("pumble_verify_failed", error=str(e))
        raise HTTPException(status_code=502, detail=f"Could not verify Pumble API key: {e}")


@router.post("/pumble/channels", dependencies=[Depends(require_applicant)])
async def list_pumble_channels(
    body: PumbleChannelsRequest,
    current_user: dict = Depends(get_current_user),
):
    from app.services.pumble_service import get_config_by_id, list_channels
    from app.utils.secret_encryption import decrypt_secret

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    api_key = (body.api_key or "").strip()
    if not api_key and body.integration_id:
        config = await get_config_by_id(user_id, body.integration_id)
        if not config:
            raise HTTPException(status_code=404, detail="Pumble destination not found")
        try:
            api_key = decrypt_secret(config.api_key_encrypted)
        except ValueError as e:
            raise HTTPException(status_code=500, detail="Stored API key could not be decrypted") from e
    if not api_key:
        raise HTTPException(status_code=400, detail="API key is required")

    try:
        channels = await list_channels(api_key)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("pumble_list_channels_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=502, detail=f"Could not list Pumble channels: {e}")

    return {"channels": channels, "channel_count": len(channels)}


@router.get("/pumble/config", dependencies=[Depends(require_applicant)])
async def get_pumble_config(current_user: dict = Depends(get_current_user)):
    from app.utils.secret_encryption import decrypt_secret, mask_api_key
    from app.services.pumble_service import _serialize_integration, list_user_configs

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    configs = await list_user_configs(user_id)
    if not configs:
        return {"configured": False, "integrations": [], "integration_count": 0}

    integrations = []
    for config in configs:
        try:
            api_key_hint = mask_api_key(decrypt_secret(config.api_key_encrypted))
        except ValueError:
            api_key_hint = "••••••••"
        integrations.append(_serialize_integration(config, api_key_hint=api_key_hint))

    threshold = configs[0].auto_post_threshold
    from app.services.auto_post_filters import normalize_auto_post_filters

    return {
        "configured": True,
        "integration_count": len(integrations),
        "integrations": integrations,
        "auto_post_threshold": threshold,
        "auto_post_filters": normalize_auto_post_filters(
            getattr(configs[0], "auto_post_filters", None)
        ),
    }


@router.post("/pumble/config", dependencies=[Depends(require_applicant)])
async def save_pumble_config(
    body: PumbleConfigRequest,
    current_user: dict = Depends(get_current_user),
):
    from app.services.pumble_service import _serialize_integration, create_config
    from app.utils.secret_encryption import mask_api_key

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    try:
        config = await create_config(
            user_id,
            body.api_key,
            body.channel_id,
            body.channel_name,
            workspace_id=body.workspace_id,
            label=body.label,
            auto_post_threshold=body.auto_post_threshold,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("pumble_save_config_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail=f"Failed to save Pumble config: {e}")

    return {
        "success": True,
        "integration": _serialize_integration(config, api_key_hint=mask_api_key(body.api_key.strip())),
    }


@router.patch("/pumble/config/auto-post-threshold", dependencies=[Depends(require_applicant)])
async def patch_pumble_auto_post_threshold(
    body: PumbleAutoPostThresholdRequest,
    current_user: dict = Depends(get_current_user),
):
    from app.services.auto_post_filters import normalize_auto_post_filters
    from app.services.pumble_service import update_auto_post_threshold

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    try:
        configs = await update_auto_post_threshold(user_id, body.auto_post_threshold)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("pumble_patch_auto_post_threshold_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail=f"Failed to update auto-post threshold: {e}")

    return {
        "success": True,
        "auto_post_threshold": body.auto_post_threshold,
        "auto_post_filters": normalize_auto_post_filters(
            getattr(configs[0], "auto_post_filters", None) if configs else None
        ),
        "integration_count": len(configs),
    }


@router.patch("/pumble/config/auto-post-settings", dependencies=[Depends(require_applicant)])
async def patch_pumble_auto_post_settings(
    body: PumbleAutoPostSettingsRequest,
    current_user: dict = Depends(get_current_user),
):
    """Update match-score threshold + dashboard-aligned filters on all destinations."""
    from app.services.auto_post_filters import normalize_auto_post_filters
    from app.services.pumble_service import update_auto_post_settings

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    try:
        configs = await update_auto_post_settings(
            user_id,
            auto_post_threshold=body.auto_post_threshold,
            auto_post_filters=body.auto_post_filters.model_dump(),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("pumble_patch_auto_post_settings_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail=f"Failed to update auto-post settings: {e}")

    return {
        "success": True,
        "auto_post_threshold": body.auto_post_threshold,
        "auto_post_filters": normalize_auto_post_filters(
            getattr(configs[0], "auto_post_filters", None) if configs else None
        ),
        "integration_count": len(configs),
    }


@router.patch("/pumble/config/enabled", dependencies=[Depends(require_applicant)])
async def patch_pumble_all_enabled(
    body: PumbleEnabledRequest,
    current_user: dict = Depends(get_current_user),
):
    """Soft-toggle auto-post for every Pumble destination (preserves connections)."""
    from app.services.auto_post_filters import normalize_auto_post_filters
    from app.services.pumble_service import _serialize_integration, set_all_enabled
    from app.utils.secret_encryption import decrypt_secret, mask_api_key

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    try:
        configs = await set_all_enabled(user_id, body.is_enabled)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("pumble_patch_all_enabled_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail=f"Failed to update Pumble enabled state: {e}")

    integrations = []
    for config in configs:
        try:
            api_key_hint = mask_api_key(decrypt_secret(config.api_key_encrypted))
        except ValueError:
            api_key_hint = "••••••••"
        integrations.append(_serialize_integration(config, api_key_hint=api_key_hint))

    return {
        "success": True,
        "is_enabled": body.is_enabled,
        "configured": True,
        "integration_count": len(integrations),
        "integrations": integrations,
        "auto_post_threshold": configs[0].auto_post_threshold if configs else 75,
        "auto_post_filters": normalize_auto_post_filters(
            getattr(configs[0], "auto_post_filters", None) if configs else None
        ),
    }


@router.patch("/pumble/config/{integration_id}/enabled", dependencies=[Depends(require_applicant)])
async def patch_pumble_integration_enabled(
    integration_id: str,
    body: PumbleEnabledRequest,
    current_user: dict = Depends(get_current_user),
):
    """Soft-toggle auto-post for a single Pumble destination."""
    from app.services.pumble_service import _serialize_integration, set_integration_enabled
    from app.utils.secret_encryption import decrypt_secret, mask_api_key

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    try:
        config = await set_integration_enabled(user_id, integration_id, body.is_enabled)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(
            "pumble_patch_integration_enabled_failed",
            user_id=user_id,
            integration_id=integration_id,
            error=str(e),
        )
        raise HTTPException(status_code=500, detail=f"Failed to update destination: {e}")

    try:
        api_key_hint = mask_api_key(decrypt_secret(config.api_key_encrypted))
    except ValueError:
        api_key_hint = "••••••••"

    return {
        "success": True,
        "integration": _serialize_integration(config, api_key_hint=api_key_hint),
    }


@router.delete("/pumble/config/{integration_id}", dependencies=[Depends(require_applicant)])
async def delete_pumble_integration(
    integration_id: str,
    current_user: dict = Depends(get_current_user),
):
    from app.services.pumble_service import delete_config_by_id

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    removed = await delete_config_by_id(user_id, integration_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Pumble destination not found")
    return {"success": True, "removed": True}


@router.delete("/pumble/config", dependencies=[Depends(require_applicant)])
async def delete_pumble_config(current_user: dict = Depends(get_current_user)):
    from app.services.pumble_service import delete_user_config

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    removed = await delete_user_config(user_id)
    return {"success": True, "removed": removed}


@router.post("/pumble/post-jobs", dependencies=[Depends(require_applicant)])
async def post_jobs_to_pumble(
    body: PumblePostJobsRequest,
    current_user: dict = Depends(get_current_user),
):
    from app.services.pumble_service import PumbleApiError, distribute_jobs, list_user_configs

    user_id = current_user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    configs = await list_user_configs(user_id, enabled_only=True)
    if not configs:
        raise HTTPException(
            status_code=400,
            detail="Pumble integration not configured. Set it up in Settings first.",
        )

    try:
        summary = await distribute_jobs(user_id, body.job_ids, integration_ids=body.integration_ids)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except PumbleApiError as e:
        logger.error("pumble_distribute_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:
        logger.error("pumble_distribute_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=502, detail=f"Failed to post jobs to Pumble: {e}")

    return {
        "success": True,
        "posted_count": len(summary["posted"]),
        "failed_count": len(summary.get("failed", [])),
        "skipped_already_in_thread": summary["skipped_already_in_thread"],
        "skipped_not_found": summary["skipped_not_found"],
        "results": summary["posted"],
        "failed_results": summary.get("failed", []),
        "integrations": summary.get("integrations", []),
        "destination_count": len(summary.get("integrations", [])),
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
