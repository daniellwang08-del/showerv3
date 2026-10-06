"""Free (non-LLM) match score for a job description pasted into the assistant.

The posting is encoded in memory with the same pipeline as ``encode_job`` and
scored by the vector engine. Nothing is written to ``jobs`` or
``job_encodings``. Encoding needs the embedding model, so this runs in the
encoding worker; the API calls :func:`score_pasted_job_remote`.
"""

from __future__ import annotations

import asyncio
import re
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

from app.core.logging import get_logger
from app.models.schemas import JobDescriptionSchema

logger = get_logger(__name__)

SCORE_TASK = "score_pasted_job_task"
_REMOTE_TIMEOUT_S = 90
_MAX_REQUIREMENTS = 25


_SEPARATORS = " \t-|,:;\u2013\u2014\u00b7\u2022"

# "It's Arun from Acme Robotics." / "This is Dana with Globex, ..." in a pasted recruiter email.
_RECRUITER_INTRO_RE = re.compile(
    r"\b(?i:i'?m|i am|it'?s|its|this is|my name is)\s+[A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)?\s+"
    r"(?i:from|at|with)\s+(?:the\s+)?([A-Z][\w&'-]*(?:[ \t]+(?:[A-Z&][\w&'-]*|of|and))*)"
)


def _recruiter_company(text: str) -> str | None:
    match = _RECRUITER_INTRO_RE.search((text or "")[:600])
    if not match:
        return None
    words = match.group(1).split()
    while words and words[-1] in {"of", "and"}:
        words.pop()
    return _clean_span(" ".join(words[:6]))


def _clean_span(value: str | None) -> str | None:
    """Drop separator punctuation a span ranker keeps from 'Title - Company' lines."""
    text = (value or "").strip(_SEPARATORS)
    return text[:300] or None


def _structured_job(meta: dict, text: str, requirements: list[str]) -> JobDescriptionSchema:
    from app.services.job_metadata_hydrator import to_job_description_schema

    schema = to_job_description_schema(meta)
    if schema is None:
        schema = JobDescriptionSchema(
            title=meta.get("title") or "Untitled",
            company=meta.get("company"),
            location=meta.get("location"),
            description=text if len(text.strip()) >= 10 else "Job description",
        )
    if requirements:
        schema.requirements = requirements
    return schema


async def score_pasted_job(user_id: str, text: str) -> dict:
    """Encode ``text`` in memory and score it for ``user_id``.

    Returns ``{"match", "title", "company", "location", "structured_job",
    "posting_issue"}``. ``match`` is None when the profile cannot be scored.
    """
    from app.models.database import JobEncoding
    from app.services.encoding_service import (
        ENCODER_VERSION,
        _analyze_job_text,
        _compose_job_texts,
        encode_user,
        job_signals,
        matrix_to_bytes,
        model_version,
        vec_to_bytes,
    )
    from app.services.job_metadata_hydrator import build_metadata
    from app.services.vector_match_service import (
        load_encodings,
        score_pair_v5,
        user_encoding_is_scorable,
    )

    meta = build_metadata(plain_text=text)
    title, location = meta.get("title"), meta.get("location")
    company = meta.get("company") or _recruiter_company(text)
    job = SimpleNamespace(title=title, company=company, location=location, industry=None)
    title_text, content_text, industry_text, full_text = _compose_job_texts(job, None, text)
    job_id = f"pasted-{uuid.uuid4().hex[:24]}"

    (
        skills,
        years_required,
        degree_required,
        clearance,
        (title_vec, content_vec, industry_vec),
        chunk_mat,
        _work_mode,
        ml_title,
        ml_company,
        (req_payload, req_mat, ce_text),
    ) = await asyncio.to_thread(
        _analyze_job_text,
        job_id,
        title_text,
        content_text,
        industry_text,
        full_text,
        title,
        company,
        location,
        meta.get("work_mode"),
        None,
        False,
        text,
    )
    title = _clean_span(title or ml_title)
    company = _clean_span(company or ml_company)
    meta["title"], meta["company"] = title, company
    signals = job_signals(title or title_text, text)

    requirements = [
        str(r["t"]) for r in req_payload if float(r.get("m") or 0) >= 0.5 and r.get("t")
    ][:_MAX_REQUIREMENTS]
    out: dict = {
        "match": None,
        "title": title,
        "company": company,
        "location": location,
        "structured_job": _structured_job(meta, text, requirements).model_dump(mode="json"),
        "posting_issue": signals.get("posting_issue"),
    }

    try:
        await encode_user(user_id)
    except Exception as e:  # noqa: BLE001 - a stale profile encoding still scores
        logger.warning("pasted_job_encode_user_failed", user_id=user_id, error=str(e))
    _none, user_enc = await load_encodings(job_id, user_id)
    if user_enc is None or not user_encoding_is_scorable(user_enc):
        return out
    if user_enc.model_version != model_version():
        return out

    enc = JobEncoding(
        job_id=job_id,
        model_version=model_version(),
        title_vec=vec_to_bytes(title_vec),
        content_vec=vec_to_bytes(content_vec),
        industry_vec=vec_to_bytes(industry_vec),
        chunk_vecs=matrix_to_bytes(chunk_mat),
        req_vecs=matrix_to_bytes(req_mat),
        req_lines=req_payload,
        ce_text=ce_text,
        skills=skills,
        years_required=years_required,
        degree_required=degree_required,
        requires_security_clearance=bool(clearance),
        signals=signals,
        encoder_version=ENCODER_VERSION,
        encoded_at=datetime.now(timezone.utc).replace(tzinfo=None),
    )
    match = await score_pair_v5(enc, user_enc)
    out["match"] = {
        k: match.get(k)
        for k in (
            "overall_score",
            "dimension_scores",
            "summary",
            "strengths",
            "gaps",
            "recommendation",
            "is_job_posting",
            "scorer_version",
        )
        if k in match
    }
    return out


async def score_pasted_job_remote(user_id: str, text: str) -> dict | None:
    """Run :func:`score_pasted_job` on the encoding worker. None when it is unavailable."""
    try:
        from app.tasks.worker import get_encoding_pool

        pool = await get_encoding_pool()
        job = await pool.enqueue_job(SCORE_TASK, user_id, text)
        if job is None:
            return None
        result = await job.result(timeout=_REMOTE_TIMEOUT_S, poll_delay=0.5)
        return result if isinstance(result, dict) else None
    except Exception as e:  # noqa: BLE001 - caller falls back to the LLM scorer
        logger.warning("pasted_job_free_score_failed", user_id=user_id, error=str(e))
        return None
