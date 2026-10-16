"""Quick apply: a job built from a pasted description instead of a scraped URL.

The user pastes the posting (LinkedIn and other sites NAO cannot scrape), the job
lands in their pool with that text as its shared description, and the regular
analysis, document build and application flow take it from there. Post-analysis
filters never hide these jobs, the user already chose to apply.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from typing import Any

from sqlalchemy import select

from app.core.config import get_settings
from app.core.logging import get_logger
from app.models.database import Job
from app.services.job_field_utils import infer_title_from_description
from app.services.url_manager import URLManager
from app.storage.repository import JobExtractionRepository, UserJobStatusRepository

logger = get_logger(__name__)

QUICK_APPLY_KEY = "quick_apply_by"
PASTED_URL_PARAM = "pasted"
MIN_DESCRIPTION_CHARS = 80
MAX_DESCRIPTION_CHARS = 60_000
HEADER_TIMEOUT_SECONDS = 25
_HEADER_SNIPPET_CHARS = 6_000

_HEADER_PROMPT = (
    "You read a job posting and return JSON with exactly these keys: "
    '"is_job_posting" (boolean), "title" (the role title as written, or null), '
    '"company" (the hiring company, never a job board such as LinkedIn or Indeed, or null), '
    '"location" (city, region or "Remote", or null). '
    "Use only what the text states. Do not guess."
)


def is_quick_apply_for(raw_metadata: Any, user_id: str | None) -> bool:
    meta = raw_metadata if isinstance(raw_metadata, dict) else {}
    users = meta.get(QUICK_APPLY_KEY)
    return bool(user_id) and isinstance(users, list) and str(user_id) in users


def _normalized_text(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip()).lower()


def pasted_job_url(user_id: str, description: str) -> str:
    """Stable stand-in URL for a posting with no link, so a re-paste finds the same job."""
    base = (get_settings().frontend_url or "").strip().rstrip("/") or "http://localhost:5173"
    digest = hashlib.sha256(f"{user_id}\n{_normalized_text(description)}".encode()).hexdigest()[:24]
    return f"{base}/app/jobs?{PASTED_URL_PARAM}={digest}"


def _clean(value: Any, limit: int) -> str | None:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if not text or text.lower() in {"null", "none", "n/a", "unknown", "untitled"}:
        return None
    return text[:limit]


async def guess_job_header(user_id: str, description: str) -> dict:
    """Title, company and location read from the posting; empty values when unsure."""
    out: dict = {"title": None, "company": None, "location": None, "is_job_posting": True}
    try:
        from app.core.llm_client import chat_completion_with_empty_retry, get_llm_client_for_user

        client = await get_llm_client_for_user(user_id, job_type="resume_ai_chat")
        raw, _resp = await asyncio.wait_for(
            chat_completion_with_empty_retry(
                client,
                observe="quick_apply_header",
                job_type="resume_ai_chat",
                raise_on_empty=False,
                model=get_settings().openai_model,
                messages=[
                    {"role": "system", "content": _HEADER_PROMPT},
                    {"role": "user", "content": description[:_HEADER_SNIPPET_CHARS]},
                ],
                temperature=0.0,
                max_tokens=200,
                response_format={"type": "json_object"},
            ),
            timeout=HEADER_TIMEOUT_SECONDS,
        )
        parsed = json.loads(raw or "{}")
        if isinstance(parsed, dict):
            out["title"] = _clean(parsed.get("title"), 500)
            out["company"] = _clean(parsed.get("company"), 500)
            out["location"] = _clean(parsed.get("location"), 500)
            out["is_job_posting"] = parsed.get("is_job_posting") is not False
    except Exception as e:  # noqa: BLE001 - the analysis fills these in later anyway
        logger.warning("quick_apply_header_failed", user_id=user_id, error=str(e)[:200])
    if not out["title"] and out["is_job_posting"]:
        out["title"] = _clean(infer_title_from_description(description), 500)
    return out


def _mark_quick_apply(job: Job, user_id: str) -> None:
    meta = dict(job.raw_metadata or {})
    users = [str(u) for u in (meta.get(QUICK_APPLY_KEY) or []) if u]
    if str(user_id) not in users:
        users.append(str(user_id))
    meta[QUICK_APPLY_KEY] = users
    job.raw_metadata = meta


async def _find_job(session, source_url: str) -> Job | None:
    return (
        await session.execute(
            select(Job)
            .where(
                Job.normalized_url.in_(URLManager.equivalent_normalized_urls(source_url)),
                Job.status.in_(("active", "extraction_failed", "blocked")),
            )
            .order_by(Job.created_at)
            .limit(1)
        )
    ).scalar_one_or_none()


async def _extraction_of(session, job: Job | None):
    if job is None or not job.extraction_id:
        return None
    return await JobExtractionRepository(session).get_by_id(job.extraction_id)


def _holds_other_paste(extraction, description: str) -> bool:
    """The job at this URL already carries a different pasted posting."""
    if extraction is None or not (extraction.raw_metadata or {}).get("manual_jd"):
        return False
    stored = getattr(extraction, "raw_plain_text", None) or ""
    return bool(stored.strip()) and _normalized_text(stored) != _normalized_text(description)


async def create_quick_apply_job(
    session,
    *,
    user_id: str,
    description: str,
    url: str | None = None,
    title: str | None = None,
    company: str | None = None,
    location: str | None = None,
) -> tuple[Job, bool]:
    """Create (or reuse) the job for a pasted posting. Returns ``(job, reused)``.

    A real posting URL that is already in inventory reuses that job; its shared
    description is only replaced when it never got one. A URL already holding a
    different pasted posting (two jobs pasted from one search page) does not.
    Caller commits.
    """
    from app.services.job_pipeline_mode import extraction_has_shared_jd
    from app.services.manual_jd import apply_manual_job_description

    link = (url or "").strip()
    if link and not URLManager.validate_url(link)[0]:
        link = ""
    source_url = link or pasted_job_url(user_id, description)
    existing = await _find_job(session, source_url)
    extraction = await _extraction_of(session, existing)
    if link and _holds_other_paste(extraction, description):
        source_url = pasted_job_url(user_id, description)
        existing = await _find_job(session, source_url)
        extraction = await _extraction_of(session, existing)

    job = existing
    if job is None:
        meta: dict = {
            "submitted_data": {"title": title, "company": company, "location": location},
            "submitted_by_admin": False,
            "submitted_by_user_id": user_id,
            "pasted_description": True,
        }
        if link and link != source_url:
            meta["posting_url"] = link
        job = Job(
            source_url=source_url,
            normalized_url=URLManager.normalize_url(source_url),
            domain=URLManager.extract_domain(source_url),
            title=title,
            company=company or "Unknown",
            location=location,
            status="active",
            raw_metadata=meta,
        )
        session.add(job)
        await session.flush()
    else:
        if title and not job.title:
            job.title = title
        if company and (not job.company or job.company == "Unknown"):
            job.company = company
        if location and not job.location:
            job.location = location

    _mark_quick_apply(job, user_id)

    if job.status != "active" or not extraction_has_shared_jd(extraction):
        await apply_manual_job_description(
            session, job=job, plain_text=description, saved_by_user_id=user_id
        )

    await UserJobStatusRepository(session).upsert(user_id=user_id, job_id=job.id, status="active")
    await session.flush()
    logger.info(
        "quick_apply_job_ready",
        job_id=job.id,
        user_id=user_id,
        reused=existing is not None,
        has_url=bool(link),
        length=len(description),
    )
    return job, existing is not None
