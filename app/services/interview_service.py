"""Interview pipeline: mail sync, process matching, stage rules and API payloads.

A process is one hiring loop (company + role). Each relevant email becomes an
event on a process. Stages only move forward from email (a rejection closes the
process); the user can override the stage at any time from the page.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.models.database import InterviewEvent, InterviewProcess, Job, MailConnection, ValidJobUserApplication
from app.services import interview_extraction as extraction
from app.services import mail_applications, nylas_service
from app.storage.database import get_session

logger = get_logger(__name__)

STAGES = ("applied", "screening", "assessment", "interviewing", "final", "offer")
TERMINAL_STAGES = ("rejected", "withdrawn")
ALL_STAGES = STAGES + TERMINAL_STAGES
STAGE_RANK = {s: i for i, s in enumerate(STAGES)}

KIND_STAGE: dict[str, str | None] = {
    "application_received": "applied",
    "recruiter_screen": "screening",
    "assessment": "assessment",
    "technical": "interviewing",
    "behavioral": "interviewing",
    "hiring_manager": "interviewing",
    "onsite": "final",
    "final": "final",
    "offer": "offer",
    "rejection": "rejected",
    "scheduling": None,
    "other": None,
}
# Emails of these kinds only update an existing process; they never start one.
UPDATE_ONLY_KINDS = ("application_received", "rejection")

FIRST_SYNC_LOOKBACK = timedelta(days=60)
# Headers are cheap (one request per 200); bodies and LLM calls are not.
MAX_SCAN = 5000
# Active job seekers get 30 to 60 confirmations a day; one first sync should cover the window.
MAX_CANDIDATES = 1200
CHUNK_SIZE = 60
STALE_SYNC = timedelta(minutes=30)
BODY_CONCURRENCY = 5
LLM_CONCURRENCY = 4


def _utcnow() -> datetime:
    return datetime.utcnow()


def _iso(dt: datetime | None) -> str | None:
    return dt.replace(tzinfo=timezone.utc).isoformat() if dt else None


# ── Stage rules ─────────────────────────────────────────────────────────────


def stage_after_event(current: str, status: str, kind: str, stage_hint: str | None = None) -> tuple[str, str]:
    """(stage, status) for a process after an email of ``kind`` arrives."""
    target = KIND_STAGE.get(kind) or stage_hint
    if target == "rejected":
        return "rejected", "closed"
    if status == "closed":
        if target in STAGE_RANK:
            return target, "active"
        return current, status
    if target in STAGE_RANK and STAGE_RANK[target] > STAGE_RANK.get(current, -1):
        return target, "active"
    return current, status


def initial_stage(kind: str) -> str:
    stage = KIND_STAGE.get(kind)
    return stage if stage in STAGE_RANK else "screening"


def pick_process(
    candidates: list[InterviewProcess], role: str | None
) -> InterviewProcess | None:
    """Best existing process for an email from this company (candidates newest first)."""
    role_k = extraction.company_key(role)
    if role_k:
        for p in candidates:
            if p.role_title and extraction.company_key(p.role_title) == role_k:
                return p
    for p in candidates:
        if p.status == "active" and (not role_k or not p.role_title):
            return p
    if not role_k and candidates:
        return candidates[0]
    return None


# ── Applying one extracted email ────────────────────────────────────────────


async def _linked_job(session: AsyncSession, user_id: str, key: str) -> str | None:
    first = key.split(" ")[0] if key else ""
    if len(first) < 2:
        return None
    rows = (
        await session.execute(
            select(Job.id, Job.company)
            .join(ValidJobUserApplication, ValidJobUserApplication.job_id == Job.id)
            .where(ValidJobUserApplication.user_id == user_id, func.lower(Job.company).like(f"%{first}%"))
            .order_by(ValidJobUserApplication.applied_at.desc())
            .limit(25)
        )
    ).all()
    for job_id, company in rows:
        if extraction.company_key(company) == key:
            return job_id
    return None


async def apply_extraction(
    session: AsyncSession,
    user_id: str,
    message: dict[str, Any],
    result: dict[str, Any],
) -> str:
    """Store one extracted email. Returns 'created', 'updated' or 'skipped'."""
    key = extraction.company_key(result["company"])
    candidates = list(
        (
            await session.execute(
                select(InterviewProcess)
                .where(InterviewProcess.user_id == user_id, InterviewProcess.company_key == key)
                .order_by(InterviewProcess.last_activity_at.desc().nullslast())
            )
        ).scalars()
    )
    process = pick_process(candidates, result.get("role"))
    kind = result["kind"]
    email_date: datetime | None = message.get("date")
    outcome = "updated"

    if process is None:
        if kind in UPDATE_ONLY_KINDS or (kind == "other" and result["status"] not in ("scheduled", "needs_scheduling")):
            return "skipped"
        process = InterviewProcess(
            id=str(uuid.uuid4()),
            user_id=user_id,
            company=result["company"],
            company_key=key,
            role_title=result.get("role"),
            stage=initial_stage(kind),
            status="active",
            source="email",
            job_id=await _linked_job(session, user_id, key),
            last_activity_at=email_date,
        )
        session.add(process)
        # No relationship() links the two models and sessions don't autoflush,
        # so the unit of work may insert the event first and break its FK.
        await session.flush()
        outcome = "created"

    existing = (
        await session.execute(
            select(InterviewEvent).where(
                InterviewEvent.user_id == user_id, InterviewEvent.message_id == message["id"]
            )
        )
    ).scalar_one_or_none()
    event = existing or InterviewEvent(id=str(uuid.uuid4()), user_id=user_id, message_id=message["id"])
    event.process_id = process.id
    event.kind = kind
    event.status = result["status"]
    event.title = result.get("title")
    event.scheduled_at = result.get("scheduled_at")
    event.duration_minutes = result.get("duration_minutes")
    event.meeting_url = result.get("meeting_url")
    event.location = result.get("location")
    event.interviewers = result.get("interviewers")
    event.summary = result.get("summary")
    event.thread_id = message.get("thread_id")
    event.email_subject = (message.get("subject") or "")[:500] or None
    event.email_from = (message.get("from") or "")[:500] or None
    event.email_date = email_date
    if existing is None:
        session.add(event)

    if event.status == "scheduled":
        await _close_open_requests(session, process.id, exclude=event.id, before=email_date)

    if result.get("role") and not process.role_title:
        process.role_title = result["role"]
    is_newest = process.last_activity_at is None or (email_date and email_date >= process.last_activity_at)
    if is_newest:
        process.stage, process.status = stage_after_event(process.stage, process.status, kind)
        if result.get("next_step"):
            process.next_step = result["next_step"]
        elif kind == "rejection":
            process.next_step = None
        if result.get("remaining_steps"):
            process.remaining_steps = result["remaining_steps"]
        process.last_activity_at = email_date or _utcnow()
    elif kind != "rejection" and process.status == "active":
        process.stage, process.status = stage_after_event(process.stage, process.status, kind)
    await session.flush()
    return outcome


async def _close_open_requests(
    session: AsyncSession, process_id: str, *, exclude: str, before: datetime | None
) -> None:
    """A confirmed booking settles earlier 'please share availability' requests."""
    rows = (
        await session.execute(
            select(InterviewEvent).where(
                InterviewEvent.process_id == process_id,
                InterviewEvent.id != exclude,
                InterviewEvent.status == "needs_scheduling",
            )
        )
    ).scalars()
    for row in rows:
        if before is None or row.email_date is None or row.email_date <= before:
            row.status = "completed"


# ── Sync ────────────────────────────────────────────────────────────────────


def is_sync_running(conn: MailConnection) -> bool:
    if conn.sync_status != "running" or conn.sync_started_at is None:
        return False
    return _utcnow() - conn.sync_started_at < STALE_SYNC


async def mark_sync_started(session: AsyncSession, conn: MailConnection) -> bool:
    """Flag a sync as running. False when one is already in progress."""
    if is_sync_running(conn):
        return False
    conn.sync_status = "running"
    conn.sync_started_at = _utcnow()
    conn.last_sync_error = None
    await session.commit()
    return True


def _message_meta(raw: dict[str, Any]) -> dict[str, Any]:
    date = nylas_service.message_datetime(raw)
    return {
        "id": str(raw.get("id")),
        "thread_id": raw.get("thread_id"),
        "subject": str(raw.get("subject") or ""),
        "from": nylas_service.sender_label(raw.get("from")),
        "snippet": str(raw.get("snippet") or ""),
        "date": date,
        "received_iso": _iso(date),
    }


async def _apply_one(
    session: AsyncSession, user_id: str, m: dict[str, Any], result: dict[str, Any]
) -> tuple[str, bool]:
    """Store one extracted email. Returns (process outcome, whether a new application was stored)."""
    application = None
    if result["kind"] == "application_received":
        application = await mail_applications.record_application(session, user_id, m, result)
    outcome = await apply_extraction(session, user_id, m, result)
    return outcome, application is not None


async def run_sync(user_id: str, tz_name: str | None = None) -> dict[str, Any]:
    """Scan new mail, extract applications and interview steps. Safe to run in the background.

    Candidates are processed oldest first in chunks; the cursor moves after
    each chunk so an interrupted sync resumes where it stopped.
    """
    tz_name = tz_name or "UTC"
    stats = {
        "scanned": 0, "candidates": 0, "processed": 0, "relevant": 0,
        "created": 0, "updated": 0, "applications": 0, "jobs_marked": 0,
    }
    async with get_session() as session:
        conn = await nylas_service.get_connection(session, user_id)
        if conn is None:
            return stats
        grant_id = conn.grant_id
        after = conn.sync_cursor or (_utcnow() - FIRST_SYNC_LOOKBACK)
        since = after - timedelta(days=1)
        known = set(
            (
                await session.execute(
                    select(InterviewEvent.message_id).where(
                        InterviewEvent.user_id == user_id, InterviewEvent.email_date >= since
                    )
                )
            ).scalars()
        ) | await mail_applications.known_message_ids(session, user_id, since)

    try:
        headers = [_message_meta(m) for m in await nylas_service.list_messages(
            grant_id, received_after=after, max_messages=MAX_SCAN
        )]
        stats["scanned"] = len(headers)
        newest = max((m["date"] for m in headers if m["date"]), default=None)
        candidates = sorted(
            (
                m
                for m in headers
                if m["id"] not in known and extraction.is_candidate(m["subject"], m["snippet"], m["from"])
            ),
            key=lambda m: m["date"] or datetime.min,
        )
        if len(candidates) > MAX_CANDIDATES:
            candidates = candidates[:MAX_CANDIDATES]
            newest = candidates[-1]["date"] or newest
        stats["candidates"] = len(candidates)

        for start in range(0, len(candidates), CHUNK_SIZE):
            chunk = candidates[start : start + CHUNK_SIZE]
            results = await _extract_chunk(user_id, grant_id, chunk, tz_name)
            async with get_session() as session:
                for m in chunk:
                    result = results.get(m["id"])
                    if not result:
                        continue
                    stats["relevant"] += 1
                    try:
                        async with session.begin_nested():
                            outcome, recorded = await _apply_one(session, user_id, m, result)
                    except Exception as e:
                        logger.warning(
                            "interview_apply_failed",
                            user_id=user_id,
                            message_id=m["id"],
                            error_type=type(e).__name__,
                            error=str(e)[:500],
                        )
                        continue
                    if recorded:
                        stats["applications"] += 1
                    if outcome in ("created", "updated"):
                        stats[outcome] += 1
                stats["processed"] += len(chunk)
                conn = await nylas_service.get_connection(session, user_id)
                if conn is not None:
                    conn.last_sync_stats = dict(stats)
                    chunk_newest = chunk[-1]["date"]
                    if chunk_newest and (conn.sync_cursor is None or chunk_newest > conn.sync_cursor):
                        conn.sync_cursor = chunk_newest
                await session.commit()

        async with get_session() as session:
            try:
                async with session.begin_nested():
                    stats["jobs_marked"] = await mail_applications.link_jobs(session, user_id)
            except Exception as e:
                logger.warning("mail_application_link_failed", user_id=user_id, error_type=type(e).__name__, error=str(e)[:500])
            conn = await nylas_service.get_connection(session, user_id)
            if conn is not None:
                conn.sync_status = "idle"
                conn.last_synced_at = _utcnow()
                conn.last_sync_error = None
                conn.last_sync_stats = stats
                if newest and (conn.sync_cursor is None or newest > conn.sync_cursor):
                    conn.sync_cursor = newest
                elif conn.sync_cursor is None:
                    conn.sync_cursor = _utcnow()
            await session.commit()
        logger.info("interview_sync_done", user_id=user_id, **stats)
        if stats["applications"] or stats["jobs_marked"]:
            await _recheck_applied_company_rule(user_id)
    except nylas_service.MailAuthError as e:
        await _finish_with_error(user_id, str(e), needs_reauth=True)
    except Exception as e:
        logger.exception("interview_sync_failed", user_id=user_id, error_type=type(e).__name__, error=str(e)[:500])
        message = str(e) if isinstance(e, nylas_service.MailError) else "Sync failed. Try again in a few minutes."
        await _finish_with_error(user_id, message)
    return stats


async def _recheck_applied_company_rule(user_id: str) -> None:
    """New confirmations can hide other postings at those companies (when the rule is on)."""
    from app.services.dedup_rules_reconcile import reconcile_dedup_rules_for_user
    from app.storage.user_repository import UserRepository

    try:
        async with get_session() as session:
            enabled = await UserRepository(session).get_effective_dedup_applied_company_enabled(user_id)
        if enabled:
            await reconcile_dedup_rules_for_user(user_id)
    except Exception as e:
        logger.warning("mail_application_recheck_failed", user_id=user_id, error_type=type(e).__name__, error=str(e)[:500])


async def _extract_chunk(
    user_id: str, grant_id: str, chunk: list[dict[str, Any]], tz_name: str
) -> dict[str, dict[str, Any] | None]:
    body_sem = asyncio.Semaphore(BODY_CONCURRENCY)

    async def load_body(m: dict[str, Any]) -> None:
        async with body_sem:
            try:
                full = await nylas_service.get_message(grant_id, m["id"])
                m["body"] = nylas_service.html_to_text(full.get("body"))
            except nylas_service.MailAuthError:
                raise
            except nylas_service.MailError as e:
                logger.info("interview_body_fetch_failed", error=str(e))

    await asyncio.gather(*(load_body(m) for m in chunk))

    llm_sem = asyncio.Semaphore(LLM_CONCURRENCY)
    results: dict[str, dict[str, Any] | None] = {}

    async def classify(batch: list[dict[str, Any]]) -> None:
        async with llm_sem:
            try:
                results.update(await extraction.extract_batch(user_id, batch, tz_name=tz_name))
            except Exception as e:
                logger.warning("interview_extract_failed", error=str(e), size=len(batch))

    batches = [chunk[i : i + extraction.BATCH_SIZE] for i in range(0, len(chunk), extraction.BATCH_SIZE)]
    await asyncio.gather(*(classify(b) for b in batches))
    for m in chunk:
        m.pop("body", None)
    return results


async def _finish_with_error(user_id: str, message: str, *, needs_reauth: bool = False) -> None:
    async with get_session() as session:
        conn = await nylas_service.get_connection(session, user_id)
        if conn is None:
            return
        conn.sync_status = "error"
        conn.last_sync_error = message
        if needs_reauth:
            conn.status = nylas_service.STATUS_NEEDS_REAUTH
            conn.last_error = message
        await session.commit()


# ── Payloads ────────────────────────────────────────────────────────────────


def event_public(e: InterviewEvent, conn: MailConnection | None = None) -> dict[str, Any]:
    return {
        "id": e.id,
        "process_id": e.process_id,
        "kind": e.kind,
        "status": e.status,
        "title": e.title,
        "scheduled_at": _iso(e.scheduled_at),
        "duration_minutes": e.duration_minutes,
        "meeting_url": e.meeting_url,
        "location": e.location,
        "interviewers": e.interviewers,
        "summary": e.summary,
        "email_subject": e.email_subject,
        "email_from": e.email_from,
        "email_date": _iso(e.email_date),
        "email_url": mail_applications.email_url(conn, e.message_id, e.thread_id),
        "source": "email" if e.message_id else "manual",
    }


def primary_email_event(events: list[InterviewEvent], upcoming: list[InterviewEvent]) -> InterviewEvent | None:
    """The email a click on the process should open: next round, then an open request, then the latest."""
    from_mail = [e for e in events if e.message_id]
    if not from_mail:
        return None
    for e in upcoming:
        if e.message_id:
            return e
    pending = [e for e in from_mail if e.status in ("needs_scheduling", "action_required")]
    pool = pending or from_mail
    return max(pool, key=lambda e: e.email_date or e.created_at or datetime.min)


def process_public(
    p: InterviewProcess,
    events: list[InterviewEvent],
    job: dict[str, Any] | None,
    conn: MailConnection | None = None,
) -> dict[str, Any]:
    now = _utcnow()
    ordered = sorted(events, key=lambda e: e.scheduled_at or e.email_date or e.created_at or now)
    upcoming = [e for e in ordered if e.status == "scheduled" and e.scheduled_at and e.scheduled_at >= now]
    primary = primary_email_event(ordered, upcoming)
    return {
        "id": p.id,
        "company": p.company,
        "role_title": p.role_title,
        "stage": p.stage,
        "status": p.status,
        "next_step": p.next_step,
        "remaining_steps": p.remaining_steps or [],
        "notes": p.notes,
        "source": p.source,
        "last_activity_at": _iso(p.last_activity_at),
        "created_at": _iso(p.created_at),
        "job": job,
        "events": [event_public(e, conn) for e in ordered],
        "next_event": event_public(upcoming[0], conn) if upcoming else None,
        "email_url": mail_applications.email_url(conn, primary.message_id, primary.thread_id) if primary else None,
        "needs_action": p.status == "active"
        and any(e.status in ("needs_scheduling", "action_required") for e in events),
    }


def summarize(processes: list[dict[str, Any]]) -> dict[str, int]:
    now = datetime.now(timezone.utc)
    week = now + timedelta(days=7)
    upcoming = 0
    for p in processes:
        for e in p["events"]:
            if e["status"] == "scheduled" and e["scheduled_at"]:
                at = datetime.fromisoformat(e["scheduled_at"])
                if now <= at <= week:
                    upcoming += 1
    active = [p for p in processes if p["status"] == "active"]
    return {
        "active": len(active),
        "upcoming_week": upcoming,
        "needs_action": sum(1 for p in active if p["needs_action"]),
        "offers": sum(1 for p in active if p["stage"] == "offer"),
        "closed": len(processes) - len(active),
    }


async def list_processes(
    session: AsyncSession, user_id: str, conn: MailConnection | None = None
) -> list[dict[str, Any]]:
    processes = list(
        (
            await session.execute(
                select(InterviewProcess)
                .where(InterviewProcess.user_id == user_id)
                .order_by(InterviewProcess.last_activity_at.desc().nullslast())
            )
        ).scalars()
    )
    if not processes:
        return []
    ids = [p.id for p in processes]
    events: dict[str, list[InterviewEvent]] = {pid: [] for pid in ids}
    for e in (await session.execute(select(InterviewEvent).where(InterviewEvent.process_id.in_(ids)))).scalars():
        events[e.process_id].append(e)
    job_ids = [p.job_id for p in processes if p.job_id]
    jobs: dict[str, dict[str, Any]] = {}
    if job_ids:
        for jid, title, url in (
            await session.execute(select(Job.id, Job.title, Job.source_url).where(Job.id.in_(job_ids)))
        ).all():
            jobs[jid] = {"id": jid, "title": title, "url": url}
    return [process_public(p, events[p.id], jobs.get(p.job_id or ""), conn) for p in processes]


# ── Manual edits ────────────────────────────────────────────────────────────


class InterviewNotFound(Exception):
    pass


async def _own_process(session: AsyncSession, user_id: str, process_id: str) -> InterviewProcess:
    row = await session.get(InterviewProcess, process_id)
    if row is None or row.user_id != user_id:
        raise InterviewNotFound()
    return row


async def create_process(
    session: AsyncSession,
    user_id: str,
    *,
    company: str,
    role_title: str | None,
    stage: str,
    notes: str | None,
) -> InterviewProcess:
    row = InterviewProcess(
        id=str(uuid.uuid4()),
        user_id=user_id,
        company=company.strip(),
        company_key=extraction.company_key(company),
        role_title=(role_title or "").strip() or None,
        stage=stage,
        status="closed" if stage in TERMINAL_STAGES else "active",
        notes=notes,
        source="manual",
        last_activity_at=_utcnow(),
    )
    row.job_id = await _linked_job(session, user_id, row.company_key)
    session.add(row)
    await session.commit()
    return row


async def update_process(session: AsyncSession, user_id: str, process_id: str, changes: dict[str, Any]) -> None:
    row = await _own_process(session, user_id, process_id)
    if "company" in changes and changes["company"]:
        row.company = changes["company"].strip()
        row.company_key = extraction.company_key(row.company)
    for field in ("role_title", "next_step", "notes"):
        if field in changes:
            value = changes[field]
            setattr(row, field, value.strip() or None if isinstance(value, str) else None)
    if "stage" in changes and changes["stage"]:
        row.stage = changes["stage"]
        if row.stage in TERMINAL_STAGES:
            row.status = "closed"
        elif "status" not in changes:
            row.status = "active"
    if "status" in changes and changes["status"]:
        row.status = changes["status"]
    await session.commit()


async def delete_process(session: AsyncSession, user_id: str, process_id: str) -> None:
    row = await _own_process(session, user_id, process_id)
    await session.execute(delete(InterviewEvent).where(InterviewEvent.process_id == row.id))
    await session.delete(row)
    await session.commit()


async def add_event(session: AsyncSession, user_id: str, process_id: str, data: dict[str, Any]) -> InterviewEvent:
    process = await _own_process(session, user_id, process_id)
    event = InterviewEvent(
        id=str(uuid.uuid4()),
        process_id=process.id,
        user_id=user_id,
        kind=data["kind"],
        status=data.get("status") or ("scheduled" if data.get("scheduled_at") else "info"),
        title=data.get("title"),
        scheduled_at=data.get("scheduled_at"),
        duration_minutes=data.get("duration_minutes"),
        meeting_url=data.get("meeting_url"),
        location=data.get("location"),
        summary=data.get("summary"),
    )
    session.add(event)
    process.stage, process.status = stage_after_event(process.stage, process.status, event.kind)
    process.last_activity_at = _utcnow()
    await session.commit()
    return event


async def update_event(session: AsyncSession, user_id: str, event_id: str, changes: dict[str, Any]) -> None:
    row = await session.get(InterviewEvent, event_id)
    if row is None or row.user_id != user_id:
        raise InterviewNotFound()
    for field in ("status", "title", "scheduled_at", "duration_minutes", "meeting_url", "location", "kind"):
        if field in changes:
            setattr(row, field, changes[field])
    await session.commit()


async def delete_event(session: AsyncSession, user_id: str, event_id: str) -> None:
    row = await session.get(InterviewEvent, event_id)
    if row is None or row.user_id != user_id:
        raise InterviewNotFound()
    await session.delete(row)
    await session.commit()
