"""Admin-only APIs: users, system settings, ops, blocked domains, job cleanup."""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import ColumnElement, and_, func, literal_column, or_, select, text

from app.api.routes import _purge_job_cascade, health_check, require_admin
from app.core.logging import get_logger
from app.models.auth_schemas import UserResponse, check_password_policy
from app.models.database import Job, User
from app.services import blocked_domains_service, system_settings_service
from app.services import llm_provider_keys_service
from app.services.signup_approval_service import (
    APPROVAL_APPROVED,
    APPROVAL_PENDING,
    APPROVAL_REJECTED,
    active_keys_by_user,
    approve_user,
    issue_access_key,
    reject_user,
    revoke_open_keys,
    utcnow,
)
from app.storage.database import get_session
from app.storage.user_repository import UserRepository, user_applied_by_display_name

logger = get_logger(__name__)

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)])


def _user_response(user: User) -> UserResponse:
    return UserResponse(
        id=user.id,
        email=user.email,
        name=getattr(user, "name", None),
        display_name=user_applied_by_display_name(user),
        is_active=bool(user.is_active),
        is_admin=bool(getattr(user, "is_admin", False)),
        created_at=user.created_at,
        approval_status=user.approval_status,
        approved_at=user.approved_at,
    )


# ── Users ──────────────────────────────────────────────────────────────────


class AdminUserPatch(BaseModel):
    is_admin: bool | None = None
    is_active: bool | None = None


class ResetPasswordRequest(BaseModel):
    password: str = Field(..., min_length=8, max_length=255)

    @field_validator("password")
    @classmethod
    def _policy(cls, v: str) -> str:
        return check_password_policy(v)


class SignupAccessKeyInfo(BaseModel):
    created_at: datetime
    expires_at: datetime


class SignupRequestRow(BaseModel):
    id: str
    email: str
    approval_status: str
    requested_at: datetime
    active_key: SignupAccessKeyInfo | None = None


class IssueAccessKeyRequest(BaseModel):
    expires_at: datetime


class IssuedAccessKey(BaseModel):
    key: str
    expires_at: datetime


def _as_utc(value: datetime) -> datetime:
    """Columns hold naive UTC; tag it so browsers do not read it as local time."""
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


async def _load_user_for_update(session, user_id: str) -> User:
    user = (
        await session.execute(select(User).where(User.id == user_id).with_for_update())
    ).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    return user


@router.get("/signup-requests", response_model=list[SignupRequestRow])
async def list_signup_requests(current_user: dict = Depends(require_admin)):
    """Pending signups, oldest first, with each one's usable access key (if any)."""
    async with get_session() as session:
        users = (
            await session.execute(
                select(User).where(User.approval_status == APPROVAL_PENDING).order_by(User.created_at.asc())
            )
        ).scalars().all()
        keys = await active_keys_by_user(session, [u.id for u in users])
        return [
            SignupRequestRow(
                id=u.id,
                email=u.email,
                approval_status=u.approval_status,
                requested_at=_as_utc(u.created_at),
                active_key=(
                    SignupAccessKeyInfo(
                        created_at=_as_utc(keys[u.id].created_at), expires_at=_as_utc(keys[u.id].expires_at)
                    )
                    if u.id in keys
                    else None
                ),
            )
            for u in users
        ]


@router.post("/users/{user_id}/approve", response_model=UserResponse)
async def approve_signup(user_id: str, current_user: dict = Depends(require_admin)):
    async with get_session() as session:
        user = await _load_user_for_update(session, user_id)
        if user.approval_status != APPROVAL_APPROVED:
            await approve_user(session, user, admin_id=current_user["user_id"])
            await session.commit()
        return _user_response(user)


@router.post("/users/{user_id}/reject", response_model=UserResponse)
async def reject_signup(user_id: str, current_user: dict = Depends(require_admin)):
    if user_id == current_user.get("user_id"):
        raise HTTPException(status_code=400, detail="Cannot reject your own account")
    async with get_session() as session:
        user = await _load_user_for_update(session, user_id)
        if user.is_admin:
            raise HTTPException(status_code=400, detail="Demote this admin before rejecting the account")
        if user.approval_status != APPROVAL_REJECTED:
            await reject_user(session, user, admin_id=current_user["user_id"])
            await session.commit()
        return _user_response(user)


