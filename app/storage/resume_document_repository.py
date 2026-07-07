from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.database import ResumeDocument


class ResumeDocumentRepository:
    """CRUD for the per-user resume library (resume_documents)."""

    def __init__(self, session: AsyncSession):
        self.session = session

    async def list_for_user(self, user_id: str) -> list[ResumeDocument]:
        stmt = (
            select(ResumeDocument)
            .where(ResumeDocument.user_id == user_id)
            .order_by(ResumeDocument.updated_at.desc())
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def count_for_user(self, user_id: str) -> int:
        rows = await self.list_for_user(user_id)
        return len(rows)

    async def get_by_id(self, resume_id: str, user_id: str) -> ResumeDocument | None:
        stmt = select(ResumeDocument).where(
            ResumeDocument.id == resume_id,
            ResumeDocument.user_id == user_id,
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def create(self, **kwargs) -> ResumeDocument:
        row = ResumeDocument(**kwargs)
        self.session.add(row)
        await self.session.flush()
        return row

    async def delete(self, doc: ResumeDocument) -> None:
        await self.session.delete(doc)
        await self.session.flush()
