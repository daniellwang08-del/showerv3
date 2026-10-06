"""Job-add history and share-based visibility.

Jobs a person adds (URL submit, assistant, their own company sources and
connected job sites) belong to them. An owned job is visible to its owner and
to whoever its add sessions grant; with no add session yet it stays private.
Scraped / admin inventory (no owner, no batch) stays visible to everyone,
subject to the usual dashboard filters.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Iterable

from sqlalchemy import and_, case, delete, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.models.database import (
    Job,
    JobAddBatch,
    JobAddBatchJob,
    JobAddBatchShareUser,
    User,
    UserJobStatus,
)

logger = get_logger(__name__)

SHARE_SCOPES = frozenset({"private", "team", "all", "users"})
SHARE_DEFAULTS = frozenset({"private", "team", "all", "ask"})
BATCH_SOURCES = frozenset({"manual", "paste", "attachment", "extension", "site"})
MAX_BATCH_JOBS = 2000
MAX_SHARE_USERS = 200

_TEAM_APPROVED = "approved"


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def normalize_share_scope(raw: Any, *, default: str = "private") -> str:
    value = str(raw or "").strip().lower()
    return value if value in SHARE_SCOPES else default


def normalize_share_default(raw: Any) -> str:
    value = str(raw or "").strip().lower()
    return value if value in SHARE_DEFAULTS else "private"


def normalize_batch_source(raw: Any) -> str:
    value = str(raw or "").strip().lower()
    return value if value in BATCH_SOURCES else "manual"


def initial_scope_from_default(raw: Any) -> str:
    """`ask` starts private. The toast can change it after the add."""
    pref = normalize_share_default(raw)
    return "private" if pref == "ask" else pref


def _unique_ids(values: Iterable[str], *, limit: int) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for raw in values:
        item = str(raw or "").strip()
        if not item or item in seen:
            continue
        seen.add(item)
        out.append(item)
        if len(out) >= limit:
            break
    return out


def display_name(user: User) -> str:
    name = (getattr(user, "name", None) or "").strip()
    if name:
        return name
    first = (getattr(user, "name_first", None) or "").strip()
    last = (getattr(user, "name_last", None) or "").strip()
    joined = " ".join(part for part in (first, last) if part)
    if joined:
        return joined
    return (getattr(user, "email", None) or "User").strip() or "User"


def job_owner_id(raw_metadata: Any) -> str | None:
    """Who added this job, or None for shared inventory (scraped, admin adds)."""
    meta = raw_metadata if isinstance(raw_metadata, dict) else {}
    if str(meta.get("submitted_by_admin") or "").strip().lower() != "true":
        owner = str(meta.get("submitted_by_user_id") or "").strip()
        if owner:
            return owner
    for key in ("user_job_source", "user_job_site"):
        block = meta.get(key)
        if isinstance(block, dict):
            owner = str(block.get("user_id") or "").strip()
            if owner:
                return owner
    return None


def job_owner_id_expr():
    """SQL twin of ``job_owner_id``."""
    meta = Job.raw_metadata
    admin_flag = meta["submitted_by_admin"].as_string()
    submitter = case(
        (or_(admin_flag.is_(None), admin_flag != "true"), func.nullif(meta["submitted_by_user_id"].as_string(), "")),
        else_=None,
    )
    return func.coalesce(
        submitter,
        func.nullif(meta[("user_job_source", "user_id")].as_string(), ""),
        func.nullif(meta[("user_job_site", "user_id")].as_string(), ""),
    )


def _viewer_is_team_clause(user_id: str):
    return exists(
        select(1).select_from(User).where(
            User.id == user_id,
            User.is_admin.is_(False),
            User.is_active.is_(True),
            User.approval_status == _TEAM_APPROVED,
        )
    )


def job_share_visibility_clause(user_id: str):
    """Owner always; otherwise a granting add session; unowned, unbatched inventory is public."""
    grant = or_(
        JobAddBatch.user_id == user_id,
        JobAddBatch.share_scope == "all",
        and_(JobAddBatch.share_scope == "team", _viewer_is_team_clause(user_id)),
        and_(
            JobAddBatch.share_scope == "users",
            exists(
                select(1).select_from(JobAddBatchShareUser).where(
                    JobAddBatchShareUser.batch_id == JobAddBatch.id,
                    JobAddBatchShareUser.user_id == user_id,
                )
            ),
        ),
    )
    in_granting_batch = exists(
        select(1)
        .select_from(JobAddBatchJob)
        .join(JobAddBatch, JobAddBatch.id == JobAddBatchJob.batch_id)
        .where(JobAddBatchJob.job_id == Job.id)
        .where(grant)
    )
    in_any_batch = exists(
        select(1).select_from(JobAddBatchJob).where(JobAddBatchJob.job_id == Job.id)
    )
    owner = job_owner_id_expr()
    return or_(
        owner == user_id,
        in_granting_batch,
        and_(~in_any_batch, owner.is_(None)),
    )


async def users_who_can_see_job(
    session: AsyncSession,
    job_id: str,
    user_ids: Iterable[str],
) -> set[str]:
    """Subset of ``user_ids`` that ``job_share_visibility_clause`` lets see the job.

    One pass over the job's batches instead of a per-user query, for fan-out.
    """
    candidates = {uid for uid in user_ids if uid}
    if not candidates:
        return set()
    meta = (await session.execute(select(Job.raw_metadata).where(Job.id == job_id))).scalar_one_or_none()
    owner = job_owner_id(meta)
    batches = (
        await session.execute(
            select(JobAddBatch.id, JobAddBatch.user_id, JobAddBatch.share_scope)
            .join(JobAddBatchJob, JobAddBatchJob.batch_id == JobAddBatch.id)
            .where(JobAddBatchJob.job_id == job_id)
        )
    ).all()
    visible: set[str] = {owner} & candidates if owner else set()
    if not batches:
        return visible if owner else candidates
    team_batch = False
    user_batch_ids: list[str] = []
    for batch_id, owner_id, scope in batches:
        if scope == "all":
            return candidates
        if owner_id in candidates:
            visible.add(owner_id)
        if scope == "team":
            team_batch = True
        elif scope == "users":
            user_batch_ids.append(batch_id)
    if team_batch:
        team = await session.execute(
            select(User.id).where(
                User.id.in_(candidates),
                User.is_admin.is_(False),
                User.is_active.is_(True),
                User.approval_status == _TEAM_APPROVED,
            )
        )
        visible.update(row[0] for row in team.all())
    if user_batch_ids:
        shared = await session.execute(
            select(JobAddBatchShareUser.user_id).where(
                JobAddBatchShareUser.batch_id.in_(user_batch_ids),
                JobAddBatchShareUser.user_id.in_(candidates),
            )
        )
        visible.update(row[0] for row in shared.all())
    return visible


async def batch_job_ids(session: AsyncSession, batch_id: str) -> list[str]:
    rows = await session.execute(select(JobAddBatchJob.job_id).where(JobAddBatchJob.batch_id == batch_id))
    return [row[0] for row in rows.all()]


def serialize_batch(
    batch: JobAddBatch,
    share_users: list[User] | None = None,
) -> dict[str, Any]:
    people = share_users or []
    created = batch.created_at
    updated = batch.updated_at
    return {
        "id": batch.id,
        "source": batch.source,
        "job_count": int(batch.job_count or 0),
        "share_scope": normalize_share_scope(batch.share_scope),
        "created_at": created.isoformat() if created else None,
        "updated_at": updated.isoformat() if updated else None,
        "share_users": [
            {
                "id": person.id,
                "name": display_name(person),
                "email": person.email,
            }
            for person in people
        ],
    }


async def _load_share_users(session: AsyncSession, batch_id: str) -> list[User]:
    result = await session.execute(
        select(User)
        .join(JobAddBatchShareUser, JobAddBatchShareUser.user_id == User.id)
        .where(JobAddBatchShareUser.batch_id == batch_id)
        .order_by(User.email)
    )
    return list(result.scalars().all())


async def _jobs_for_batch(session: AsyncSession, owner_id: str, job_ids: list[str]) -> list[str]:
    """Jobs in this user's own pool that someone added. Public inventory stays public."""
    if not job_ids:
        return []
    already_batched = select(JobAddBatchJob.job_id).where(JobAddBatchJob.job_id.in_(job_ids)).distinct()
    result = await session.execute(
        select(Job.id)
        .join(
            UserJobStatus,
            and_(
                UserJobStatus.job_id == Job.id,
                UserJobStatus.user_id == owner_id,
                UserJobStatus.status == "active",
            ),
        )
        .where(
            Job.id.in_(job_ids),
            Job.status == "active",
            or_(
                Job.id.in_(already_batched),
                job_owner_id_expr().is_not(None),
            ),
        )
    )
    found = {row[0] for row in result.all()}
    return [job_id for job_id in job_ids if job_id in found]