@router.post("/users/{user_id}/access-key", response_model=IssuedAccessKey)
async def issue_signup_access_key(
    user_id: str,
    body: IssueAccessKeyRequest,
    current_user: dict = Depends(require_admin),
):
    """Generate a one-time key for a pending signup. The plaintext is returned only here."""
    async with get_session() as session:
        user = await _load_user_for_update(session, user_id)
        try:
            key, row = await issue_access_key(
                session, user, expires_at=body.expires_at, admin_id=current_user["user_id"]
            )
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        await session.commit()
        return IssuedAccessKey(key=key, expires_at=_as_utc(row.expires_at))


@router.delete("/users/{user_id}/access-key")
async def revoke_signup_access_key(user_id: str, current_user: dict = Depends(require_admin)):
    async with get_session() as session:
        await _load_user_for_update(session, user_id)
        revoked = await revoke_open_keys(session, user_id)
        await session.commit()
        logger.info("signup_access_key_revoked", user_id=user_id, by=current_user.get("user_id"), count=revoked)
        return {"success": True, "revoked": revoked}


@router.get("/users", response_model=list[UserResponse])
async def list_users(current_user: dict = Depends(require_admin)):
    async with get_session() as session:
        repo = UserRepository(session)
        users = await repo.list_all_users()
        return [_user_response(u) for u in users]


@router.patch("/users/{user_id}", response_model=UserResponse)
async def patch_user(
    user_id: str,
    body: AdminUserPatch,
    current_user: dict = Depends(require_admin),
):
    if body.is_admin is None and body.is_active is None:
        raise HTTPException(status_code=400, detail="No fields to update")

    async with get_session() as session:
        repo = UserRepository(session)
        user = await repo.get_by_id(user_id)
        if not user:
            raise HTTPException(status_code=404, detail="User not found")

        admin_count = await repo.count_admins()
        is_active_admin = bool(user.is_admin and user.is_active)

        if body.is_admin is False and is_active_admin and admin_count <= 1:
            raise HTTPException(
                status_code=400,
                detail="Cannot demote the last remaining admin",
            )

        if body.is_active is False and is_active_admin and admin_count <= 1:
            raise HTTPException(
                status_code=400,
                detail="Cannot disable the last remaining admin",
            )

        if body.is_admin and user.approval_status != APPROVAL_APPROVED:
            raise HTTPException(status_code=400, detail="Approve this signup before making it an admin")

        if body.is_admin is not None:
            user.is_admin = body.is_admin
        if body.is_active is not None:
            user.is_active = body.is_active

        await session.flush()
        await session.commit()
        user = await repo.get_by_id(user_id)
        logger.info(
            "admin_user_patched",
            target_user_id=user_id,
            by=current_user.get("user_id"),
            is_admin=user.is_admin,
            is_active=user.is_active,
        )
        return _user_response(user)


@router.post("/users/{user_id}/reset-password")
async def reset_user_password(
    user_id: str,
    body: ResetPasswordRequest,
    current_user: dict = Depends(require_admin),
):
    async with get_session() as session:
        repo = UserRepository(session)
        user = await repo.get_by_id(user_id)
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        await repo.set_password(user_id, body.password)
        # Sign the user out everywhere (web and extension). An admin resetting
        # their own password keeps the session they are using right now.
        if user_id != current_user.get("user_id"):
            user.sessions_valid_after = utcnow()
        await session.commit()
        logger.info(
            "admin_password_reset",
            target_user_id=user_id,
            by=current_user.get("user_id"),
        )
        return {"success": True, "message": "Password updated"}


@router.delete("/users/{user_id}")
async def delete_user(
    user_id: str,
    current_user: dict = Depends(require_admin),
):
    if user_id == current_user.get("user_id"):
        raise HTTPException(status_code=400, detail="Cannot delete your own account")

    async with get_session() as session:
        repo = UserRepository(session)
        user = await repo.get_by_id(user_id)
        if not user:
            raise HTTPException(status_code=404, detail="User not found")

        if user.is_admin and user.is_active:
            admin_count = await repo.count_admins()
            if admin_count <= 1:
                raise HTTPException(
                    status_code=400,
                    detail="Cannot delete the last remaining admin",
                )

        await repo.delete_user(user_id)
        await session.commit()
        logger.info(
            "admin_user_deleted",
            target_user_id=user_id,
            by=current_user.get("user_id"),
        )
        return {"success": True}


# ── System settings ────────────────────────────────────────────────────────


class SystemSettingsUpdate(BaseModel):
    settings: dict[str, Any] = Field(default_factory=dict)


@router.get("/system-settings")
async def get_system_settings(current_user: dict = Depends(require_admin)):
    async with get_session() as session:
        return await system_settings_service.get_system_settings_payload(session)


