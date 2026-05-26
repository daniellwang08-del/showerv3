"""
Phase B-pre: extract job-relevant evidence from per-company project source documents.
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any

from openai import AsyncOpenAI

from app.core.config import get_settings
from app.core.exceptions import AIParsingError
from app.core.logging import get_logger
from app.core.openai_client import get_openai_client_for_user
from app.models.database import ProfileSourceDocument, User
from app.models.schemas import JobDescriptionSchema
from app.utils.company_name_utils import company_names_match, normalize_company_name

try:
    from langfuse import observe
except ImportError:
    from functools import wraps

    def observe(**_kw):
        def _decorator(fn):
            @wraps(fn)
            async def _wrapper(*a, **k):
                return await fn(*a, **k)

            return _wrapper

        return _decorator

logger = get_logger(__name__)

MAX_EVIDENCE_CONTEXT_CHARS = 15_000
MAX_SOURCE_PER_COMPANY_CHARS = 12_000
MAX_BATCH_SOURCE_CHARS = 25_000
MAX_EVIDENCE_BULLETS_PER_COMPANY = 12

EVIDENCE_SYSTEM_PROMPT = """You extract job-relevant evidence from a candidate's detailed project source material.

Return ONLY valid JSON with this shape:
{
  "companies": [
    {
      "company_name": "<string>",
      "relevant_projects": ["<project name>", ...],
      "evidence_bullets": ["<1-3 sentence bullet with concrete facts, metrics, technologies>", ...],
      "technologies_to_emphasize": ["<tech>", ...]
    }
  ]
}

