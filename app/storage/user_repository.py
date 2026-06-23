from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.models.database import User
from app.services.auth_service import AuthService
from app.core.config import get_settings
from app.prompts.cover_letter_prompt import (
    COVER_LETTER_INSTRUCTIONS,
    COVER_LETTER_PROMPT_MAX_LENGTH,
    COVER_LETTER_PROMPT_MIN_LENGTH,
)
from app.prompts.job_match_phase_b_prompt import (
    JOB_MATCH_PHASE_B_OUTPUT_CONTRACT,
    RESUME_TAILORING_INSTRUCTIONS,
    RESUME_TAILORING_PROMPT_MAX_LENGTH,
    RESUME_TAILORING_PROMPT_MIN_LENGTH,
    build_phase_b_system_prompt,
)
from app.core.exceptions import AIParsingError
from app.utils.profile_converter import user_profile_to_openai_text
from app.utils.secret_encryption import decrypt_secret, encrypt_secret, mask_api_key
from app.services.resume_template_service import (
    count_work_roles,
    mark_template_stale_if_work_count_changed,
    template_status_payload,
)
from app.services.cover_letter_template_service import template_status_payload as cover_letter_template_status_payload
from app.core.logging import get_logger

logger = get_logger(__name__)


def _profile_display_name(first: str | None, middle: str | None, last: str | None) -> str:
    parts = [p for p in (first, middle, last) if p and str(p).strip()]
    return " ".join(parts) if parts else ""


def user_applied_by_display_name(user: User) -> str:
    """Label stored when marking jobs as applied: profile full name, header name, or email."""
    from_parts = _profile_display_name(user.name_first, user.name_middle, user.name_last)
    if from_parts.strip():
        return from_parts.strip()[:300]
    if user.name and str(user.name).strip():
        return str(user.name).strip()[:300]
    return (user.email or "Unknown")[:300]


class UserRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def get_by_email(self, email: str) -> User | None:
        """Get user by email"""
        stmt = select(User).where(User.email == email.lower().strip())
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def get_by_id(self, user_id: str) -> User | None:
        """Get user by ID"""
        stmt = select(User).where(User.id == user_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def create(self, email: str, password: str) -> User:
        """Create a new user with hashed password"""
        email = email.lower().strip()
        password_hash = AuthService.hash_password(password)
        
        user = User(
            email=email,
            password_hash=password_hash,
            is_active=True
        )
        
        self.session.add(user)
        await self.session.flush()
        logger.info("user_created", user_id=user.id, email=email)
        return user

    async def verify_credentials(self, email: str, password: str) -> User | None:
        """Verify user credentials and return user if valid"""
        user = await self.get_by_email(email)
        if not user or not user.is_active:
            return None
        
        if not AuthService.verify_password(password, user.password_hash):
            return None
        
        return user

    async def update_user(self, user_id: str, **kwargs) -> User | None:
        """Update user fields"""
        user = await self.get_by_id(user_id)
        if not user:
            return None
        
        for key, value in kwargs.items():
            if hasattr(user, key):
                setattr(user, key, value)
        
        await self.session.flush()
        return user

    async def deactivate(self, user_id: str) -> bool:
        """Deactivate a user"""
        user = await self.update_user(user_id, is_active=False)
        if user:
            logger.info("user_deactivated", user_id=user_id)
            return True
        return False

    async def update_profile(self, user_id: str, data: dict) -> tuple[User | None, bool]:
        """Update user's single profile (stored on User model).

        Returns (user, should_reanalyze_template).
        """
        user = await self.get_by_id(user_id)
        if not user:
            return None, False
        old_work_count = count_work_roles(user)
        name = _profile_display_name(
            data.get("name_first"),
            data.get("name_middle"),
            data.get("name_last"),
        )
        user.name = name or user.name
        user.name_first = data.get("name_first")
        user.name_middle = data.get("name_middle")
        user.name_last = data.get("name_last")
        user.profile_title = data.get("title")
        user.profile_email = data.get("email")
        user.phone_country_code = data.get("phone_country_code")
        user.phone_number = data.get("phone_number")
        user.linkedin_url = data.get("linkedin_url")
        user.github_url = data.get("github_url")
        user.profile_summary = data.get("profile_summary")
        user.technical_skills = data.get("technical_skills") or []
        user.work_experience = data.get("work_experience") or []
        user.education = data.get("education") or []
        user.certificates = data.get("certificates") or []
        user.extra = data.get("extra") or []
        user.eeo_preferences = data.get("eeo_preferences") or {}
        user.address = data.get("address") or {}
        user.profile_openai_cache = user_profile_to_openai_text(user)
        new_work_count = count_work_roles(user)
        should_reanalyze = mark_template_stale_if_work_count_changed(user, new_work_count)
        if should_reanalyze and old_work_count != new_work_count:
            user.resume_template_profile_work_count = old_work_count
        await self.session.flush()
        logger.info(
            "profile_updated",
            user_id=user_id,
            should_reanalyze_template=should_reanalyze,
        )
        return user, should_reanalyze

    async def get_profile_openai_text(self, user_id: str) -> str:
        """
        Get cached OpenAI-ready profile text. Uses cache if present,
        otherwise computes from profile and backfills cache.
        """
        user = await self.get_by_id(user_id)
        if not user:
            return ""
        cached = getattr(user, "profile_openai_cache", None)
        if cached and str(cached).strip():
            return str(cached)
        text = user_profile_to_openai_text(user)
        user.profile_openai_cache = text
        await self.session.flush()
        return text

    async def get_dedup_recycle_days(self, user_id: str) -> int:
        """Return effective dedup recycle window (respects default vs custom mode)."""
        return await self.get_effective_dedup_recycle_days(user_id)

    async def get_effective_dedup_recycle_days(self, user_id: str) -> int:
        """Return recycle days: system default or user's custom value."""
        settings = get_settings()
        user = await self.get_by_id(user_id)
        if not user:
            return settings.default_dedup_recycle_days
        mode = getattr(user, "dedup_recycle_mode", None) or "default"
        if mode == "custom":
            return self._clamp_dedup_days(getattr(user, "dedup_recycle_days", None))
        return settings.default_dedup_recycle_days

    @staticmethod
    def _clamp_dedup_days(val: int | None) -> int:
        settings = get_settings()
        fallback = settings.default_dedup_recycle_days
        if val is None:
            return fallback
        try:
            return max(1, min(3650, int(val)))
        except (TypeError, ValueError):
            return fallback

    @staticmethod
    def _clamp_min_match_score(val: int | None) -> int:
        settings = get_settings()
        fallback = settings.default_min_match_score
        if val is None:
            return fallback
        try:
            return max(0, min(100, int(val)))
        except (TypeError, ValueError):
            return fallback

    async def get_effective_min_match_score(self, user_id: str) -> int:
        """Return minimum match score threshold (0 = show all)."""
        settings = get_settings()
        user = await self.get_by_id(user_id)
        if not user:
            return settings.default_min_match_score
        mode = getattr(user, "min_match_score_mode", None) or "default"
        if mode == "custom":
            return self._clamp_min_match_score(getattr(user, "min_match_score", None))
        return settings.default_min_match_score

    @staticmethod
    def _validate_resume_tailoring_instructions(text: str) -> str:
        cleaned = text.strip()
        if len(cleaned) < RESUME_TAILORING_PROMPT_MIN_LENGTH:
            raise ValueError(
                f"Resume tailoring prompt must be at least {RESUME_TAILORING_PROMPT_MIN_LENGTH} characters"
            )
        if len(cleaned) > RESUME_TAILORING_PROMPT_MAX_LENGTH:
            raise ValueError(
                f"Resume tailoring prompt must be at most {RESUME_TAILORING_PROMPT_MAX_LENGTH:,} characters"
            )
        return cleaned

    @staticmethod
    def _validate_cover_letter_instructions(text: str) -> str:
        cleaned = text.strip()
        if len(cleaned) < COVER_LETTER_PROMPT_MIN_LENGTH:
            raise ValueError(
                f"Cover letter prompt must be at least {COVER_LETTER_PROMPT_MIN_LENGTH} characters"
            )
        if len(cleaned) > COVER_LETTER_PROMPT_MAX_LENGTH:
            raise ValueError(
                f"Cover letter prompt must be at most {COVER_LETTER_PROMPT_MAX_LENGTH:,} characters"
            )
        return cleaned

    def _resume_tailoring_instructions_for_user(self, user: User | None) -> str:
        mode = getattr(user, "resume_tailoring_prompt_mode", None) or "default" if user else "default"
        if mode == "custom":
            custom = (getattr(user, "resume_tailoring_prompt_custom", None) or "").strip()
            if custom:
                return custom
        return RESUME_TAILORING_INSTRUCTIONS.strip()

    def _cover_letter_instructions_for_user(self, user: User | None) -> str:
        mode = getattr(user, "cover_letter_prompt_mode", None) or "default" if user else "default"
        if mode == "custom":
            custom = (getattr(user, "cover_letter_prompt_custom", None) or "").strip()
            if custom:
                return custom
        return COVER_LETTER_INSTRUCTIONS.strip()

    async def get_effective_resume_tailoring_system_prompt(self, user_id: str) -> str:
        """Return Phase B system prompt (editable instructions + locked output contract)."""
        user = await self.get_by_id(user_id)
        resume_instructions = self._resume_tailoring_instructions_for_user(user)
        cover_letter_instructions = self._cover_letter_instructions_for_user(user)
        return build_phase_b_system_prompt(resume_instructions, cover_letter_instructions)

    async def get_effective_resume_tailoring_instructions(self, user_id: str) -> str:
        user = await self.get_by_id(user_id)
        return self._resume_tailoring_instructions_for_user(user)

    async def get_effective_cover_letter_instructions(self, user_id: str) -> str:
        user = await self.get_by_id(user_id)
        return self._cover_letter_instructions_for_user(user)

    async def update_dedup_recycle_days(self, user_id: str, days: int) -> bool:
        """Update dedup_recycle_days (1–3650). Returns True on success."""
        days = self._clamp_dedup_days(days)
        user = await self.get_by_id(user_id)
        if not user:
            return False
        user.dedup_recycle_days = days
        user.dedup_recycle_mode = "custom"
        await self.session.flush()
        logger.info("dedup_recycle_days_updated", user_id=user_id, days=days)
        return True

    async def get_user_settings(self, user_id: str) -> dict | None:
        user = await self.get_by_id(user_id)
        if not user:
            return None
        settings = get_settings()
        mode = getattr(user, "openai_key_mode", None) or "default"
        dedup_mode = getattr(user, "dedup_recycle_mode", None) or "default"
        custom_days = self._clamp_dedup_days(getattr(user, "dedup_recycle_days", None))
        has_custom_key = bool(getattr(user, "openai_api_key_encrypted", None))
        key_hint: str | None = None
        if mode == "custom" and has_custom_key:
            try:
                plain = decrypt_secret(user.openai_api_key_encrypted)
                key_hint = mask_api_key(plain)
            except ValueError:
                key_hint = "••••••••"

        effective_days = (
            custom_days if dedup_mode == "custom" else settings.default_dedup_recycle_days
        )
        min_score_mode = getattr(user, "min_match_score_mode", None) or "default"
        custom_min_score = self._clamp_min_match_score(getattr(user, "min_match_score", None))
        effective_min_score = (
            custom_min_score if min_score_mode == "custom" else settings.default_min_match_score
        )
        prompt_mode = getattr(user, "resume_tailoring_prompt_mode", None) or "default"
        stored_custom_prompt = (getattr(user, "resume_tailoring_prompt_custom", None) or "").strip()
        effective_instructions = self._resume_tailoring_instructions_for_user(user)
        cover_letter_prompt_mode = getattr(user, "cover_letter_prompt_mode", None) or "default"
        stored_custom_cover_letter_prompt = (getattr(user, "cover_letter_prompt_custom", None) or "").strip()
        effective_cover_letter_instructions = self._cover_letter_instructions_for_user(user)
        active_provider = (getattr(user, "llm_provider", None) or "").strip().lower()
        if active_provider not in self.LLM_PROVIDERS:
            active_provider = settings.default_llm_provider
        return {
            "openai_key_mode": mode,
            "openai_key_configured": has_custom_key,
            "openai_key_hint": key_hint,
            "system_openai_available": bool(settings.openai_api_key),
            "llm_provider": active_provider,
            "default_llm_provider": settings.default_llm_provider,
            "available_providers": self._available_providers(user),
            **self._provider_key_info(user, "anthropic"),
            **self._provider_key_info(user, "gemini"),
            "dedup_recycle_mode": dedup_mode,
            "dedup_recycle_days": effective_days,
            "dedup_recycle_days_custom": custom_days,
            "default_dedup_recycle_days": settings.default_dedup_recycle_days,
            "min_match_score_mode": min_score_mode,
            "min_match_score": effective_min_score,
            "min_match_score_custom": custom_min_score,
            "default_min_match_score": settings.default_min_match_score,
            "resume_tailoring_prompt_mode": prompt_mode,
            "resume_tailoring_prompt_instructions": effective_instructions,
            "resume_tailoring_prompt_instructions_custom": stored_custom_prompt,
            "default_resume_tailoring_prompt_instructions": RESUME_TAILORING_INSTRUCTIONS.strip(),
            "resume_tailoring_output_contract": JOB_MATCH_PHASE_B_OUTPUT_CONTRACT.strip(),
            "resume_tailoring_prompt_max_length": RESUME_TAILORING_PROMPT_MAX_LENGTH,
            "cover_letter_prompt_mode": cover_letter_prompt_mode,
            "cover_letter_prompt_instructions": effective_cover_letter_instructions,
            "cover_letter_prompt_instructions_custom": stored_custom_cover_letter_prompt,
            "default_cover_letter_prompt_instructions": COVER_LETTER_INSTRUCTIONS.strip(),
            "cover_letter_prompt_max_length": COVER_LETTER_PROMPT_MAX_LENGTH,
            **template_status_payload(user),
            **cover_letter_template_status_payload(user),
        }

    async def update_user_settings(
        self,
        user_id: str,
        *,
        openai_key_mode: str | None = None,
        openai_api_key: str | None = None,
        clear_openai_api_key: bool = False,
        llm_provider: str | None = None,
        anthropic_key_mode: str | None = None,
        anthropic_api_key: str | None = None,
        clear_anthropic_api_key: bool = False,
        gemini_key_mode: str | None = None,
        gemini_api_key: str | None = None,
        clear_gemini_api_key: bool = False,
        dedup_recycle_mode: str | None = None,
        dedup_recycle_days: int | None = None,
        min_match_score_mode: str | None = None,
        min_match_score: int | None = None,
        resume_tailoring_prompt_mode: str | None = None,
        resume_tailoring_prompt_custom: str | None = None,
        cover_letter_prompt_mode: str | None = None,
        cover_letter_prompt_custom: str | None = None,
    ) -> dict | None:
        user = await self.get_by_id(user_id)
        if not user:
            return None

        if openai_key_mode is not None:
            if openai_key_mode not in ("default", "custom"):
                raise ValueError("openai_key_mode must be 'default' or 'custom'")
            user.openai_key_mode = openai_key_mode
            if openai_key_mode == "default":
                user.openai_api_key_encrypted = None

        if clear_openai_api_key:
            user.openai_api_key_encrypted = None

        if openai_api_key is not None:
            key = openai_api_key.strip()
            if len(key) < 20:
                raise ValueError("OpenAI API key looks too short")
            user.openai_api_key_encrypted = encrypt_secret(key)
            user.openai_key_mode = "custom"

        if llm_provider is not None:
            normalized = llm_provider.strip().lower()
            if normalized not in self.LLM_PROVIDERS:
                raise ValueError("llm_provider must be 'openai', 'anthropic', or 'gemini'")
            user.llm_provider = normalized

        self._apply_provider_key_update(
            user,
            "anthropic",
            mode=anthropic_key_mode,
            api_key=anthropic_api_key,
            clear=clear_anthropic_api_key,
        )
        self._apply_provider_key_update(
            user,
            "gemini",
            mode=gemini_key_mode,
            api_key=gemini_api_key,
            clear=clear_gemini_api_key,
        )

        if dedup_recycle_mode is not None:
            if dedup_recycle_mode not in ("default", "custom"):
                raise ValueError("dedup_recycle_mode must be 'default' or 'custom'")
            user.dedup_recycle_mode = dedup_recycle_mode

        if dedup_recycle_days is not None:
            user.dedup_recycle_days = self._clamp_dedup_days(dedup_recycle_days)
            user.dedup_recycle_mode = "custom"

        if min_match_score_mode is not None:
            if min_match_score_mode not in ("default", "custom"):
                raise ValueError("min_match_score_mode must be 'default' or 'custom'")
            user.min_match_score_mode = min_match_score_mode

        if min_match_score is not None:
            user.min_match_score = self._clamp_min_match_score(min_match_score)
            user.min_match_score_mode = "custom"

        if resume_tailoring_prompt_mode is not None:
            if resume_tailoring_prompt_mode not in ("default", "custom"):
                raise ValueError("resume_tailoring_prompt_mode must be 'default' or 'custom'")
            user.resume_tailoring_prompt_mode = resume_tailoring_prompt_mode

        if resume_tailoring_prompt_custom is not None:
            validated = self._validate_resume_tailoring_instructions(resume_tailoring_prompt_custom)
            user.resume_tailoring_prompt_custom = validated
            user.resume_tailoring_prompt_mode = "custom"

        if cover_letter_prompt_mode is not None:
            if cover_letter_prompt_mode not in ("default", "custom"):
                raise ValueError("cover_letter_prompt_mode must be 'default' or 'custom'")
            user.cover_letter_prompt_mode = cover_letter_prompt_mode

        if cover_letter_prompt_custom is not None:
            validated = self._validate_cover_letter_instructions(cover_letter_prompt_custom)
            user.cover_letter_prompt_custom = validated
            user.cover_letter_prompt_mode = "custom"

        await self.session.flush()
        logger.info("user_settings_updated", user_id=user_id)
        return await self.get_user_settings(user_id)

    async def resolve_openai_api_key(self, user_id: str) -> str:
        """Return API key for OpenAI calls for this user."""
        settings = get_settings()
        user = await self.get_by_id(user_id)
        mode = (getattr(user, "openai_key_mode", None) or "default") if user else "default"

        if mode == "custom" and user and user.openai_api_key_encrypted:
            return decrypt_secret(user.openai_api_key_encrypted)

        if not settings.openai_api_key:
            raise AIParsingError(
                "OpenAI API key not configured. Add your key in Settings or contact the administrator."
            )
        return settings.openai_api_key

    # ── Multi-provider LLM key resolution ─────────────────────────────────

    LLM_PROVIDERS = ("openai", "anthropic", "gemini")

    @staticmethod
    def _provider_mode_attr(provider: str) -> str:
        return f"{provider}_key_mode"

    @staticmethod
    def _provider_key_attr(provider: str) -> str:
        return f"{provider}_api_key_encrypted"

    @staticmethod
    def _system_key_for_provider(provider: str) -> str:
        settings = get_settings()
        return {
            "openai": settings.openai_api_key,
            "anthropic": settings.anthropic_api_key,
            "gemini": settings.gemini_api_key,
        }.get(provider, "") or ""

    async def resolve_llm_provider(self, user_id: str) -> str:
        """Return the user's selected LLM provider (defaults to server default)."""
        settings = get_settings()
        user = await self.get_by_id(user_id)
        provider = (getattr(user, "llm_provider", None) or "").strip().lower() if user else ""
        if provider in self.LLM_PROVIDERS:
            return provider
        return settings.default_llm_provider

    async def resolve_provider_api_key(self, user_id: str, provider: str) -> str:
        """Return the usable API key for ``provider`` (custom user key or server key).

        Returns "" when no key is available — never raises — so the multi-provider
        client can simply skip unconfigured providers.
        """
        provider = (provider or "").strip().lower()
        if provider not in self.LLM_PROVIDERS:
            return ""
        user = await self.get_by_id(user_id)
        mode = (getattr(user, self._provider_mode_attr(provider), None) or "default") if user else "default"
        if mode == "custom" and user:
            encrypted = getattr(user, self._provider_key_attr(provider), None)
            if encrypted:
                try:
                    return decrypt_secret(encrypted)
                except ValueError:
                    return ""
        return self._system_key_for_provider(provider)

    def _provider_key_info(self, user: User | None, provider: str) -> dict:
        """Return UI-facing key metadata for a provider (mode/configured/hint/system)."""
        mode = (getattr(user, self._provider_mode_attr(provider), None) or "default") if user else "default"
        encrypted = getattr(user, self._provider_key_attr(provider), None) if user else None
        has_custom_key = bool(encrypted)
        key_hint: str | None = None
        if mode == "custom" and has_custom_key:
            try:
                key_hint = mask_api_key(decrypt_secret(encrypted))
            except ValueError:
                key_hint = "••••••••"
        return {
            f"{provider}_key_mode": mode,
            f"{provider}_key_configured": has_custom_key,
            f"{provider}_key_hint": key_hint,
            f"system_{provider}_available": bool(self._system_key_for_provider(provider)),
        }

    def _available_providers(self, user: User | None) -> list[str]:
        """Providers with a usable key (custom user key or configured server key)."""
        available: list[str] = []
        for provider in self.LLM_PROVIDERS:
            info = self._provider_key_info(user, provider)
            if info[f"{provider}_key_configured"] or info[f"system_{provider}_available"]:
                available.append(provider)
        return available

    def _apply_provider_key_update(
        self,
        user: User,
        provider: str,
        *,
        mode: str | None,
        api_key: str | None,
        clear: bool,
    ) -> None:
        mode_attr = self._provider_mode_attr(provider)
        key_attr = self._provider_key_attr(provider)
        if mode is not None:
            if mode not in ("default", "custom"):
                raise ValueError(f"{provider}_key_mode must be 'default' or 'custom'")
            setattr(user, mode_attr, mode)
            if mode == "default":
                setattr(user, key_attr, None)
        if clear:
            setattr(user, key_attr, None)
        if api_key is not None:
            key = api_key.strip()
            if len(key) < 20:
                raise ValueError(f"{provider.capitalize()} API key looks too short")
            setattr(user, key_attr, encrypt_secret(key))
            setattr(user, mode_attr, "custom")