@router.put("/system-settings")
async def put_system_settings(
    body: SystemSettingsUpdate,
    current_user: dict = Depends(require_admin),
):
    if not body.settings:
        raise HTTPException(status_code=400, detail="No settings provided")
    async with get_session() as session:
        try:
            payload = await system_settings_service.upsert_settings(
                session,
                body.settings,
                updated_by_user_id=current_user.get("user_id"),
            )
            await session.commit()
            return payload
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/system-settings/{key}")
async def delete_system_setting(
    key: str,
    current_user: dict = Depends(require_admin),
):
    async with get_session() as session:
        try:
            payload = await system_settings_service.clear_override(session, key)
            await session.commit()
            return payload
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc


# ── Ops ────────────────────────────────────────────────────────────────────


async def _arq_queue_pending(redis, queue_name: str) -> int:
    """arq stores pending jobs in a Redis sorted set (score = run_at)."""
    key_type = await redis.type(queue_name)
    type_name = key_type.decode() if isinstance(key_type, (bytes, bytearray)) else key_type
    if type_name in ("none", None):
        return 0
    if type_name == "zset":
        return int(await redis.zcard(queue_name) or 0)
    if type_name == "list":
        # Legacy / unexpected, keep readable rather than WRONGTYPE.
        return int(await redis.llen(queue_name) or 0)
    return 0


async def _queue_depths() -> list[dict[str, Any]]:
    """Best-effort Redis queue depth for each arq queue."""
    from app.tasks.worker import (
        ANALYSIS_QUEUE,
        AUTOPOST_QUEUE,
        EXTRACTION_QUEUE,
        RESUME_BUILD_QUEUE,
        SAVE_QUEUE,
        SCRAPER_QUEUE,
        TAILORING_QUEUE,
    )

    queue_defs = [
        {"id": "extraction", "name": EXTRACTION_QUEUE, "label": "Extraction", "description": "HTTP + browser job extraction"},
        {"id": "analysis", "name": ANALYSIS_QUEUE, "label": "Analysis", "description": "Phase A LLM match scoring"},
        {"id": "tailoring", "name": TAILORING_QUEUE, "label": "Tailoring", "description": "Phase B resume tailoring"},
        {"id": "save", "name": SAVE_QUEUE, "label": "Save", "description": "Per-user analyzed job persistence + Phase B enqueue"},
        {"id": "autopost", "name": AUTOPOST_QUEUE, "label": "Autopost", "description": "Sheets/Pumble auto-post"},
        {"id": "resume_build", "name": RESUME_BUILD_QUEUE, "label": "Resume build", "description": "DOCX/PDF document generation"},
        {"id": "scraper", "name": SCRAPER_QUEUE, "label": "Scraper", "description": "Spider crawl runs"},
    ]
    depths: list[dict[str, Any]] = []
    try:
        from app.core.redis_support import get_broker_redis, init_broker_redis_pool

        await init_broker_redis_pool()
        r = get_broker_redis()
        for q in queue_defs:
            try:
                pending = await _arq_queue_pending(r, q["name"])
                depths.append({**q, "pending": pending, "reachable": True})
            except Exception:
                depths.append({**q, "pending": None, "reachable": False})
    except Exception:
        for q in queue_defs:
            depths.append({**q, "pending": None, "reachable": False})
    return depths


