from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.models.database import User
from app.services.auth_service import AuthService
from app.utils.profile_converter import user_profile_to_openai_text
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

    async def update_profile(self, user_id: str, data: dict) -> User | None:
        """Update user's single profile (stored on User model)."""
        user = await self.get_by_id(user_id)
        if not user:
            return None
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
        user.profile_openai_cache = user_profile_to_openai_text(user)
        await self.session.flush()
        logger.info("profile_updated", user_id=user_id)
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
