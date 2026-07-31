"""Admin-only APIs: users, system settings, ops, blocked domains, job cleanup."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select, text

from app.api.routes import _purge_job_cascade, health_check, require_admin
from app.core.logging import get_logger
from app.models.auth_schemas import UserResponse
from app.models.database import Job, User
from app.services import blocked_domains_service, system_settings_service
from app.services import llm_provider_keys_service
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
    )


# ── Users ──────────────────────────────────────────────────────────────────


class AdminUserPatch(BaseModel):
    is_admin: bool | None = None
    is_active: bool | None = None


class ResetPasswordRequest(BaseModel):
    password: str = Field(..., min_length=8, max_length=255)


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
        # Legacy / unexpected — keep readable rather than WRONGTYPE.
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
        raise HTTPException(
            status_code=400,
            detail=f"No {provider} API key configured in server environment.",
        )
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


class JobCleanupRequest(BaseModel):
    older_than_days: int = Field(..., ge=1, le=3650)
    confirm: bool = False
    preview_only: bool = False


@router.post("/jobs/cleanup")
async def cleanup_old_jobs(
    body: JobCleanupRequest,
    current_user: dict = Depends(require_admin),
):
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(
        days=body.older_than_days
    )
    async with get_session() as session:
        count = (
            await session.execute(
                select(func.count()).select_from(Job).where(Job.created_at < cutoff)
            )
        ).scalar_one()
        count = int(count or 0)

        if body.preview_only or not body.confirm:
            return {
                "preview": True,
                "older_than_days": body.older_than_days,
                "cutoff": cutoff.isoformat(),
                "matching_jobs": count,
                "deleted": 0,
            }

        old_rows = await session.execute(select(Job.id).where(Job.created_at < cutoff))
        old_ids = list(old_rows.scalars().all())
        deleted = 0
        for jid in old_ids:
            if await _purge_job_cascade(session, jid):
                deleted += 1
        await session.commit()
        logger.info(
            "admin_jobs_cleanup",
            deleted=deleted,
            older_than_days=body.older_than_days,
            by=current_user.get("user_id"),
        )
        return {
            "preview": False,
            "older_than_days": body.older_than_days,
            "cutoff": cutoff.isoformat(),
            "matching_jobs": count,
            "deleted": deleted,
        }