@router.get("/ops/overview")
async def ops_overview(current_user: dict = Depends(require_admin)):
    health = await health_check()
    analysis_max = await system_settings_service.get_effective_value("analysis_worker_max_jobs")
    tailoring_max = await system_settings_service.get_effective_value("tailoring_worker_max_jobs")
    queues = await _queue_depths()

    try:
        from app.services.pipeline_health import heal_stale_pipeline_state

        healed = await heal_stale_pipeline_state()
    except Exception as heal_err:
        logger.warning("ops_overview_heal_failed", error=str(heal_err))
        healed = None

    async with get_session() as session:
        # Auto-heal stale scrapes (same as sync/status) so overview is accurate.
        await session.execute(
            text(
                "UPDATE scrape_runs "
                "SET status = 'interrupted', finished_at = now() "
                "WHERE status = 'running' "
                "  AND started_at < now() - INTERVAL '31 minutes'"
            )
        )
        await session.commit()

        running = (
            await session.execute(
                text(
                    "SELECT spider_name, items_scraped, items_new, items_updated, started_at, status "
                    "FROM scrape_runs WHERE status = 'running' "
                    "ORDER BY started_at DESC LIMIT 1"
                )
            )
        ).mappings().first()

        recent = (
            await session.execute(
                text(
                    "SELECT id, spider_name, status, items_scraped, items_new, items_updated, "
                    "started_at, finished_at "
                    "FROM scrape_runs ORDER BY started_at DESC LIMIT 10"
                )
            )
        ).mappings().all()

        scrape_status: dict[str, Any]
        if running:
            started_at = running.get("started_at")
            elapsed = None
            if started_at is not None:
                now = datetime.now(timezone.utc).replace(tzinfo=None)
                if getattr(started_at, "tzinfo", None) is not None:
                    started_at = started_at.astimezone(timezone.utc).replace(tzinfo=None)
                elapsed = max(0, int((now - started_at).total_seconds()))
            scrape_status = {
                "status": "running",
                "spider_name": running["spider_name"],
                "items_scraped": int(running.get("items_scraped") or 0),
                "items_new": int(running.get("items_new") or 0),
                "items_updated": int(running.get("items_updated") or 0),
                "started_at": started_at,
                "elapsed_seconds": elapsed,
            }
        else:
            scrape_status = {"status": "idle"}

    return {
        "health": health.model_dump() if hasattr(health, "model_dump") else health,
        "scrape": scrape_status,
        "recent_scrape_runs": [dict(r) for r in recent],
        "analysis_worker_max_jobs": analysis_max,
        "tailoring_worker_max_jobs": tailoring_max,
        "queues": queues,
        "healed": healed,
    }


@router.post("/ops/interrupt-stale-scrapes")
async def interrupt_stale_scrapes(current_user: dict = Depends(require_admin)):
    async with get_session() as session:
        result = await session.execute(
            text(
                "UPDATE scrape_runs "
                "SET status = 'interrupted', finished_at = now() "
                "WHERE status = 'running' "
                "  AND started_at < now() - INTERVAL '31 minutes' "
                "RETURNING id"
            )
        )
        ids = [row[0] for row in result.fetchall()]
        await session.commit()
        logger.info(
            "admin_interrupt_stale_scrapes",
            count=len(ids),
            by=current_user.get("user_id"),
        )
        return {"success": True, "interrupted_count": len(ids), "ids": ids}


@router.post("/ops/queues/clear")
async def clear_queue(
    body: dict[str, Any],
    current_user: dict = Depends(require_admin),
):
    """Clear pending jobs from a named arq queue (destructive)."""
    from app.tasks.worker import (
        ANALYSIS_QUEUE,
        AUTOPOST_QUEUE,
        EXTRACTION_QUEUE,
        RESUME_BUILD_QUEUE,
        SAVE_QUEUE,
        SCRAPER_QUEUE,
        TAILORING_QUEUE,
    )

    allowed = {
        "extraction": EXTRACTION_QUEUE,
        "analysis": ANALYSIS_QUEUE,
        "tailoring": TAILORING_QUEUE,
        "save": SAVE_QUEUE,
        "autopost": AUTOPOST_QUEUE,
        "resume_build": RESUME_BUILD_QUEUE,
        "scraper": SCRAPER_QUEUE,
    }
    queue_id = str(body.get("queue_id") or "").strip()
    confirm = bool(body.get("confirm"))
    if queue_id not in allowed:
        raise HTTPException(status_code=400, detail="Unknown queue_id")
    if not confirm:
        raise HTTPException(status_code=400, detail="confirm=true required")

    queue_name = allowed[queue_id]
    try:
        from app.core.redis_support import get_broker_redis, init_broker_redis_pool

        await init_broker_redis_pool()
        r = get_broker_redis()
        deleted = int(await r.delete(queue_name) or 0)
        logger.info(
            "admin_queue_cleared",
            queue_id=queue_id,
            queue_name=queue_name,
            deleted=deleted,
            by=current_user.get("user_id"),
        )
        return {"success": True, "queue_id": queue_id, "cleared": True, "keys_deleted": deleted}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to clear queue: {exc}") from exc


# ── LLM provider keys + job bindings ───────────────────────────────────────


class ProviderKeyCreate(BaseModel):
    provider: str = Field(..., min_length=3, max_length=20)
    label: str = Field(..., min_length=1, max_length=100)
    api_key: str = Field(..., min_length=8, max_length=500)


class ProviderKeyUpdate(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=100)
    api_key: str | None = Field(default=None, min_length=8, max_length=500)
    is_enabled: bool | None = None