async def _replace_share_users(
    session: AsyncSession,
    batch_id: str,
    owner_id: str,
    user_ids: list[str],
) -> list[str]:
    await session.execute(delete(JobAddBatchShareUser).where(JobAddBatchShareUser.batch_id == batch_id))
    cleaned = [uid for uid in _unique_ids(user_ids, limit=MAX_SHARE_USERS) if uid != owner_id]
    if not cleaned:
        return []
    approved = await session.execute(
        select(User.id).where(
            User.id.in_(cleaned),
            User.is_active.is_(True),
            User.approval_status == _TEAM_APPROVED,
        )
    )
    allowed = {row[0] for row in approved.all()}
    kept = [uid for uid in cleaned if uid in allowed]
    for uid in kept:
        session.add(JobAddBatchShareUser(batch_id=batch_id, user_id=uid))
    return kept


async def create_batch(
    session: AsyncSession,
    user_id: str,
    job_ids: Iterable[str],
    *,
    source: str = "manual",
    share_scope: str | None = None,
    share_user_ids: Iterable[str] | None = None,
) -> dict[str, Any] | None:
    ids = _unique_ids(job_ids, limit=MAX_BATCH_JOBS)
    attachable = await _jobs_for_batch(session, user_id, ids)
    if not attachable:
        return None

    user = await session.get(User, user_id)
    if user is None:
        return None

    scope = normalize_share_scope(share_scope, default="") if share_scope else ""
    if not scope:
        scope = initial_scope_from_default(getattr(user, "job_share_default", None))

    now = utcnow()
    batch = JobAddBatch(
        user_id=user_id,
        source=normalize_batch_source(source),
        job_count=len(attachable),
        share_scope=scope if scope != "users" else "private",
        created_at=now,
        updated_at=now,
    )
    session.add(batch)
    await session.flush()

    for job_id in attachable:
        session.add(JobAddBatchJob(batch_id=batch.id, job_id=job_id))

    people: list[User] = []
    if scope == "users":
        kept = await _replace_share_users(session, batch.id, user_id, list(share_user_ids or []))
        if kept:
            batch.share_scope = "users"
            people = await _load_share_users(session, batch.id)
        else:
            batch.share_scope = "private"

    await session.flush()
    return serialize_batch(batch, people)