Rules:
- Use ONLY facts present in the source material. Do not invent metrics, tools, or outcomes.
- Select projects and bullets that best align with the target job description and requirements.
- Each evidence_bullet must be resume-ready (action + scope + outcome when available).
- Prefer quantified results when they appear in the source.
- Include one entry per company provided in the input; if nothing is relevant, return empty arrays for that company.
- Limit evidence_bullets to at most 10 per company — prioritize the strongest alignment.
"""


def _truncate(text: str, max_len: int, suffix: str = "...") -> str:
    if not text or len(text) <= max_len:
        return text or ""
    return text[: max_len - len(suffix)].rstrip() + suffix


def _parse_json_object(content: str) -> dict[str, Any]:
    raw = content.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("Expected JSON object")
    return data


def profile_company_names(user: User | None) -> list[str]:
    names: list[str] = []
    seen: set[str] = set()
    for item in getattr(user, "work_experience", None) or []:
        if not isinstance(item, dict):
            continue
        company = (item.get("company_name") or "").strip()
        if not company:
            continue
        key = normalize_company_name(company)
        if key and key not in seen:
            seen.add(key)
            names.append(company)
    return names


def match_documents_to_companies(
    docs: list[ProfileSourceDocument],
    profile_companies: list[str],
) -> dict[str, list[ProfileSourceDocument]]:
    """Map profile company display name -> source documents."""
    mapping: dict[str, list[ProfileSourceDocument]] = {c: [] for c in profile_companies}
    for doc in docs:
        doc_company = (doc.company_name or "").strip()
        if not doc_company and isinstance(doc.structured_data, dict):
            doc_company = str(doc.structured_data.get("company_name") or "").strip()
        matched_profile: str | None = None
        for profile_co in profile_companies:
            if company_names_match(doc_company, profile_co):
                matched_profile = profile_co
                break
        if matched_profile:
            mapping[matched_profile].append(doc)
    return mapping


def structured_doc_to_text(doc: ProfileSourceDocument) -> str:
    data = doc.structured_data if isinstance(doc.structured_data, dict) else {}
    parts: list[str] = []
    company = (doc.company_name or data.get("company_name") or "").strip()
    if company:
        parts.append(f"Company: {company}")
    projects = data.get("projects") if isinstance(data.get("projects"), list) else []
    for proj in projects:
        if not isinstance(proj, dict):
            continue
        name = str(proj.get("name") or "").strip()
        if name:
            parts.append(f"\nProject: {name}")
        for field, label in (
            ("summary", "Summary"),
            ("technologies", "Technologies"),
            ("responsibilities", "Responsibilities"),
            ("metrics", "Metrics"),
            ("outcomes", "Outcomes"),
        ):
            val = proj.get(field)
            if isinstance(val, list):
                items = [str(x).strip() for x in val if str(x).strip()]
                if items:
                    parts.append(f"{label}: " + "; ".join(items))
            elif isinstance(val, str) and val.strip():
                parts.append(f"{label}: {val.strip()}")
    if parts:
        return "\n".join(parts)
    return (doc.extracted_text or "").strip()


def build_company_source_block(company_name: str, docs: list[ProfileSourceDocument]) -> str:
    chunks: list[str] = [f"### {company_name}"]
    for doc in docs:
        body = structured_doc_to_text(doc)
        if not body:
            continue
        header = f"Source file: {doc.filename}"
        chunks.append(f"{header}\n{_truncate(body, MAX_SOURCE_PER_COMPANY_CHARS // max(1, len(docs)))}")
    return "\n\n".join(chunks)


def _build_job_context(
    job_text: str,
    structured_job: JobDescriptionSchema | None,
    match_summary: str,
) -> str:
    parts: list[str] = [_truncate(job_text, 8000)]
    if structured_job:
        parts.append(f"\nTitle: {structured_job.title or 'Unknown'}")
        parts.append(f"Company: {structured_job.company or 'Unknown'}")
        if structured_job.requirements:
            parts.append("\nKey requirements:")
            for req in structured_job.requirements[:15]:
                parts.append(f"- {req}")
        if structured_job.responsibilities:
            parts.append("\nKey responsibilities:")
            for resp in structured_job.responsibilities[:15]:
                parts.append(f"- {resp}")
    if match_summary.strip():
        parts.append(f"\nMatch summary:\n{match_summary.strip()}")
    return "\n".join(parts)


def format_evidence_pack(companies_data: list[dict[str, Any]]) -> str:
    sections: list[str] = []
    for entry in companies_data:
        if not isinstance(entry, dict):
            continue
        company = str(entry.get("company_name") or "").strip()
        if not company:
            continue
        lines = [f"## {company}"]
        projects = entry.get("relevant_projects") or []
        if isinstance(projects, list):
            proj_names = [str(p).strip() for p in projects if str(p).strip()]
            if proj_names:
                lines.append("Relevant projects: " + ", ".join(proj_names))
        bullets = entry.get("evidence_bullets") or []
        if isinstance(bullets, list):
            for b in bullets[:MAX_EVIDENCE_BULLETS_PER_COMPANY]:
                if isinstance(b, str) and b.strip():
                    lines.append(f"- {b.strip()}")
        techs = entry.get("technologies_to_emphasize") or []
        if isinstance(techs, list):
            tech_list = [str(t).strip() for t in techs if str(t).strip()]
            if tech_list:
                lines.append("Technologies to emphasize: " + ", ".join(tech_list))
        if len(lines) > 1:
            sections.append("\n".join(lines))
    if not sections:
        return "No project source evidence available."
    return _truncate("\n\n".join(sections), MAX_EVIDENCE_CONTEXT_CHARS)


@observe(name="extract_evidence_single_batch")
async def _call_evidence_extraction(
    *,
    job_context: str,
    source_material: str,
    company_names: list[str],
    user_id: str | None,
) -> list[dict[str, Any]]:
    client: AsyncOpenAI = await get_openai_client_for_user(user_id)
    settings = get_settings()
    user_msg = (
        f"Target job:\n{job_context}\n\n"
        f"Companies to extract evidence for: {', '.join(company_names)}\n\n"
        f"Candidate project source material:\n{source_material}\n\n"
        "Extract job-relevant evidence for each company listed."
    )
    try:
        resp = await client.chat.completions.create(
            model=settings.openai_model,
            messages=[
                {"role": "system", "content": EVIDENCE_SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            temperature=0.1,
            max_tokens=min(max(settings.openai_max_tokens, 4096), 8192),
            response_format={"type": "json_object"},
        )
    except Exception as e:
        logger.exception("evidence_extraction_openai_failed")
        raise AIParsingError(f"Evidence extraction failed: {e}") from e

    raw = resp.choices[0].message.content
    if not raw:
        return []
    try:
        parsed = _parse_json_object(raw)
    except (json.JSONDecodeError, ValueError) as e:
        logger.warning("evidence_extraction_bad_json", error=str(e))
        return []

    companies = parsed.get("companies")
    if not isinstance(companies, list):
        return []
    return [c for c in companies if isinstance(c, dict)]


@observe(name="extract_job_evidence_pack")
async def extract_job_evidence_pack(
    *,
    job_text: str,
    structured_job: JobDescriptionSchema | None,
    match_summary: str,
    user: User | None,
    docs: list[ProfileSourceDocument],
    user_id: str | None = None,
) -> str:
    """
    Phase B-pre: produce compact, job-aligned evidence text from source documents.
    Returns formatted markdown for injection into Phase B.
    """
    profile_companies = profile_company_names(user)
    if not profile_companies or not docs:
        return "No project source evidence available."

    company_docs = match_documents_to_companies(docs, profile_companies)
    active: list[tuple[str, list[ProfileSourceDocument]]] = [
        (co, dlist) for co, dlist in company_docs.items() if dlist
    ]
    if not active:
        return "No project source evidence available."

    job_context = _build_job_context(job_text, structured_job, match_summary)
    settings = get_settings()

    total_chars = sum(len(build_company_source_block(co, dlist)) for co, dlist in active)

    if total_chars <= MAX_BATCH_SOURCE_CHARS:
        source_material = "\n\n---\n\n".join(
            build_company_source_block(co, dlist) for co, dlist in active
        )
        companies_data = await _call_evidence_extraction(
            job_context=job_context,
            source_material=source_material,
            company_names=[co for co, _ in active],
            user_id=user_id,
        )
        return format_evidence_pack(companies_data)

    sem = asyncio.Semaphore(max(1, settings.openai_attachment_max_concurrent))
    all_results: list[dict[str, Any]] = []

    async def _one_company(company_name: str, doc_list: list[ProfileSourceDocument]) -> None:
        source_block = build_company_source_block(company_name, doc_list)
        async with sem:
            try:
                rows = await _call_evidence_extraction(
                    job_context=job_context,
                    source_material=source_block,
                    company_names=[company_name],
                    user_id=user_id,
                )
                all_results.extend(rows)
            except Exception as e:
                logger.warning(
                    "evidence_extraction_company_failed",
                    company=company_name,
                    error=str(e),
                )

    await asyncio.gather(*(_one_company(co, dlist) for co, dlist in active))
    return format_evidence_pack(all_results)