class ProviderKeyValidate(BaseModel):
    provider: str = Field(..., min_length=3, max_length=20)
    api_key: str = Field(..., min_length=8, max_length=500)


class JobBindingsUpdate(BaseModel):
    bindings: list[dict[str, Any]] = Field(default_factory=list)


@router.get("/llm-keys")
async def list_llm_keys(current_user: dict = Depends(require_admin)):
    async with get_session() as session:
        keys = await llm_provider_keys_service.list_provider_keys(session)
        bindings = await llm_provider_keys_service.list_job_bindings(session)
        return {"keys": keys, "bindings": bindings, "job_types": llm_provider_keys_service.LLM_JOB_TYPES}


@router.post("/llm-keys/validate")
async def validate_llm_key(
    body: ProviderKeyValidate,
    current_user: dict = Depends(require_admin),
):
    """Lightweight live check before an admin registers a provider key."""
    from app.services.llm_key_test import test_provider_api_key

    ok, message = await test_provider_api_key(body.provider, body.api_key)
    return {"ok": ok, "message": message, "provider": body.provider.strip().lower()}


@router.post("/llm-keys", status_code=status.HTTP_201_CREATED)
async def create_llm_key(
    body: ProviderKeyCreate,
    current_user: dict = Depends(require_admin),
):
    from app.services.llm_key_test import test_provider_api_key

    ok, message = await test_provider_api_key(body.provider, body.api_key)
    if not ok:
        raise HTTPException(status_code=400, detail=f"API key validation failed: {message}")

    async with get_session() as session:
        try:
            row = await llm_provider_keys_service.create_provider_key(
                session,
                provider=body.provider,
                label=body.label,
                api_key=body.api_key,
                created_by_user_id=current_user.get("user_id"),
            )
            await session.commit()
            return row
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.patch("/llm-keys/{key_id}")
async def patch_llm_key(
    key_id: str,
    body: ProviderKeyUpdate,
    current_user: dict = Depends(require_admin),
):
    async with get_session() as session:
        try:
            row = await llm_provider_keys_service.update_provider_key(
                session,
                key_id,
                label=body.label,
                api_key=body.api_key,
                is_enabled=body.is_enabled,
            )
            await session.commit()
            return row
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/llm-keys/{key_id}")
async def delete_llm_key(
    key_id: str,
    current_user: dict = Depends(require_admin),
):
    async with get_session() as session:
        ok = await llm_provider_keys_service.delete_provider_key(session, key_id)
        if not ok:
            raise HTTPException(status_code=404, detail="Key not found")
        await session.commit()
        return {"success": True}


@router.put("/llm-job-bindings")
async def put_llm_job_bindings(
    body: JobBindingsUpdate,
    current_user: dict = Depends(require_admin),
):
    async with get_session() as session:
        try:
            bindings = await llm_provider_keys_service.upsert_job_bindings(
                session,
                body.bindings,
                updated_by_user_id=current_user.get("user_id"),
            )
            await session.commit()
            return {"bindings": bindings}
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/llm-keys/{key_id}/models")
async def list_models_for_provider_key(
    key_id: str,
    current_user: dict = Depends(require_admin),
):
    """Discover models available to a registered pool key (OpenAI-compatible / Gemini)."""
    from app.services.llm_model_discovery import list_models_for_api_key

    async with get_session() as session:
        creds = await llm_provider_keys_service.get_provider_key_plaintext(session, key_id)
        if not creds:
            raise HTTPException(status_code=404, detail="Key not found or disabled")
        provider, api_key = creds
    try:
        return await list_models_for_api_key(provider=provider, api_key=api_key)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/llm-models")
async def list_models_for_env_provider(
    provider: str = "openai",
    current_user: dict = Depends(require_admin),
):
    """Discover models for the server .env key of a provider (no pool key selected)."""
    from app.core.config import get_settings
    from app.services.llm_model_discovery import list_models_for_api_key

    provider = (provider or "openai").strip().lower()
    settings = get_settings()
    if provider == "openai":
        api_key = settings.openai_api_key or ""
    elif provider == "anthropic":
        api_key = settings.anthropic_api_key or ""
    elif provider == "gemini":
        api_key = settings.gemini_api_key or ""
    else:
        raise HTTPException(status_code=400, detail=f"Unknown provider '{provider}'")
    if not api_key.strip():
        # Every provider is probed on page load; a missing key is a normal state, not an error.
        return {
            "provider": provider,
            "models": [],
            "chat_models": [],
            "count": 0,
            "message": f"No {provider} API key configured in server environment.",
        }
    try:
        return await list_models_for_api_key(provider=provider, api_key=api_key)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class LlmBenchmarkModelTarget(BaseModel):
    provider: str = Field(..., min_length=1, max_length=32)
    model: str = Field(..., min_length=1, max_length=200)
    provider_key_id: str | None = Field(default=None, max_length=36)


