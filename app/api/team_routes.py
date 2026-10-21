"""Team spaces: create from a TEAM package, invite, manage sharing, monitor members."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.api.routes import get_current_user, require_applicant
from app.models.database import User
from app.services import team_service
from app.storage.database import get_session

router = APIRouter(prefix="/teams", tags=["teams"], dependencies=[Depends(require_applicant)])


class CreateSpaceRequest(BaseModel):
    package_id: str = Field(..., max_length=36)
    name: str = Field(..., max_length=200)


class UpdateSpaceRequest(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    default_share_scope: str | None = Field(default=None, pattern="^(private|team|all)?$")
    default_share_locked: bool | None = None


class InviteRequest(BaseModel):
    emails: list[str] = Field(..., min_length=1, max_length=team_service.MAX_INVITES_PER_REQUEST)


class MemberSharingRequest(BaseModel):
    share_default: str | None = Field(default=None, pattern="^(private|team|all)$")
    share_locked: bool | None = None


class InviteResponse(BaseModel):
    accept: bool


def _bad_request(e: team_service.TeamError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


def _not_found(detail: str = "Team space not found") -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)


async def _me(session, current_user: dict) -> User:
    user = await session.get(User, current_user["user_id"])
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return user


@router.get("")
async def team_overview(current_user: dict = Depends(get_current_user)):
    async with get_session() as session:
        return await team_service.overview(session, await _me(session, current_user))


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_space(body: CreateSpaceRequest, current_user: dict = Depends(get_current_user)):
    async with get_session() as session:
        try:
            space = await team_service.create_space(session, await _me(session, current_user), body.package_id, body.name)
        except team_service.TeamError as e:
            raise _bad_request(e) from e
        except team_service.TeamNotFound as e:
            raise _not_found("TEAM package not found") from e
        await session.commit()
    return space


@router.post("/{space_id}/leave")
async def leave_team(space_id: str, current_user: dict = Depends(get_current_user)):
    async with get_session() as session:
        try:
            await team_service.leave(session, await _me(session, current_user), space_id)
        except team_service.TeamNotFound as e:
            raise _not_found("You are not on this team") from e
        await session.commit()
    return {"success": True}


@router.post("/invites/{invite_id}/respond")
async def respond_invite(invite_id: str, body: InviteResponse, current_user: dict = Depends(get_current_user)):
    async with get_session() as session:
        try:
            data = await team_service.respond_invite(
                session, await _me(session, current_user), invite_id, accept=body.accept
            )
        except team_service.TeamError as e:
            raise _bad_request(e) from e
        except team_service.TeamNotFound as e:
            raise _not_found("This invitation is no longer open") from e
        await session.commit()
    return data


@router.get("/{space_id}")
async def space_detail(space_id: str, current_user: dict = Depends(get_current_user)):
    async with get_session() as session:
        try:
            return await team_service.space_detail(session, await _me(session, current_user), space_id)
        except team_service.TeamNotFound as e:
            raise _not_found() from e


@router.patch("/{space_id}")
async def update_space(space_id: str, body: UpdateSpaceRequest, current_user: dict = Depends(get_current_user)):
    async with get_session() as session:
        try:
            data = await team_service.update_space(
                session, await _me(session, current_user), space_id, body.model_dump(exclude_unset=True)
            )
        except team_service.TeamError as e:
            raise _bad_request(e) from e
        except team_service.TeamNotFound as e:
            raise _not_found() from e
        await session.commit()
    return data


@router.delete("/{space_id}")
async def delete_space(space_id: str, current_user: dict = Depends(get_current_user)):
    async with get_session() as session:
        try:
            await team_service.delete_space(session, await _me(session, current_user), space_id)
        except team_service.TeamNotFound as e:
            raise _not_found() from e
        await session.commit()
    return {"success": True}


@router.get("/{space_id}/activity")
async def space_activity(space_id: str, current_user: dict = Depends(get_current_user)):
    async with get_session() as session:
        try:
            return await team_service.activity_feed(session, await _me(session, current_user), space_id)
        except team_service.TeamNotFound as e:
            raise _not_found() from e


@router.get("/{space_id}/insights")
async def space_insights(
    space_id: str,
    days: int = Query(team_service.STATS_DAYS, ge=1, le=90),
    timezone_name: str | None = Query(None, alias="timezone", max_length=64),
    current_user: dict = Depends(get_current_user),
):
    async with get_session() as session:
        try:
            return await team_service.team_insights(
                session, await _me(session, current_user), space_id, days, timezone_name
            )
        except team_service.TeamNotFound as e:
            raise _not_found() from e


@router.post("/{space_id}/invites", status_code=status.HTTP_201_CREATED)
async def invite_members(space_id: str, body: InviteRequest, current_user: dict = Depends(get_current_user)):
    async with get_session() as session:
        try:
            data = await team_service.invite(session, await _me(session, current_user), space_id, body.emails)
        except team_service.TeamError as e:
            raise _bad_request(e) from e
        except team_service.TeamNotFound as e:
            raise _not_found() from e
        await session.commit()
    return data


@router.delete("/{space_id}/invites/{invite_id}")
async def revoke_invite(space_id: str, invite_id: str, current_user: dict = Depends(get_current_user)):
    async with get_session() as session:
        try:
            await team_service.revoke_invite(session, await _me(session, current_user), space_id, invite_id)
        except team_service.TeamNotFound as e:
            raise _not_found("Invitation not found") from e
        await session.commit()
    return {"success": True}


@router.patch("/{space_id}/members/{user_id}")
async def update_member(
    space_id: str, user_id: str, body: MemberSharingRequest, current_user: dict = Depends(get_current_user)
):
    async with get_session() as session:
        try:
            data = await team_service.update_member_sharing(
                session,
                await _me(session, current_user),
                space_id,
                user_id,
                share_default=body.share_default,
                share_locked=body.share_locked,
            )
        except team_service.TeamError as e:
            raise _bad_request(e) from e
        except team_service.TeamNotFound as e:
            raise _not_found("Member not found") from e
        await session.commit()
    return data


@router.delete("/{space_id}/members/{user_id}")
async def remove_member(space_id: str, user_id: str, current_user: dict = Depends(get_current_user)):
    async with get_session() as session:
        try:
            await team_service.remove_member(session, await _me(session, current_user), space_id, user_id)
        except team_service.TeamNotFound as e:
            raise _not_found("Member not found") from e
        await session.commit()
    return {"success": True}


@router.get("/{space_id}/members/{user_id}/report")
async def member_report(
    space_id: str,
    user_id: str,
    timezone_name: str | None = Query(None, alias="timezone", max_length=64),
    current_user: dict = Depends(get_current_user),
):
    async with get_session() as session:
        try:
            return await team_service.member_report(
                session, await _me(session, current_user), space_id, user_id, timezone_name
            )
        except team_service.TeamNotFound as e:
            raise _not_found("Member not found") from e
