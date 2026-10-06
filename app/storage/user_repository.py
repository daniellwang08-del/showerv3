from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm import undefer
from app.models.database import User
from app.services.auth_service import AuthService
from app.core.config import get_settings
from app.prompts.cover_letter_prompt import (
    COVER_LETTER_INSTRUCTIONS,
    COVER_LETTER_PROMPT_MAX_LENGTH,
    COVER_LETTER_PROMPT_MIN_LENGTH,
)
from app.prompts.job_match_phase_a_prompt import JOB_MATCH_PREFERENCES_MAX_LENGTH
from app.prompts.job_match_phase_b_prompt import (
    JOB_MATCH_PHASE_B_OUTPUT_CONTRACT,
    RESUME_TAILORING_INSTRUCTIONS,
    RESUME_TAILORING_PROMPT_MAX_LENGTH,
    RESUME_TAILORING_PROMPT_MIN_LENGTH,
    build_cover_letter_system_prompt,
    build_phase_b_resume_system_prompt,
    build_phase_b_system_prompt,
)
from app.core.exceptions import AIParsingError
from app.utils.profile_converter import user_profile_to_openai_text
from app.utils.secret_encryption import decrypt_secret, encrypt_secret, mask_api_key
from app.services.resume_template_service import template_status_payload
from app.services.cover_letter_template_service import template_status_payload as cover_letter_template_status_payload
from app.services.job_pipeline_mode import normalize_application_resume_source
from app.services.match_quality_check import (
    normalize_min_score as normalize_quality_check_min_score,
    normalize_mode as normalize_quality_check_mode,
)
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
        """Get user by email (full row, deferred profile/secret columns included)."""
        stmt = (
            select(User)
            .options(undefer("*"))
            .where(User.email == email.lower().strip())
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def get_by_id(self, user_id: str) -> User | None:
        """Get user by ID (full row, deferred profile/secret columns included)."""
        stmt = select(User).options(undefer("*")).where(User.id == user_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def list_active_users(self, *, limit: int = 500) -> list[User]:
        """Return active, approved users ordered by email (for analysis multi-select)."""
        from app.services.signup_approval_service import can_use_app_clause

        stmt = (
            select(User)
            .where(can_use_app_clause())
            .order_by(User.email.asc())
            .limit(max(1, min(limit, 1000)))
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def list_all_users(self, *, limit: int = 2000) -> list[User]:
        """Return all users (active + inactive) ordered by email."""
        stmt = (
            select(User)
            .order_by(User.email.asc())
            .limit(max(1, min(limit, 5000)))
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def count_admins(self) -> int:
        """Count active admin users."""
        from sqlalchemy import func

        stmt = select(func.count()).select_from(User).where(
            User.is_admin.is_(True),
            User.is_active.is_(True),
        )
        result = await self.session.execute(stmt)
        return int(result.scalar_one() or 0)

    async def create(self, email: str, password: str) -> User:
        """Create a new user with hashed password.

        The first active admin slot is granted automatically so a fresh
        install can open System Settings / User Management without a
        manual SQL bootstrap. Everyone else starts "pending" until an admin
        approves the signup or the user redeems an admin-issued access key.
        """
        from app.services.signup_approval_service import (
            APPROVAL_APPROVED,
            APPROVAL_PENDING,
            utcnow,
        )

        email = email.lower().strip()
        password_hash = AuthService.hash_password(password)
        is_first_admin = (await self.count_admins()) == 0

        user = User(
            email=email,
            password_hash=password_hash,
            is_active=True,
            is_admin=is_first_admin,
            approval_status=APPROVAL_APPROVED if is_first_admin else APPROVAL_PENDING,
            approved_at=utcnow() if is_first_admin else None,
        )

        self.session.add(user)
        await self.session.flush()
        logger.info(
            "user_created",
            user_id=user.id,
            email=email,
            is_admin=is_first_admin,
            approval_status=user.approval_status,
        )
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

    async def activate(self, user_id: str) -> bool:
        """Re-activate a user"""
        user = await self.update_user(user_id, is_active=True)
        if user:
            logger.info("user_activated", user_id=user_id)
            return True
        return False

    async def set_password(self, user_id: str, password: str) -> bool:
        """Set a new password hash for the user."""
        password_hash = AuthService.hash_password(password)
        user = await self.update_user(user_id, password_hash=password_hash)
        if user:
            logger.info("user_password_reset", user_id=user_id)
            return True
        return False

    async def delete_user(self, user_id: str) -> bool:
        """Hard-delete a user row (cascades via FKs)."""
        user = await self.get_by_id(user_id)
        if not user:
            return False
        await self.session.delete(user)
        await self.session.flush()
        logger.info("user_deleted", user_id=user_id)
        return True

    async def update_profile(self, user_id: str, data: dict) -> tuple[User | None, bool]:
        """Update user's single profile (stored on User model).

        Returns (user, should_reanalyze_template).
        """
        user = await self.get_by_id(user_id)
        if not user:
            return None, False
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
        await self.session.flush()
        logger.info("profile_updated", user_id=user_id)
        # Second tuple element kept for caller compatibility (no template reanalysis anymore).
        return user, False

    async def update_eeo_preferences(self, user_id: str, eeo: dict) -> User | None:
        """Update only EEO / demographic answers, leave the rest of the profile alone."""
        user = await self.get_by_id(user_id)
        if not user:
            return None
        user.eeo_preferences = eeo or {}
        user.profile_openai_cache = user_profile_to_openai_text(user)
        await self.session.flush()
        logger.info("profile_eeo_updated", user_id=user_id)
        return user

    async def update_address(self, user_id: str, address: dict) -> User | None:
        """Update only legal address / location preferences."""
        user = await self.get_by_id(user_id)
        if not user:
            return None
        user.address = address or {}
        user.profile_openai_cache = user_profile_to_openai_text(user)
        await self.session.flush()
        logger.info("profile_address_updated", user_id=user_id)
        return user

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
        from app.services.system_settings_service import get_effective_value

        default_days = int(await get_effective_value("default_dedup_recycle_days", self.session))
        user = await self.get_by_id(user_id)
        if not user:
            return default_days
        mode = getattr(user, "dedup_recycle_mode", None) or "default"
        if mode == "custom":
            return self._clamp_dedup_days(getattr(user, "dedup_recycle_days", None), fallback=default_days)
        return default_days

    @staticmethod
    def _clamp_dedup_days(val: int | None, fallback: int | None = None) -> int:
        from app.services.system_settings_service import get_effective_value_sync

        if fallback is None:
            fallback = int(get_effective_value_sync("default_dedup_recycle_days"))
        if val is None:
            return fallback
        try:
            return max(1, min(3650, int(val)))
        except (TypeError, ValueError):
            return fallback

    @staticmethod
    def _clamp_min_match_score(val: int | None, fallback: int | None = None) -> int:
        from app.services.system_settings_service import get_effective_value_sync

        if fallback is None:
            fallback = int(get_effective_value_sync("default_min_match_score"))
        if val is None:
            return fallback
        try:
            return max(0, min(100, int(val)))
        except (TypeError, ValueError):
            return fallback

    async def get_effective_min_match_score(self, user_id: str) -> int:
        """Return minimum match score threshold (0 = show all)."""
        from app.services.system_settings_service import get_effective_value

        default_score = int(await get_effective_value("default_min_match_score", self.session))
        user = await self.get_by_id(user_id)
        if not user:
            return default_score
        mode = getattr(user, "min_match_score_mode", None) or "default"
        if mode == "custom":
            return self._clamp_min_match_score(getattr(user, "min_match_score", None), fallback=default_score)
        return default_score

    async def get_effective_dedup_applied_company_enabled(self, user_id: str) -> bool:
        """Return whether applied-company dedup is on for this user."""
        from app.services.system_settings_service import get_effective_value

        default_enabled = bool(
            await get_effective_value("dedup_rule_applied_company_enabled", self.session)
        )
        user = await self.get_by_id(user_id)
        if not user:
            return default_enabled
        mode = getattr(user, "dedup_applied_company_mode", None) or "default"
        if mode == "custom":
            return bool(getattr(user, "dedup_applied_company_enabled", False))
        return default_enabled

    async def get_effective_dedup_score_comparison_enabled(self, user_id: str) -> bool:
        """Return whether same-company score comparison is on for this user."""
        from app.services.system_settings_service import get_effective_value

        default_enabled = bool(
            await get_effective_value("dedup_rule_score_comparison_enabled", self.session)
        )
        user = await self.get_by_id(user_id)
        if not user:
            return default_enabled
        mode = getattr(user, "dedup_score_comparison_mode", None) or "default"
        if mode == "custom":
            return bool(getattr(user, "dedup_score_comparison_enabled", False))
        return default_enabled

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

    @staticmethod
    def _validate_job_match_preferences(text: str | None) -> str | None:
        if text is None:
            return None
        cleaned = text.strip()
        if not cleaned:
            return None
        if len(cleaned) > JOB_MATCH_PREFERENCES_MAX_LENGTH:
            raise ValueError(
                f"Job match preferences must be at most {JOB_MATCH_PREFERENCES_MAX_LENGTH:,} characters"
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

    async def get_effective_phase_b_system_prompts(self, user_id: str) -> tuple[str, str]:
        """Return (resume system prompt, cover letter system prompt) for separate calls."""
        user = await self.get_by_id(user_id)
        return (
            build_phase_b_resume_system_prompt(self._resume_tailoring_instructions_for_user(user)),
            build_cover_letter_system_prompt(self._cover_letter_instructions_for_user(user)),
        )

    async def get_effective_resume_tailoring_instructions(self, user_id: str) -> str:
        user = await self.get_by_id(user_id)
        return self._resume_tailoring_instructions_for_user(user)

    async def get_effective_cover_letter_instructions(self, user_id: str) -> str:
        user = await self.get_by_id(user_id)
        return self._cover_letter_instructions_for_user(user)

    async def get_country_preferences(self, user_id: str) -> list[str]:
        """Preferred job countries (ISO codes). Empty list = no location filter."""
        user = await self.get_by_id(user_id)
        if not user:
            return []
        raw = getattr(user, "country_preferences", None)
        if not isinstance(raw, list):
            return []
        return [str(c).strip().upper() for c in raw if str(c).strip()]

    async def update_country_preferences(
        self,
        user_id: str,
        countries: list[str],
        *,
        source: str = "manual",
    ) -> list[str] | None:
        """Set the preferred-country list. Returns the stored codes or None."""
        from app.services.country_catalog import normalize_country_preferences

        if source not in ("unset", "auto", "manual"):
            raise ValueError("source must be 'unset', 'auto', or 'manual'")
        user = await self.get_by_id(user_id)
        if not user:
            return None
        cleaned = normalize_country_preferences(countries)
        user.country_preferences = cleaned
        user.country_preferences_source = source
        await self.session.flush()
        logger.info(
            "country_preferences_updated",
            user_id=user_id,
            countries=cleaned,
            source=source,
        )
        return cleaned

    async def autoset_country_preferences_from_resume(
        self,
        user_id: str,
        detected: list[str],
    ) -> list[str] | None:
        """Apply resume-detected countries unless the user set theirs manually.

        Returns the stored list when applied, else None (manual prefs kept or
        nothing detected).
        """
        if not detected:
            return None
        user = await self.get_by_id(user_id)
        if not user:
            return None
        source = getattr(user, "country_preferences_source", None) or "unset"
        if source == "manual":
            return None
        return await self.update_country_preferences(user_id, detected, source="auto")

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
        from app.services.system_settings_service import get_effective_value

        settings = get_settings()
        default_dedup = int(await get_effective_value("default_dedup_recycle_days", self.session))
        default_min_score = int(await get_effective_value("default_min_match_score", self.session))
        mode = getattr(user, "openai_key_mode", None) or "default"
        dedup_mode = getattr(user, "dedup_recycle_mode", None) or "default"
        custom_days = self._clamp_dedup_days(
            getattr(user, "dedup_recycle_days", None), fallback=default_dedup
        )
        has_custom_key = bool(getattr(user, "openai_api_key_encrypted", None))
        key_hint: str | None = None
        if mode == "custom" and has_custom_key:
            try:
                plain = decrypt_secret(user.openai_api_key_encrypted)
                key_hint = mask_api_key(plain)
            except ValueError:
                key_hint = "••••••••"

        effective_days = custom_days if dedup_mode == "custom" else default_dedup
        min_score_mode = getattr(user, "min_match_score_mode", None) or "default"
        custom_min_score = self._clamp_min_match_score(
            getattr(user, "min_match_score", None), fallback=default_min_score
        )
        effective_min_score = (
            custom_min_score if min_score_mode == "custom" else default_min_score
        )
        applied_mode = getattr(user, "dedup_applied_company_mode", None) or "default"
        default_applied = bool(
            await get_effective_value("dedup_rule_applied_company_enabled", self.session)
        )
        custom_applied = bool(getattr(user, "dedup_applied_company_enabled", False))
        effective_applied = custom_applied if applied_mode == "custom" else default_applied
        score_cmp_mode = getattr(user, "dedup_score_comparison_mode", None) or "default"
        default_score_cmp = bool(
            await get_effective_value("dedup_rule_score_comparison_enabled", self.session)
        )
        custom_score_cmp = bool(getattr(user, "dedup_score_comparison_enabled", False))
        effective_score_cmp = (
            custom_score_cmp if score_cmp_mode == "custom" else default_score_cmp
        )
        prompt_mode = getattr(user, "resume_tailoring_prompt_mode", None) or "default"
        stored_custom_prompt = (getattr(user, "resume_tailoring_prompt_custom", None) or "").strip()
        effective_instructions = self._resume_tailoring_instructions_for_user(user)
        cover_letter_prompt_mode = getattr(user, "cover_letter_prompt_mode", None) or "default"
        stored_custom_cover_letter_prompt = (getattr(user, "cover_letter_prompt_custom", None) or "").strip()
        effective_cover_letter_instructions = self._cover_letter_instructions_for_user(user)
        default_provider = str(
            await get_effective_value("default_llm_provider", self.session)
        )
        active_provider = (getattr(user, "llm_provider", None) or "").strip().lower()
        if active_provider not in self.LLM_PROVIDERS:
            active_provider = default_provider
        default_openai_model = str(await get_effective_value("openai_model", self.session))
        user_llm_model = (getattr(user, "llm_model", None) or "").strip() or None
        return {
            "openai_key_mode": mode,
            "openai_key_configured": has_custom_key,
            "openai_key_hint": key_hint,
            "system_openai_available": bool(settings.openai_api_key),
            "llm_provider": active_provider,
            "default_llm_provider": default_provider,
            "available_providers": self._available_providers(user),
            "llm_model": user_llm_model,
            "default_llm_model": default_openai_model,
            **self._provider_key_info(user, "anthropic"),
            **self._provider_key_info(user, "gemini"),
            "dedup_recycle_mode": dedup_mode,
            "dedup_recycle_days": effective_days,
            "dedup_recycle_days_custom": custom_days,
            "default_dedup_recycle_days": default_dedup,
            "min_match_score_mode": min_score_mode,
            "min_match_score": effective_min_score,
            "min_match_score_custom": custom_min_score,
            "default_min_match_score": default_min_score,
            "dedup_applied_company_mode": applied_mode,
            "dedup_applied_company_enabled": effective_applied,
            "dedup_applied_company_enabled_custom": custom_applied,
            "default_dedup_applied_company_enabled": default_applied,
            "dedup_score_comparison_mode": score_cmp_mode,
            "dedup_score_comparison_enabled": effective_score_cmp,
            "dedup_score_comparison_enabled_custom": custom_score_cmp,
            "default_dedup_score_comparison_enabled": default_score_cmp,
            "auto_prepare_match": bool(getattr(user, "auto_prepare_match", False)),
            "auto_prepare_full": bool(getattr(user, "auto_prepare_full", False)),
            "application_resume_source": normalize_application_resume_source(
                getattr(user, "application_resume_source", None)
            ),
            "match_quality_check": normalize_quality_check_mode(getattr(user, "match_quality_check", None)),
            "match_quality_check_min_score": normalize_quality_check_min_score(
                getattr(user, "match_quality_check_min_score", None)
            ),
            "manual_submit_pipeline": (
                str(getattr(user, "manual_submit_pipeline", None) or "full").strip().lower()
                if str(getattr(user, "manual_submit_pipeline", None) or "full").strip().lower()
                in ("extract", "match", "full")
                else "full"
            ),
            "job_share_default": (
                str(getattr(user, "job_share_default", None) or "private").strip().lower()
                if str(getattr(user, "job_share_default", None) or "private").strip().lower()
                in ("private", "team", "all", "ask")
                else "private"
            ),
            "resume_filename_mode": (
                "static"
                if str(getattr(user, "resume_filename_mode", None) or "pattern").strip().lower()
                == "static"
                else "pattern"
            ),
            "resume_filename_value": (
                str(getattr(user, "resume_filename_value", None) or "{firstname}_{lastname}_{kind}").strip()
                or "{firstname}_{lastname}_{kind}"
            ),
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
            "job_match_preferences": (getattr(user, "job_match_preferences", None) or "").strip(),
            "job_match_preferences_max_length": JOB_MATCH_PREFERENCES_MAX_LENGTH,
            "country_preferences": [
                str(c).strip().upper()
                for c in (getattr(user, "country_preferences", None) or [])
                if str(c).strip()
            ],
            "country_preferences_source": (
                getattr(user, "country_preferences_source", None) or "unset"
            ),
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
        llm_model: str | None = None,
        clear_llm_model: bool = False,
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
        dedup_applied_company_mode: str | None = None,
        dedup_applied_company_enabled: bool | None = None,
        dedup_score_comparison_mode: str | None = None,
        dedup_score_comparison_enabled: bool | None = None,
        auto_prepare_match: bool | None = None,
        auto_prepare_full: bool | None = None,
        application_resume_source: str | None = None,
        match_quality_check: str | None = None,
        match_quality_check_min_score: int | None = None,
        manual_submit_pipeline: str | None = None,
        job_share_default: str | None = None,
        resume_filename_mode: str | None = None,
        resume_filename_value: str | None = None,
        resume_tailoring_prompt_mode: str | None = None,
        resume_tailoring_prompt_custom: str | None = None,
        cover_letter_prompt_mode: str | None = None,
        cover_letter_prompt_custom: str | None = None,
        job_match_preferences: str | None = None,
        clear_job_match_preferences: bool = False,
        country_preferences: list[str] | None = None,
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

        if clear_llm_model:
            user.llm_model = None
        elif llm_model is not None:
            cleaned = llm_model.strip()
            if not cleaned:
                user.llm_model = None
            elif len(cleaned) > 200:
                raise ValueError("llm_model is too long")
            else:
                user.llm_model = cleaned
                # Gateway models are invoked via the OpenAI-compatible adapter.
                user.llm_provider = "openai"

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

        if dedup_applied_company_mode is not None:
            if dedup_applied_company_mode not in ("default", "custom"):
                raise ValueError("dedup_applied_company_mode must be 'default' or 'custom'")
            user.dedup_applied_company_mode = dedup_applied_company_mode

        if dedup_applied_company_enabled is not None:
            user.dedup_applied_company_enabled = bool(dedup_applied_company_enabled)
            if dedup_applied_company_mode is None:
                user.dedup_applied_company_mode = "custom"

        if dedup_score_comparison_mode is not None:
            if dedup_score_comparison_mode not in ("default", "custom"):
                raise ValueError("dedup_score_comparison_mode must be 'default' or 'custom'")
            user.dedup_score_comparison_mode = dedup_score_comparison_mode

        if dedup_score_comparison_enabled is not None:
            user.dedup_score_comparison_enabled = bool(dedup_score_comparison_enabled)
            if dedup_score_comparison_mode is None:
                user.dedup_score_comparison_mode = "custom"

        if application_resume_source is not None:
            source = str(application_resume_source).strip().lower()
            if source not in ("original", "tailored"):
                raise ValueError("application_resume_source must be 'original' or 'tailored'")
            user.application_resume_source = source

        if match_quality_check is not None:
            mode = str(match_quality_check).strip().lower()
            if mode not in ("off", "rescore", "auto"):
                raise ValueError("match_quality_check must be 'off', 'rescore', or 'auto'")
            user.match_quality_check = mode

        if match_quality_check_min_score is not None:
            user.match_quality_check_min_score = normalize_quality_check_min_score(match_quality_check_min_score)

        if auto_prepare_match is not None:
            user.auto_prepare_match = bool(auto_prepare_match)
            if not user.auto_prepare_match:
                # Match off forces full off.
                user.auto_prepare_full = False

        if auto_prepare_full is not None:
            user.auto_prepare_full = bool(auto_prepare_full)
            if user.auto_prepare_full:
                # Full implies match.
                user.auto_prepare_match = True

        if normalize_application_resume_source(getattr(user, "application_resume_source", None)) == "original":
            # Original résumé mode never writes tailored documents in the background.
            user.auto_prepare_full = False

        if manual_submit_pipeline is not None:
            mode = str(manual_submit_pipeline).strip().lower()
            if mode not in ("extract", "match", "full"):
                raise ValueError("manual_submit_pipeline must be 'extract', 'match', or 'full'")
            user.manual_submit_pipeline = mode

        if job_share_default is not None:
            share = str(job_share_default).strip().lower()
            if share not in ("private", "team", "all", "ask"):
                raise ValueError("job_share_default must be 'private', 'team', 'all', or 'ask'")
            user.job_share_default = share

        if resume_filename_mode is not None or resume_filename_value is not None:
            from app.services.resume_filename import normalize_filename_mode, normalize_filename_value

            mode = normalize_filename_mode(
                resume_filename_mode
                if resume_filename_mode is not None
                else getattr(user, "resume_filename_mode", None)
            )
            value = normalize_filename_value(
                mode,
                resume_filename_value
                if resume_filename_value is not None
                else getattr(user, "resume_filename_value", None),
            )
            user.resume_filename_mode = mode
            user.resume_filename_value = value

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

        if clear_job_match_preferences:
            user.job_match_preferences = None

        if job_match_preferences is not None:
            user.job_match_preferences = self._validate_job_match_preferences(job_match_preferences)

        if country_preferences is not None:
            from app.services.country_catalog import normalize_country_preferences

            user.country_preferences = normalize_country_preferences(country_preferences)
            user.country_preferences_source = "manual"

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
        from app.services.system_settings_service import get_effective_value

        user = await self.get_by_id(user_id)
        provider = (getattr(user, "llm_provider", None) or "").strip().lower() if user else ""
        if provider in self.LLM_PROVIDERS:
            return provider
        return str(await get_effective_value("default_llm_provider", self.session))

    async def resolve_provider_api_key(self, user_id: str, provider: str) -> str:
        """Return the usable API key for ``provider`` (custom user key or server key).

        Returns "" when no key is available - never raises - so the multi-provider
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
