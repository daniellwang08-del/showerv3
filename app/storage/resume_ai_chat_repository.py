"""Persistence for Resume Studio OneClick AI conversations (per resume)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import undefer

from app.models.database import ResumeAiChatSession, ResumeDocument

_MAX_MESSAGES = 80


def _utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class ResumeAiChatRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def get_owned_resume(self, user_id: str, resume_id: str) -> ResumeDocument | None:
        return (
            await self.session.execute(
                select(ResumeDocument)
                .options(
                    undefer(ResumeDocument.design),
                    undefer(ResumeDocument.job_description),
                    undefer(ResumeDocument.cover_letter),
                )
                .where(ResumeDocument.id == resume_id, ResumeDocument.user_id == user_id)
            )
        ).scalar_one_or_none()

    async def get_session(self, user_id: str, resume_id: str) -> ResumeAiChatSession | None:
        return (
            await self.session.execute(
                select(ResumeAiChatSession).where(
                    ResumeAiChatSession.user_id == user_id,
                    ResumeAiChatSession.resume_id == resume_id,
                )
            )
        ).scalar_one_or_none()

    async def upsert_messages(
        self,
        user_id: str,
        resume_id: str,
        messages: list[dict[str, Any]],
        last_job_description: str | None,
    ) -> ResumeAiChatSession:
        row = await self.get_session(user_id, resume_id)
        trimmed = messages[-_MAX_MESSAGES:]
        if row is None:
            row = ResumeAiChatSession(
                id=str(uuid4()),
                user_id=user_id,
                resume_id=resume_id,
                messages=trimmed,
                last_job_description=last_job_description,
            )
            self.session.add(row)
        else:
            row.messages = trimmed
            if last_job_description is not None:
                row.last_job_description = last_job_description
            row.updated_at = _utc_now()
        await self.session.flush()
        return row

    async def clear(self, user_id: str, resume_id: str) -> None:
        row = await self.get_session(user_id, resume_id)
        if row is None:
            return
        row.messages = []
        row.last_job_description = None
        row.updated_at = _utc_now()
        await self.session.flush()