async def fanout_new_batch(batch: dict[str, Any] | None) -> None:
    """A non-private add reaches other people now; score it for them."""
    if not batch or batch.get("share_scope") == "private":
        return
    from app.services.auto_prepare_service import fanout_shared_batch

    try:
        await fanout_shared_batch(batch["id"])
    except Exception as err:
        logger.warning("job_add_batch_fanout_failed", batch_id=batch.get("id"), error=str(err))


async def record_job_add(user_id: str | None, job_ids: Iterable[str], *, source: str) -> dict[str, Any] | None:
    """Server-side add session for paths with no share toast (assistant, source syncs)."""
    ids = [job_id for job_id in job_ids if job_id]
    if not user_id or not ids:
        return None
    from app.storage.database import get_session

    try:
        async with get_session() as session:
            batch = await create_batch(session, user_id, ids, source=source)
            await session.commit()
    except Exception as err:
        logger.warning("job_add_record_failed", user_id=user_id, source=source, error=str(err))
        return None
    await fanout_new_batch(batch)
    return batch


async def list_batches(session: AsyncSession, user_id: str, *, limit: int = 30) -> list[dict[str, Any]]:
    result = await session.execute(
        select(JobAddBatch)
        .where(JobAddBatch.user_id == user_id)
        .order_by(JobAddBatch.created_at.desc())
        .limit(max(1, min(limit, 50)))
    )
    batches = list(result.scalars().all())
    if not batches:
        return []
    user_ids_by_batch: dict[str, list[str]] = {batch.id: [] for batch in batches}
    share_rows = await session.execute(
        select(JobAddBatchShareUser).where(JobAddBatchShareUser.batch_id.in_(user_ids_by_batch))
    )
    needed_users: set[str] = set()
    for row in share_rows.scalars().all():
        user_ids_by_batch[row.batch_id].append(row.user_id)
        needed_users.add(row.user_id)
    people_by_id: dict[str, User] = {}
    if needed_users:
        loaded = await session.execute(select(User).where(User.id.in_(needed_users)))
        people_by_id = {person.id: person for person in loaded.scalars().all()}
    payload = []
    for batch in batches:
        people = [people_by_id[uid] for uid in user_ids_by_batch[batch.id] if uid in people_by_id]
        payload.append(serialize_batch(batch, people))
    return payload


async def get_owned_batch(session: AsyncSession, user_id: str, batch_id: str) -> JobAddBatch | None:
    result = await session.execute(
        select(JobAddBatch).where(JobAddBatch.id == batch_id, JobAddBatch.user_id == user_id)
    )
    return result.scalar_one_or_none()


async def update_share(
    session: AsyncSession,
    user_id: str,
    batch_id: str,
    *,
    share_scope: str,
    share_user_ids: Iterable[str] | None = None,
) -> dict[str, Any]:
    batch = await get_owned_batch(session, user_id, batch_id)
    if batch is None:
        raise LookupError("Add session not found")
    scope = normalize_share_scope(share_scope, default="")
    if scope not in SHARE_SCOPES:
        raise ValueError("share_scope must be private, team, all, or users")

    people: list[User] = []
    if scope == "users":
        kept = await _replace_share_users(session, batch.id, user_id, list(share_user_ids or []))
        if not kept:
            raise ValueError("Pick at least one person to share with")
        batch.share_scope = "users"
        people = await _load_share_users(session, batch.id)
    else:
        await session.execute(delete(JobAddBatchShareUser).where(JobAddBatchShareUser.batch_id == batch.id))
        batch.share_scope = scope

    batch.updated_at = utcnow()
    await session.flush()
    return serialize_batch(batch, people)


async def list_share_targets(session: AsyncSession, user_id: str) -> list[dict[str, Any]]:
    result = await session.execute(
        select(User)
        .where(
            User.id != user_id,
            User.is_active.is_(True),
            User.approval_status == _TEAM_APPROVED,
        )
        .order_by(func.lower(User.email))
        .limit(300)
    )
    return [
        {"id": person.id, "name": display_name(person), "email": person.email}
        for person in result.scalars().all()
    ]
