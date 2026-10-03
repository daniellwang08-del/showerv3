from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import undefer

from app.models.database import ProfileSourceDocument


class ProfileSourceDocumentRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def list_for_user(self, user_id: str) -> list[ProfileSourceDocument]:
        """Metadata list, extracted_text/structured_data stay deferred."""
        stmt = (
            select(ProfileSourceDocument)
            .where(ProfileSourceDocument.user_id == user_id)
            .order_by(ProfileSourceDocument.created_at.desc())
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def list_completed_for_user(self, user_id: str) -> list[ProfileSourceDocument]:
        """Evidence/Phase B path, needs text + structured blobs."""
        stmt = (
            select(ProfileSourceDocument)
            .options(
                undefer(ProfileSourceDocument.extracted_text),
                undefer(ProfileSourceDocument.structured_data),
            )
            .where(
                ProfileSourceDocument.user_id == user_id,
                ProfileSourceDocument.parse_status == "completed",
            )
            .order_by(ProfileSourceDocument.created_at.desc())
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def get_by_id(self, doc_id: str, user_id: str) -> ProfileSourceDocument | None:
        stmt = (
            select(ProfileSourceDocument)
            .options(
                undefer(ProfileSourceDocument.extracted_text),
                undefer(ProfileSourceDocument.structured_data),
            )
            .where(
                ProfileSourceDocument.id == doc_id,
                ProfileSourceDocument.user_id == user_id,
            )
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def create(self, **kwargs) -> ProfileSourceDocument:
        row = ProfileSourceDocument(**kwargs)
        self.session.add(row)
        await self.session.flush()
        return row

    async def delete(self, doc: ProfileSourceDocument) -> None:
        await self.session.delete(doc)
        await self.session.flush()