class LlmBenchmarkRequest(BaseModel):
    models: list[LlmBenchmarkModelTarget] = Field(..., min_length=1, max_length=40)
    runs: int = Field(default=1, ge=1, le=10)
    concurrency: int = Field(default=1, ge=1, le=4)
    prompt: str = Field(default="Reply with exactly: ok", min_length=1, max_length=500)


@router.post("/llm-benchmark")
async def run_llm_benchmark(
    body: LlmBenchmarkRequest,
    current_user: dict = Depends(require_admin),
):
    """Time a tiny completion for each selected model (admin model picker aid)."""
    from app.services.llm_benchmark import BenchmarkTarget, benchmark_models

    targets = [
        BenchmarkTarget(
            provider=m.provider,
            model=m.model,
            provider_key_id=m.provider_key_id,
        )
        for m in body.models
    ]
    async with get_session() as session:
        try:
            results = await benchmark_models(
                session,
                targets,
                prompt=body.prompt,
                runs=body.runs,
                concurrency=body.concurrency,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    payload = [r.to_dict() for r in results]
    ok_count = sum(1 for r in payload if r["ok"])
    logger.info(
        "llm_benchmark_batch",
        admin_user_id=current_user.get("user_id"),
        models=len(targets),
        runs=body.runs,
        ok=ok_count,
        failed=len(payload) - ok_count,
    )
    return {
        "results": payload,
        "summary": {
            "total": len(payload),
            "ok": ok_count,
            "failed": len(payload) - ok_count,
            "runs": body.runs,
        },
    }


# ── Blocked domains ────────────────────────────────────────────────────────


class BlockedDomainCreate(BaseModel):
    domain: str = Field(..., min_length=1, max_length=255)
    reason: str = Field(..., min_length=1, max_length=2000)


@router.get("/blocked-domains")
async def get_blocked_domains(current_user: dict = Depends(require_admin)):
    async with get_session() as session:
        return {"domains": await blocked_domains_service.list_blocked_domains(session)}


@router.post("/blocked-domains", status_code=status.HTTP_201_CREATED)
async def create_blocked_domain(
    body: BlockedDomainCreate,
    current_user: dict = Depends(require_admin),
):
    async with get_session() as session:
        try:
            row = await blocked_domains_service.add_blocked_domain(
                session, body.domain, body.reason
            )
            await session.commit()
            return row
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/blocked-domains/{domain}")
async def delete_blocked_domain(
    domain: str,
    current_user: dict = Depends(require_admin),
):
    async with get_session() as session:
        ok = await blocked_domains_service.remove_blocked_domain(session, domain)
        if not ok:
            raise HTTPException(status_code=404, detail="Domain not found")
        await session.commit()
        return {"success": True}


# ── Global job cleanup ─────────────────────────────────────────────────────

CleanupMatchField = Literal[
    "company", "domain", "source_url", "normalized_url", "title"
]

_CLEANUP_FIELD_COLUMNS = {
    "company": Job.company,
    "domain": Job.domain,
    "source_url": Job.source_url,
    "normalized_url": Job.normalized_url,
    "title": Job.title,
}


class JobCleanupRequest(BaseModel):
    """Age and/or regex pattern purge. At least one criterion is required."""

    older_than_days: int | None = Field(None, ge=1, le=3650)
    pattern: str | None = Field(None, max_length=500)
    match_fields: list[CleanupMatchField] = Field(
        default_factory=lambda: ["company", "domain"]
    )
    case_insensitive: bool = True
    confirm: bool = False
    preview_only: bool = False
    sample_limit: int = Field(20, ge=1, le=50)

    @field_validator("pattern")
    @classmethod
    def _strip_pattern(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        return stripped or None

    @field_validator("match_fields")
    @classmethod
    def _dedupe_fields(cls, value: list[CleanupMatchField]) -> list[CleanupMatchField]:
        seen: set[str] = set()
        out: list[CleanupMatchField] = []
        for field in value:
            if field not in seen:
                seen.add(field)
                out.append(field)
        return out

    @model_validator(mode="after")
    def _require_criteria(self) -> JobCleanupRequest:
        if self.older_than_days is None and not self.pattern:
            raise ValueError("Provide older_than_days and/or a non-empty pattern")
        if self.pattern and not self.match_fields:
            raise ValueError("match_fields is required when pattern is set")
        return self


def _cleanup_mode(older_than_days: int | None, pattern: str | None) -> str:
    if older_than_days is not None and pattern:
        return "combined"
    if pattern:
        return "pattern"
    return "age"


def _cleanup_where(
    *,
    older_than_days: int | None,
    cutoff: datetime | None,
    pattern: str | None,
    match_fields: list[CleanupMatchField],
    case_insensitive: bool,
) -> list[ColumnElement[bool]]:
    clauses: list[ColumnElement[bool]] = []
    if older_than_days is not None and cutoff is not None:
        clauses.append(Job.created_at < cutoff)
    if pattern:
        # Validate with Python re first; Postgres POSIX ~ / ~* runs the query.
        flags = re.IGNORECASE if case_insensitive else 0
        try:
            re.compile(pattern, flags)
        except re.error as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid regex pattern: {exc}",
            ) from exc
        op = "~*" if case_insensitive else "~"
        field_clauses = [
            _CLEANUP_FIELD_COLUMNS[field].op(op)(pattern) for field in match_fields
        ]
        clauses.append(or_(*field_clauses))
    return clauses


def _cleanup_sample_row(job: Job) -> dict[str, Any]:
    return {
        "job_id": job.id,
        "title": job.title,
        "company": job.company,
        "domain": job.domain,
        "source_url": job.source_url,
        "created_at": job.created_at.isoformat() if job.created_at else None,
    }


@router.post("/jobs/cleanup")
async def cleanup_old_jobs(
    body: JobCleanupRequest,
    current_user: dict = Depends(require_admin),
):
    cutoff: datetime | None = None
    if body.older_than_days is not None:
        cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(
            days=body.older_than_days
        )

    where = _cleanup_where(
        older_than_days=body.older_than_days,
        cutoff=cutoff,
        pattern=body.pattern,
        match_fields=body.match_fields,
        case_insensitive=body.case_insensitive,
    )
    mode = _cleanup_mode(body.older_than_days, body.pattern)

    async with get_session() as session:
        count = (
            await session.execute(
                select(func.count()).select_from(Job).where(and_(*where))
            )
        ).scalar_one()
        count = int(count or 0)

        sample_rows = (
            await session.execute(
                select(Job)
                .where(and_(*where))
                .order_by(Job.created_at.asc(), Job.id.asc())
                .limit(body.sample_limit)
            )
        ).scalars().all()
        sample = [_cleanup_sample_row(job) for job in sample_rows]

        base_payload = {
            "preview": True,
            "mode": mode,
            "older_than_days": body.older_than_days,
            "pattern": body.pattern,
            "match_fields": list(body.match_fields) if body.pattern else [],
            "case_insensitive": body.case_insensitive if body.pattern else None,
            "cutoff": cutoff.isoformat() if cutoff else None,
            "matching_jobs": count,
            "deleted": 0,
            "sample": sample,
        }

        if body.preview_only or not body.confirm:
            return base_payload

        id_rows = await session.execute(select(Job.id).where(and_(*where)))
        job_ids = list(id_rows.scalars().all())
        deleted = 0
        for jid in job_ids:
            if await _purge_job_cascade(session, jid):
                deleted += 1
        await session.commit()
        logger.info(
            "admin_jobs_cleanup",
            deleted=deleted,
            mode=mode,
            older_than_days=body.older_than_days,
            pattern=body.pattern,
            match_fields=body.match_fields if body.pattern else [],
            by=current_user.get("user_id"),
        )
        return {
            **base_payload,
            "preview": False,
            "matching_jobs": count,
            "deleted": deleted,
            "sample": sample,
        }


# ── Vector match engine ─────────────────────────────────────────────────────

@router.post("/match-engine/backfill")
async def trigger_encoding_backfill(current_user: dict = Depends(require_admin)):
    """Enqueue the encoding backfill (all jobs/users missing current encodings)."""
    from app.core.redis_support import pipeline_job_id
    from app.tasks.worker import get_encoding_pool

    pool = await get_encoding_pool()
    job = await pool.enqueue_job(
        "backfill_encodings_task",
        _job_id=pipeline_job_id("encbackfill", "all", "all"),
    )
    already_running = job is None
    logger.info(
        "encoding_backfill_triggered",
        by=current_user.get("user_id"),
        already_running=already_running,
    )
    return {"enqueued": not already_running, "already_running": already_running}


@router.post("/match-engine/diagnose")
async def match_engine_diagnose(
    body: dict,
    current_user: dict = Depends(require_admin),
):
    """Timed, explainable probe for one job × user match (vector engine).

    Body:
      - job_id (required)
      - user_id (optional; defaults to the admin calling)
      - encode_if_missing (default true)
      - include_logs (default true)
      - log_hours (default 24)
      - persist (default false), also run full analysis and save the match
    """
    from app.services.match_diagnose_service import diagnose_job_match

    job_id = str(body.get("job_id") or "").strip()
    if not job_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="job_id required")
    user_id = str(body.get("user_id") or current_user.get("user_id") or "").strip()
    if not user_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="user_id required")

    encode_if_missing = bool(body.get("encode_if_missing", True))
    include_logs = bool(body.get("include_logs", True))
    persist = bool(body.get("persist", False))
    try:
        log_hours = int(body.get("log_hours") or 24)
    except (TypeError, ValueError):
        log_hours = 24

    result = await diagnose_job_match(
        job_id,
        user_id,
        encode_if_missing=encode_if_missing,
        include_logs=include_logs,
        log_hours=log_hours,
        persist=persist,
    )
    logger.info(
        "match_engine_diagnose_run",
        job_id=job_id,
        user_id=user_id,
        by=current_user.get("user_id"),
        ok=result.get("ok"),
        score=(result.get("vector_result") or {}).get("overall_score"),
        total_ms=(result.get("timing") or {}).get("total_ms"),
        persist=persist,
    )
    return result


