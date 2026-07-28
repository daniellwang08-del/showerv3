"""Admin LLM provider key pool + per-job bindings."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.models.database import LlmJobBinding, LlmProviderKey
from app.utils.secret_encryption import decrypt_secret, encrypt_secret, mask_api_key

logger = get_logger(__name__)

PROVIDERS = ("openai", "anthropic", "gemini")

# Platform LLM job types that can be bound to a specific registered key.
LLM_JOB_TYPES: dict[str, dict[str, str]] = {
    "job_analysis": {
        "label": "Job analysis (Phase A)",
        "description": "Match scoring and structured job extraction",
    },
    "resume_tailoring": {
        "label": "Resume tailoring (Phase B)",
        "description": "Tailored resume JSON and cover letter generation",
    },
    "resume_parse": {
        "label": "Resume parsing",
        "description": "Parse uploaded resumes into profile fields",
    },
    "profile_source_doc": {
        "label": "Profile source documents",
        "description": "Structured extraction from portfolio / source docs",
    },
    "profile_evidence": {
        "label": "Profile evidence",
        "description": "Job-relevant evidence from project materials",
    },
    "job_ai_search": {
        "label": "Job AI search",
        "description": "Natural-language search over saved jobs",
    },
    "scraper_ai_search": {
        "label": "Scraper AI search",
        "description": "Natural-language search over scraped jobs",
    },
    "attachment_url_ai": {
        "label": "Attachment URL extraction",
        "description": "Extract job URLs from uploaded attachments",
    },
    "resume_ai_chat": {
        "label": "Resume AI chat",
        "description": "Resume builder AI chat / intent routing",
    },
    "assistant_chat": {
        "label": "Assistant chat",
        "description": "In-app assistant streaming chat",
    },
    "extension_autofill": {
        "label": "Extension autofill",
        "description": "Browser extension application form autofill",
    },
    "agent": {
        "label": "Agent",
        "description": "Tool-using agentic assistant turns",
    },
}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


async def list_provider_keys(
    session: AsyncSession, *, provider: str | None = None
) -> list[dict[str, Any]]:
    stmt = select(LlmProviderKey).order_by(LlmProviderKey.provider.asc(), LlmProviderKey.label.asc())
    if provider:
        stmt = stmt.where(LlmProviderKey.provider == provider)
    rows = (await session.execute(stmt)).scalars().all()
    return [
        {
            "id": r.id,
            "provider": r.provider,
            "label": r.label,
            "key_hint": r.key_hint,
            "is_enabled": bool(r.is_enabled),
            "created_at": r.created_at,
            "updated_at": r.updated_at,
        }
        for r in rows
    ]


async def create_provider_key(
    session: AsyncSession,
    *,
    provider: str,
    label: str,
    api_key: str,
    created_by_user_id: str | None,
) -> dict[str, Any]:
    provider = provider.strip().lower()
    if provider not in PROVIDERS:
        raise ValueError(f"provider must be one of {', '.join(PROVIDERS)}")
    label_clean = (label or "").strip()
    if not label_clean:
        raise ValueError("label is required")
    key_clean = (api_key or "").strip()
    if len(key_clean) < 8:
        raise ValueError("api_key looks too short")

    existing = (
        await session.execute(
            select(LlmProviderKey).where(
                LlmProviderKey.provider == provider,
                LlmProviderKey.label == label_clean,
            )
        )
    ).scalar_one_or_none()
    if existing:
        raise ValueError(f"A key labeled '{label_clean}' already exists for {provider}")

    row = LlmProviderKey(
        provider=provider,
        label=label_clean,
        api_key_encrypted=encrypt_secret(key_clean),
        key_hint=mask_api_key(key_clean),
        is_enabled=True,
        created_by_user_id=created_by_user_id,
        created_at=_utcnow(),
        updated_at=_utcnow(),
    )
    session.add(row)
    await session.flush()
    logger.info("llm_provider_key_created", provider=provider, label=label_clean, id=row.id)
    return {
        "id": row.id,
        "provider": row.provider,
        "label": row.label,
        "key_hint": row.key_hint,
        "is_enabled": True,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


async def update_provider_key(
    session: AsyncSession,
    key_id: str,
    *,
    label: str | None = None,
    api_key: str | None = None,
    is_enabled: bool | None = None,
) -> dict[str, Any]:
    row = (
        await session.execute(select(LlmProviderKey).where(LlmProviderKey.id == key_id))
    ).scalar_one_or_none()
    if not row:
        raise LookupError("Key not found")

    if label is not None:
        label_clean = label.strip()
        if not label_clean:
            raise ValueError("label cannot be empty")
        clash = (
            await session.execute(
                select(LlmProviderKey).where(
                    LlmProviderKey.provider == row.provider,
                    LlmProviderKey.label == label_clean,
                    LlmProviderKey.id != key_id,
                )
            )
        ).scalar_one_or_none()
        if clash:
            raise ValueError(f"A key labeled '{label_clean}' already exists for {row.provider}")
        row.label = label_clean

    if api_key is not None and api_key.strip():
        key_clean = api_key.strip()
        if len(key_clean) < 8:
            raise ValueError("api_key looks too short")
        row.api_key_encrypted = encrypt_secret(key_clean)
        row.key_hint = mask_api_key(key_clean)

    if is_enabled is not None:
        row.is_enabled = bool(is_enabled)

    row.updated_at = _utcnow()
    await session.flush()
    return {
        "id": row.id,
        "provider": row.provider,
        "label": row.label,
        "key_hint": row.key_hint,
        "is_enabled": bool(row.is_enabled),
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


async def delete_provider_key(session: AsyncSession, key_id: str) -> bool:
    row = (
        await session.execute(select(LlmProviderKey).where(LlmProviderKey.id == key_id))
    ).scalar_one_or_none()
    if not row:
        return False
    await session.delete(row)
    await session.flush()
    logger.info("llm_provider_key_deleted", id=key_id)
    return True


async def list_job_bindings(session: AsyncSession) -> list[dict[str, Any]]:
    rows = (await session.execute(select(LlmJobBinding))).scalars().all()
    by_type = {r.job_type: r for r in rows}
    out: list[dict[str, Any]] = []
    for job_type, meta in LLM_JOB_TYPES.items():
        row = by_type.get(job_type)
        out.append(
            {
                "job_type": job_type,
                "label": meta["label"],
                "description": meta["description"],
                "provider_key_id": row.provider_key_id if row else None,
                "provider": row.provider if row else None,
                "model": (row.model if row and row.model else None) or None,
            }
        )
    return out


async def upsert_job_bindings(
    session: AsyncSession,
    bindings: list[dict[str, Any]],
    *,
    updated_by_user_id: str | None,
) -> list[dict[str, Any]]:
    for item in bindings:
        job_type = str(item.get("job_type") or "").strip()
        if job_type not in LLM_JOB_TYPES:
            raise ValueError(f"Unknown job_type: {job_type}")
        provider_key_id = item.get("provider_key_id")
        provider = item.get("provider")
        model_raw = item.get("model")
        model = None
        if model_raw is not None:
            model = str(model_raw).strip() or None
            if model and len(model) > 200:
                raise ValueError("model id is too long")
        if provider is not None:
            provider = str(provider).strip().lower() or None
            if provider and provider not in PROVIDERS:
                raise ValueError(f"Invalid provider: {provider}")
        if provider_key_id:
            key = (
                await session.execute(
                    select(LlmProviderKey).where(LlmProviderKey.id == provider_key_id)
                )
            ).scalar_one_or_none()
            if not key:
                raise ValueError(f"provider_key_id not found: {provider_key_id}")
            if provider and key.provider != provider:
                raise ValueError("provider does not match the selected key's provider")
            if not provider:
                provider = key.provider

        row = (
            await session.execute(select(LlmJobBinding).where(LlmJobBinding.job_type == job_type))
        ).scalar_one_or_none()
        if row:
            row.provider_key_id = provider_key_id or None
            row.provider = provider
            # Always persist model when the field is present in the payload so
            # clearing the dropdown (null/empty) resets the binding.
            if "model" in item:
                row.model = model
            row.updated_at = _utcnow()
            row.updated_by_user_id = updated_by_user_id
        else:
            session.add(
                LlmJobBinding(
                    job_type=job_type,
                    provider_key_id=provider_key_id or None,
                    provider=provider,
                    model=model if "model" in item else None,
                    updated_at=_utcnow(),
                    updated_by_user_id=updated_by_user_id,
                )
            )
    await session.flush()
    return await list_job_bindings(session)


async def get_provider_key_plaintext(
    session: AsyncSession, key_id: str
) -> tuple[str, str] | None:
    """Return ``(provider, api_key)`` for an enabled pool key, or None."""
    row = (
        await session.execute(
            select(LlmProviderKey).where(
                LlmProviderKey.id == key_id,
                LlmProviderKey.is_enabled.is_(True),
            )
        )
    ).scalar_one_or_none()
    if not row:
        return None
    try:
        plain = decrypt_secret(row.api_key_encrypted)
    except ValueError:
        return None
    if not plain:
        return None
    return row.provider, plain


async def resolve_job_llm_credentials(
    session: AsyncSession,
    *,
    job_type: str | None,
    user_id: str | None,
) -> dict[str, Any]:
    """Resolve provider + per-provider keys for a platform LLM job.

    Priority for the primary key of the bound provider:
      1. Admin job binding → registered provider key (if enabled)
      2. User custom key for that provider
      3. Server .env key for that provider

    Other providers still resolve via user/env for fallback.
    """
    from app.storage.user_repository import UserRepository

    repo = UserRepository(session)
    provider = await repo.resolve_llm_provider(user_id) if user_id else None
    from app.services.system_settings_service import get_effective_value

    if not provider:
        provider = str(await get_effective_value("default_llm_provider", session))

    openai_key = await repo.resolve_provider_api_key(user_id, "openai") if user_id else ""
    anthropic_key = await repo.resolve_provider_api_key(user_id, "anthropic") if user_id else ""
    gemini_key = await repo.resolve_provider_api_key(user_id, "gemini") if user_id else ""

    # Fill env defaults when no user
    if not user_id:
        from app.core.config import get_settings

        s = get_settings()
        openai_key = s.openai_api_key or ""
        anthropic_key = s.anthropic_api_key or ""
        gemini_key = s.gemini_api_key or ""

    bound_key_id = None
    admin_bound_model: str | None = None
    if job_type and job_type in LLM_JOB_TYPES:
        binding = (
            await session.execute(
                select(LlmJobBinding).where(LlmJobBinding.job_type == job_type)
            )
        ).scalar_one_or_none()
        if binding:
            if binding.provider:
                provider = binding.provider
            if binding.model:
                admin_bound_model = str(binding.model).strip() or None
            if binding.provider_key_id:
                key_row = (
                    await session.execute(
                        select(LlmProviderKey).where(
                            LlmProviderKey.id == binding.provider_key_id,
                            LlmProviderKey.is_enabled.is_(True),
                        )
                    )
                ).scalar_one_or_none()
                if key_row:
                    bound_key_id = key_row.id
                    try:
                        plain = decrypt_secret(key_row.api_key_encrypted)
                    except ValueError:
                        plain = ""
                    if plain:
                        if key_row.provider == "openai":
                            openai_key = plain
                        elif key_row.provider == "anthropic":
                            anthropic_key = plain
                        elif key_row.provider == "gemini":
                            gemini_key = plain
                        provider = key_row.provider

    # Admin System Settings job→model bindings win for platform jobs. The
    # dashboard model is only a fallback when that job has no model binding.
    # User/dashboard model ids always use the OpenAI-compatible adapter.
    user_model: str | None = None
    if user_id:
        user = await repo.get_by_id(user_id)
        if user:
            user_model = (getattr(user, "llm_model", None) or "").strip() or None

    bound_model: str | None = None
    if admin_bound_model:
        bound_model = admin_bound_model
    elif user_model and (openai_key or "").strip():
        bound_model = user_model
        provider = "openai"

    return {
        "provider": provider,
        "openai_api_key": openai_key or "",
        "anthropic_api_key": anthropic_key or "",
        "gemini_api_key": gemini_key or "",
        "bound_key_id": bound_key_id,
        "bound_model": bound_model,
        "job_type": job_type,
    }
