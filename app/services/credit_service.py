"""Spending credits on the work they pay for (the rules shown on the Plans page).

One credit prepares one job: the tailored resume and cover letter. A
preparation that fails gives the credit back, and preparing a job again once
it has content (or rebuilding its files) is free. Tailoring a resume for a
pasted job description in Documents, Resume studio, or the assistant also uses
one credit, returned when no tailored resume comes back. Admin accounts never
pay.
"""

from __future__ import annotations

import uuid

from sqlalchemy import func, select

from app.core.logging import get_logger
from app.models.database import CreditLedgerEntry, Job, ResumeBuildResult, User
from app.services.store_service import StoreError, add_credits
from app.storage.database import get_session

logger = get_logger(__name__)

PREPARE_COST = 1
TAILOR_COST = 1

JOB_PREPARE = "job_prepare"
JOB_PREPARE_REFUND = "job_prepare_refund"
TAILOR = "tailor"
TAILOR_REFUND = "tailor_refund"

NO_CREDITS_MESSAGE = "Out of credits. Add credits on the Plans page, then retry."
NO_CREDITS_TAILOR_MESSAGE = "You're out of credits. Add credits on the Plans page to tailor more resumes."


class OutOfCredits(Exception):
    """The user has no credits left for this work."""


def _has_content(row: ResumeBuildResult | None) -> bool:
    if row is None:
        return False
    cover = row.cover_letter_data
    return bool(row.tailored_resume_data) or (isinstance(cover, dict) and bool(cover.get("body")))


async def _job_label(session, job_id: str) -> str | None:
    row = (await session.execute(select(Job.title, Job.company).where(Job.id == job_id))).first()
    if row is None:
        return None
    title, company = (row[0] or "").strip(), (row[1] or "").strip()
    return f"{title} at {company}" if title and company else (title or company or None)


async def _preparation_is_free(session, job_id: str, user_id: str) -> bool:
    """Already prepared, or paid for and not refunded (a rerun or a run still going)."""
    build = (
        await session.execute(
            select(ResumeBuildResult).where(
                ResumeBuildResult.job_id == job_id, ResumeBuildResult.user_id == user_id
            )
        )
    ).scalar_one_or_none()
    if _has_content(build):
        return True
    paid = (
        await session.execute(
            select(func.coalesce(func.sum(CreditLedgerEntry.delta), 0)).where(
                CreditLedgerEntry.user_id == user_id,
                CreditLedgerEntry.ref_id == job_id,
                CreditLedgerEntry.reason.in_((JOB_PREPARE, JOB_PREPARE_REFUND)),
            )
        )
    ).scalar_one()
    return int(paid or 0) < 0


async def _payer(session, user_id: str) -> User | None:
    """The user row, locked so concurrent charges for one person run one at a time.

    None for admins and unknown users, who are never charged.
    """
    user = (
        await session.execute(select(User).where(User.id == user_id).with_for_update())
    ).scalar_one_or_none()
    return None if user is None or user.is_admin else user


async def can_prepare(job_id: str, user_id: str) -> bool:
    """Whether preparing this job now would go ahead (free, or the balance covers it)."""
    async with get_session() as session:
        user = await session.get(User, user_id)
        if user is None or user.is_admin or int(user.credit_balance or 0) >= PREPARE_COST:
            return True
        return await _preparation_is_free(session, job_id, user_id)


async def has_credits(user_id: str, cost: int = 1) -> bool:
    balance = await spendable_credits(user_id)
    return balance is None or balance >= cost


async def spendable_credits(user_id: str) -> int | None:
    """The balance, or None when this account is never charged."""
    async with get_session() as session:
        user = await session.get(User, user_id)
        if user is None or user.is_admin:
            return None
        return int(user.credit_balance or 0)


async def preparation_is_free(job_id: str, user_id: str) -> bool:
    async with get_session() as session:
        return await _preparation_is_free(session, job_id, user_id)


async def charge_job_preparation(job_id: str, user_id: str) -> bool:
    """Take one credit for preparing this job. True when charged, False when it is free.

    Raises OutOfCredits when the job needs a credit and the balance is empty.
    """
    async with get_session() as session:
        if await _payer(session, user_id) is None:
            return False
        if await _preparation_is_free(session, job_id, user_id):
            return False
        try:
            balance = await add_credits(
                session,
                user_id,
                -PREPARE_COST,
                reason=JOB_PREPARE,
                ref_id=job_id,
                note=await _job_label(session, job_id),
            )
        except StoreError as e:
            raise OutOfCredits() from e
    logger.info("credits_job_prepare_charged", job_id=job_id, user_id=user_id, balance=balance)
    return True


async def refund_job_preparation(job_id: str, user_id: str) -> None:
    """Give back the credit for a preparation that did not produce content."""
    async with get_session() as session:
        await _payer(session, user_id)
        balance = await add_credits(
            session,
            user_id,
            PREPARE_COST,
            reason=JOB_PREPARE_REFUND,
            ref_id=job_id,
            note=await _job_label(session, job_id),
        )
    logger.info("credits_job_prepare_refunded", job_id=job_id, user_id=user_id, balance=balance)


async def resume_auto_prepare(user_id: str) -> None:
    """After credits arrive, pick up the auto-preparation that paused without them."""
    async with get_session() as session:
        user = await session.get(User, user_id)
        if user is None or not user.auto_prepare_full:
            return
    from app.services.auto_prepare_service import backfill_auto_prepare_for_user

    try:
        await backfill_auto_prepare_for_user(user_id, match=True, full=True)
    except Exception as e:  # noqa: BLE001 - the top-up itself already succeeded
        logger.warning("credits_resume_auto_prepare_failed", user_id=user_id, error=str(e))


async def charge_tailoring(user_id: str, note: str | None = None) -> str | None:
    """Take one credit for tailoring a resume. Returns the charge id to refund, None when free.

    Raises OutOfCredits when the balance is empty.
    """
    charge_id = str(uuid.uuid4())
    async with get_session() as session:
        if await _payer(session, user_id) is None:
            return None
        try:
            balance = await add_credits(
                session, user_id, -TAILOR_COST, reason=TAILOR, ref_id=charge_id, note=note
            )
        except StoreError as e:
            raise OutOfCredits() from e
    logger.info("credits_tailor_charged", user_id=user_id, charge_id=charge_id, balance=balance)
    return charge_id


async def refund_tailoring(user_id: str, charge_id: str | None, note: str | None = None) -> None:
    if not charge_id:
        return
    async with get_session() as session:
        await _payer(session, user_id)
        balance = await add_credits(
            session, user_id, TAILOR_COST, reason=TAILOR_REFUND, ref_id=charge_id, note=note
        )
    logger.info("credits_tailor_refunded", user_id=user_id, charge_id=charge_id, balance=balance)