@router.get("/match-engine/shadow-stats")
async def match_engine_shadow_stats(
    days: int = 30,
    current_user: dict = Depends(require_admin),
):
    """Aggregate LLM-vs-vector comparisons collected in shadow mode."""
    from app.models.database import JobEncoding, MatchEngineComparison, UserEncoding
    from app.services.system_settings_service import get_effective_value

    days = max(1, min(int(days or 30), 365))
    since = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=days)
    delta = MatchEngineComparison.vector_overall - MatchEngineComparison.llm_overall
    # Bounds are inlined so SELECT and GROUP BY render the same expression;
    # bound parameters get distinct placeholders and Postgres rejects the grouping.
    bucket = func.width_bucket(
        func.abs(delta), literal_column("0"), literal_column("50"), literal_column("5")
    )

    async with get_session() as session:
        agg = (
            await session.execute(
                select(
                    func.count(MatchEngineComparison.id),
                    func.avg(delta),
                    func.avg(func.abs(delta)),
                    func.max(func.abs(delta)),
                ).where(MatchEngineComparison.created_at >= since)
            )
        ).one()
        count, mean_delta, mae, max_abs = agg

        buckets_rows = (
            await session.execute(
                select(bucket, func.count(MatchEngineComparison.id))
                .where(MatchEngineComparison.created_at >= since)
                .group_by(bucket)
            )
        ).all()

        recent_rows = (
            await session.execute(
                select(MatchEngineComparison)
                .order_by(MatchEngineComparison.created_at.desc())
                .limit(20)
            )
        ).scalars().all()

        jobs_encoded = (
            await session.execute(select(func.count(JobEncoding.job_id)))
        ).scalar_one()
        users_encoded = (
            await session.execute(select(func.count(UserEncoding.user_id)))
        ).scalar_one()

        engine = await get_effective_value("match_engine", session)

    bucket_labels = {1: "0-10", 2: "10-20", 3: "20-30", 4: "30-40", 5: "40-50", 6: "50+"}
    return {
        "match_engine": engine,
        "window_days": days,
        "comparisons": int(count or 0),
        "mean_delta": round(float(mean_delta), 2) if mean_delta is not None else None,
        "mean_absolute_error": round(float(mae), 2) if mae is not None else None,
        "max_absolute_error": int(max_abs) if max_abs is not None else None,
        "abs_delta_histogram": {
            bucket_labels.get(int(bucket), str(bucket)): int(n)
            for bucket, n in buckets_rows
        },
        "jobs_encoded": int(jobs_encoded or 0),
        "users_encoded": int(users_encoded or 0),
        "recent": [
            {
                "job_id": row.job_id,
                "user_id": row.user_id,
                "llm": row.llm_overall,
                "vector": row.vector_overall,
                "delta": row.vector_overall - row.llm_overall,
                "at": row.created_at.isoformat() if row.created_at else None,
            }
            for row in recent_rows
        ],
    }
