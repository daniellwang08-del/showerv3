"""Lets a team lead read a member's insights through the member's own endpoints."""

from __future__ import annotations

from fastapi import HTTPException, status

from app.services import team_service
from app.storage.database import get_session


async def insights_subject(viewer_id: str, member_id: str | None) -> str:
    """The user whose data to compute: the viewer, or a member of a space the viewer leads."""
    if not member_id or member_id == viewer_id:
        return viewer_id
    async with get_session() as session:
        allowed = await team_service.lead_can_view(session, viewer_id, member_id)
    if not allowed:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Team member not found")
    return member_id
