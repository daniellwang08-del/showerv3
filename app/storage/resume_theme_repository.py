from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.database import ResumeCustomTheme, ResumeThemeLove


class ResumeThemeRepository:
    """CRUD for user-saved resume themes and love markers."""

    def __init__(self, session: AsyncSession):
        self.session = session

    async def list_custom(self, user_id: str) -> list[ResumeCustomTheme]:
        stmt = (
            select(ResumeCustomTheme)
            .where(ResumeCustomTheme.user_id == user_id)
            .order_by(ResumeCustomTheme.updated_at.desc())
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def get_custom(self, theme_id: str, user_id: str) -> ResumeCustomTheme | None:
        stmt = select(ResumeCustomTheme).where(
            ResumeCustomTheme.id == theme_id,
            ResumeCustomTheme.user_id == user_id,
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def create_custom(self, **kwargs) -> ResumeCustomTheme:
        row = ResumeCustomTheme(**kwargs)
        self.session.add(row)
        await self.session.flush()
        return row

    async def delete_custom(self, row: ResumeCustomTheme) -> None:
        await self.session.delete(row)
        await self.session.flush()

    async def list_loved_ids(self, user_id: str) -> set[str]:
        stmt = select(ResumeThemeLove.theme_id).where(ResumeThemeLove.user_id == user_id)
        result = await self.session.execute(stmt)
        return {str(tid) for tid in result.scalars().all()}

    async def is_loved(self, user_id: str, theme_id: str) -> bool:
        stmt = select(ResumeThemeLove).where(
            ResumeThemeLove.user_id == user_id,
            ResumeThemeLove.theme_id == theme_id,
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def set_loved(self, user_id: str, theme_id: str, loved: bool) -> bool:
        if loved:
            if not await self.is_loved(user_id, theme_id):
                self.session.add(ResumeThemeLove(user_id=user_id, theme_id=theme_id))
                await self.session.flush()
            return True
        await self.session.execute(
            delete(ResumeThemeLove).where(
                ResumeThemeLove.user_id == user_id,
                ResumeThemeLove.theme_id == theme_id,
            )
        )
        await self.session.flush()
        return False
