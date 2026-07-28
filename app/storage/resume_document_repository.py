from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.database import ResumeDocument


def resume_search_ilike_pattern(raw: str) -> str:
    """Build an ILIKE pattern that treats user input literally (escaped wildcards)."""
    escaped = raw.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


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

    async def search_for_user(
        self,
        user_id: str,
        *,
        company: str | None = None,
        job_title: str | None = None,
        limit: int = 100,
    ) -> list[ResumeDocument]:
        """Search resumes by company and/or role (job_title).

        Matching is case-insensitive substring (ILIKE). When both terms are
        provided, rows must match **both** (AND). Empty terms are ignored; if
        both are empty, returns an empty list.
        """
        company_q = (company or "").strip()
        role_q = (job_title or "").strip()
        if not company_q and not role_q:
            return []

        groups = []
        if company_q:
            pattern = resume_search_ilike_pattern(company_q)
            # Company column, or display name for older/manual rows.
            groups.append(
                or_(
                    ResumeDocument.company.ilike(pattern, escape="\\"),
                    ResumeDocument.name.ilike(pattern, escape="\\"),
                )
            )
        if role_q:
            pattern = resume_search_ilike_pattern(role_q)
            groups.append(
                or_(
                    ResumeDocument.job_title.ilike(pattern, escape="\\"),
                    ResumeDocument.name.ilike(pattern, escape="\\"),
                )
            )

        stmt = (
            select(ResumeDocument)
            .where(ResumeDocument.user_id == user_id, and_(*groups))
            .order_by(ResumeDocument.updated_at.desc())
            .limit(max(1, min(limit, 200)))
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
