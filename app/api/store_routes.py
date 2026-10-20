"""Package store, credit balance, and admin grants."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.api.routes import get_current_user, require_admin, require_applicant
from app.models.database import User
from app.services import store_service
from app.storage.database import get_session

router = APIRouter(prefix="/store", tags=["store"])
_applicant = [Depends(require_applicant)]
_admin = [Depends(require_admin)]


class GiftRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=255)


class GrantRequest(BaseModel):
    code: str = Field(..., max_length=20)
    quantity: int = Field(default=1, ge=1, le=store_service.MAX_GRANT_QUANTITY)


class AdjustRequest(BaseModel):
    delta: int = Field(..., ge=-1_000_000, le=1_000_000)
    note: str | None = Field(default=None, max_length=300)


def _bad_request(e: store_service.StoreError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Package not found")


async def _me(session, current_user: dict) -> User:
    user = await session.get(User, current_user["user_id"])
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return user


@router.get("", dependencies=_applicant)
async def get_store(current_user: dict = Depends(get_current_user)):
    async with get_session() as session:
        data = await store_service.store(session, await _me(session, current_user))
        await session.commit()
    return data


@router.get("/ledger", dependencies=_applicant)
async def get_ledger(
    limit: int = Query(store_service.LEDGER_PAGE, ge=1, le=200),
    current_user: dict = Depends(get_current_user),
):
    async with get_session() as session:
        return {
            "balance": await store_service.balance_of(session, current_user["user_id"]),
            "entries": await store_service.ledger(session, current_user["user_id"], limit=limit),
        }


@router.post("/packages/{package_id}/redeem", dependencies=_applicant)
async def redeem_package(package_id: str, current_user: dict = Depends(get_current_user)):
    async with get_session() as session:
        try:
            data = await store_service.redeem_credits(session, await _me(session, current_user), package_id)
        except store_service.StoreError as e:
            raise _bad_request(e) from e
        except store_service.StoreNotFound as e:
            raise _not_found() from e
        await session.commit()
    return data


@router.post("/packages/{package_id}/gift", dependencies=_applicant)
async def gift_package(package_id: str, body: GiftRequest, current_user: dict = Depends(get_current_user)):
    async with get_session() as session:
        try:
            data = await store_service.gift(session, await _me(session, current_user), package_id, body.email)
        except store_service.StoreError as e:
            raise _bad_request(e) from e
        except store_service.StoreNotFound as e:
            raise _not_found() from e
        await session.commit()
    return data


@router.post("/packages/{package_id}/cancel-gift", dependencies=_applicant)
async def cancel_gift(package_id: str, current_user: dict = Depends(get_current_user)):
    async with get_session() as session:
        try:
            data = await store_service.cancel_gift(session, await _me(session, current_user), package_id)
        except store_service.StoreError as e:
            raise _bad_request(e) from e
        except store_service.StoreNotFound as e:
            raise _not_found() from e
        await session.commit()
    return data


async def _target(session, user_id: str) -> User:
    user = await session.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return user


@router.get("/admin/users/{user_id}", dependencies=_admin)
async def admin_user_store(user_id: str):
    async with get_session() as session:
        return await store_service.admin_summary(session, await _target(session, user_id))


@router.post("/admin/users/{user_id}/grant", dependencies=_admin)
async def admin_grant(user_id: str, body: GrantRequest, current_user: dict = Depends(get_current_user)):
    async with get_session() as session:
        target = await _target(session, user_id)
        try:
            packages = await store_service.grant(session, current_user["user_id"], target, body.code, body.quantity)
        except store_service.StoreError as e:
            raise _bad_request(e) from e
        await session.commit()
        return {"packages": packages, "summary": await store_service.admin_summary(session, target)}


@router.post("/admin/users/{user_id}/adjust", dependencies=_admin)
async def admin_adjust(user_id: str, body: AdjustRequest, current_user: dict = Depends(get_current_user)):
    async with get_session() as session:
        target = await _target(session, user_id)
        try:
            await store_service.admin_adjust(session, current_user["user_id"], target, body.delta, body.note)
        except store_service.StoreError as e:
            raise _bad_request(e) from e
        await session.commit()
        await session.refresh(target)
        return await store_service.admin_summary(session, target)
