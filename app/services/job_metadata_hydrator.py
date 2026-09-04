"""Non-LLM job metadata hydration for Jobs table columns.

ATS extractors historically stored only ``raw_plain_text`` and relied on LLM
Phase A to fill title/company/location/etc. Vector mode never runs that pass,
so the dashboard stayed on Untitled / Unknown even when the raw text already
contained ``Title:`` / ``Location:`` labels (or the ATS API returned fields).

This module parses those signals deterministically and patches both
``job_extractions`` and ``jobs`` rows without calling an LLM.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any
from urllib.parse import unquote, urlparse

from app.core.logging import get_logger
from app.models.schemas import JobDescriptionSchema
from app.services.job_field_utils import (
    clean_optional_job_field,
    infer_title_from_description,
    normalize_work_mode_display,
    resolve_display_work_mode,
)
from app.services.job_source_boards import detect_board
from app.storage.database import get_session
from app.storage.repository import JobExtractionRepository, JobRepository

logger = get_logger(__name__)

_LABEL_NAMES = (
    "Title",
    "Company",
    "Location",
    "All Locations",
    "Team",
    "Department",
    "Employment Type",
    "Workplace Type",
    "Workplace",
    "Remote",
    "Office",
    "Salary",
    "Compensation",
    "Posted",
    "Posted (epoch ms)",
    "Date",
)
_LABEL_RE = re.compile(
    rf"^({'|'.join(re.escape(n) for n in _LABEL_NAMES)})\s*:\s*(.*)$",
    re.IGNORECASE,
)
_JOB_DETAILS_TITLE_RE = re.compile(
    r"^(?P<title>.+?)\s+Job Details\s*[|\u2013\-]\s*(?P<company>.+)$",
    re.IGNORECASE,
)
_URL_JOB_SLUG_RE = re.compile(
    r"/(?:job|jobs|position|positions|career|careers)/"
    r"(?P<slug>[^/?#]+)/?(?:\d+)?/?",
    re.IGNORECASE,
)
_UNKNOWN_COMPANY = frozenset({"unknown", "n/a", "na", "none", "null", ""})
_NAV_NOISE = frozenset(
    {
        "skip to main content",
        "life at syniti",
        "careers",
        "explore our roles",
        "your profile",
        "search by keyword",
        "search by location",
        "clear",
        "create alert",
        "apply now »",
        "apply now",
        "what we offer",
        "diversity and inclusion",
        "core values",
        "syniti gives back",
    }
)


def _slug_to_company(slug: str | None) -> str | None:
    if not slug:
        return None
    text = slug.replace("-", " ").replace("_", " ").strip()
    if not text:
        return None
    parts = []
    for tok in text.split():
        if tok.isupper() and len(tok) <= 4:
            parts.append(tok)
        else:
            parts.append(tok[:1].upper() + tok[1:].lower() if tok else tok)
    return " ".join(parts) or None


def infer_company_from_url(url: str | None) -> str | None:
    """Best-effort company name from ATS board slug in the URL."""
    if not url:
        return None
    board = detect_board(url)
    if board is not None:
        return _slug_to_company(board.token)
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return None
    for prefix in ("jobs.", "careers.", "apply.", "boards."):
        if host.startswith(prefix):
            host = host[len(prefix) :]
            break
    root = host.split(".")[0] if host else ""
    if root in {
        "www",
        "app",
        "job",
        "jobs",
        "careers",
        "lever",
        "greenhouse",
        "ashbyhq",
        "myworkdayjobs",
        "ats",
    }:
        return None
    return _slug_to_company(root)


def infer_title_from_url(url: str | None) -> str | None:
    """Recover title from SuccessFactors-style /job/City-Role-Name/id/ paths."""
    if not url:
        return None
    try:
        path = unquote(urlparse(url).path or "")
    except Exception:
        return None
    m = _URL_JOB_SLUG_RE.search(path)
    if not m:
        return None
    slug = m.group("slug").replace("_", "-")
    # Drop trailing numeric ids accidentally captured.
    if slug.isdigit():
        return None
    parts = [p for p in slug.split("-") if p]
    if len(parts) < 2:
        return _slug_to_company(slug)
    # Common pattern: City-Title-Words (Hyderabad-Senior-Consultant)
    # Keep everything after the first token when it looks like a place name.
    title_parts = parts[1:] if len(parts) >= 3 else parts
    return _slug_to_company("-".join(title_parts))


def parse_job_details_heading(plain_text: str | None) -> dict[str, str]:
    """Parse ``Senior Consultant Job Details | Syniti`` style document titles."""
    out: dict[str, str] = {}
    if not plain_text:
        return out
    for line in plain_text.splitlines()[:40]:
        stripped = line.strip()
        if not stripped:
            continue
        m = _JOB_DETAILS_TITLE_RE.match(stripped)
        if m:
            title = clean_optional_job_field(m.group("title"))
            company = clean_optional_job_field(m.group("company"))
            if title:
                out["title"] = title
            if company:
                out["company"] = company
            return out
    return out


def _looks_like_label_only(line: str) -> re.Match[str] | None:
    return _LABEL_RE.match(line)


def parse_labeled_metadata(plain_text: str | None) -> dict[str, str]:
    """Extract labeled header fields from extractor plain text.

    Supports both same-line ``Location: Hyderabad`` and SuccessFactors multiline:

        Location:
        Hyderabad, IN
        Remote, IN
        Company:
        Syniti
    """
    out: dict[str, str] = {}
    if not plain_text:
        return out

    lines = [ln.rstrip() for ln in plain_text.splitlines()]
    i = 0
    saw_label = False
    while i < len(lines):
        stripped = lines[i].strip()
        if not stripped:
            i += 1
            # Blank after we already have labels usually ends the header —
            # but SuccessFactors often has blank lines between fields, so only
            # stop once we have both title-ish content and are past company/location.
            if saw_label and ("company" in out or "location" in out) and i > 0:
                # Peek ahead: if next non-empty is another label, continue.
                j = i
                while j < len(lines) and not lines[j].strip():
                    j += 1
                if j < len(lines) and _looks_like_label_only(lines[j].strip()):
                    i = j
                    continue
                if "company" in out and "location" in out:
                    break
            continue

        m = _LABEL_RE.match(stripped)
        if not m:
            if saw_label:
                # Unlabeled body content after headers.
                break
            i += 1
            continue

        saw_label = True
        label = m.group(1).strip().lower()
        value = (m.group(2) or "").strip()
        i += 1

        # Multiline value: gather following non-label lines.
        if not value:
            chunks: list[str] = []
            while i < len(lines):
                nxt = lines[i].strip()
                if not nxt:
                    # Allow a single blank inside multi-location blocks.
                    if chunks:
                        i += 1
                        break
                    i += 1
                    continue
                if _LABEL_RE.match(nxt):
                    break
                if nxt.lower() in _NAV_NOISE:
                    i += 1
                    continue
                chunks.append(nxt)
                i += 1
                # Location often spans several cities; keep collecting until blank/label.
                if label not in {"location", "all locations"} and len(chunks) >= 1:
                    break
            value = ", ".join(chunks).strip()

        if not value:
            continue
        if label == "title" and "title" not in out:
            out["title"] = value
        elif label == "company" and "company" not in out:
            out["company"] = value
        elif label in {"location", "all locations"} and "location" not in out:
            out["location"] = value
        elif label == "employment type" and "employment_type" not in out:
            out["employment_type"] = value
        elif label in {"workplace type", "workplace", "remote"} and "workplace" not in out:
            out["workplace"] = value
        elif label in {"salary", "compensation"} and "salary_range" not in out:
            out["salary_range"] = value
        elif label in {"team", "department"} and "department" not in out:
            out["department"] = value
        elif label == "date" and "posted_date_raw" not in out:
            out["posted_date_raw"] = value
        elif label == "posted" and "posted_date_raw" not in out:
            out["posted_date_raw"] = value
    return out


def infer_heading_title(plain_text: str | None) -> str | None:
    """Find the first meaningful heading after nav chrome (SuccessFactors pages)."""
    if not plain_text:
        return None
    for line in plain_text.splitlines():
        stripped = line.strip()
        if not stripped or len(stripped) > 120:
            continue
        low = stripped.lower()
        if low in _NAV_NOISE or low.startswith("select how often"):
            continue
        if _LABEL_RE.match(stripped) or _JOB_DETAILS_TITLE_RE.match(stripped):
            continue
        if stripped.endswith(":"):
            continue
        if low.startswith("about ") or low in {"the role", "what you will do", "what it takes"}:
            continue
        # Prefer title-ish lines (contain Consultant/Engineer/Manager/etc. or Title Case).
        if any(
            tok in low
            for tok in (
                "consultant",
                "engineer",
                "manager",
                "director",
                "analyst",
                "developer",
                "scientist",
                "designer",
                "specialist",
                "lead",
                "intern",
            )
        ):
            return stripped
    return None


def metadata_from_structured_data(data: dict[str, Any] | None) -> dict[str, str]:
    if not isinstance(data, dict):
        return {}
    mapping = {
        "title": ("title", "text", "name", "job_title"),
        "company": ("company", "company_name", "organization"),
        "location": ("location", "location_name"),
        "employment_type": ("employment_type", "commitment", "job_type", "type"),
        "workplace": ("workplace", "workplace_type", "workplaceType", "work_mode"),
        "salary_range": ("salary_range", "salary", "compensation"),
    }
    out: dict[str, str] = {}
    for dest, keys in mapping.items():
        for key in keys:
            raw = data.get(key)
            if isinstance(raw, dict):
                raw = raw.get("name") or raw.get("summary") or raw.get("text")
            if isinstance(raw, bool):
                if dest == "workplace" and raw:
                    out[dest] = "remote"
                continue
            cleaned = clean_optional_job_field(raw)
            if cleaned:
                out[dest] = cleaned
                break
    if data.get("is_remote") is True and "workplace" not in out:
        out["workplace"] = "remote"
    return out


def body_description_from_plain_text(plain_text: str | None) -> str:
    """Strip labeled header / nav chrome so description is the JD body."""
    if not plain_text:
        return ""
    lines = plain_text.splitlines()
    # Prefer content starting at ABOUT US / The ROLE / similar.
    start_markers = (
        "about us",
        "the role",
        "about the role",
        "what you will do",
        "job description",
        "responsibilities",
    )
    for idx, line in enumerate(lines):
        low = line.strip().lower()
        if any(low.startswith(m) for m in start_markers):
            body = "\n".join(lines[idx:]).strip()
            if len(body) >= 40:
                return body

    idx = 0
    while idx < len(lines):
        stripped = lines[idx].strip()
        if not stripped:
            idx += 1
            continue
        if _LABEL_RE.match(stripped) or stripped.lower() in _NAV_NOISE:
            idx += 1
            continue
        if _JOB_DETAILS_TITLE_RE.match(stripped):
            idx += 1
            continue
        break
    body = "\n".join(lines[idx:]).strip()
    return body if len(body) >= 10 else (plain_text or "").strip()


def _parse_posted_date(raw: str | None) -> datetime | None:
    if not raw:
        return None
    text = raw.strip()
    for fmt in ("%b %d, %Y", "%B %d, %Y", "%Y-%m-%d", "%m/%d/%Y", "%d %b %Y"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def build_metadata(
    *,
    plain_text: str | None,
    source_url: str | None = None,
    structured_data: dict[str, Any] | None = None,
    existing_title: str | None = None,
    existing_company: str | None = None,
    existing_location: str | None = None,
    existing_work_mode: str | None = None,
) -> dict[str, Any]:
    """Merge structured ATS fields + labeled text + URL heuristics."""
    labeled = parse_labeled_metadata(plain_text)
    structured = metadata_from_structured_data(structured_data)
    heading = parse_job_details_heading(plain_text)

    title = (
        clean_optional_job_field(structured.get("title"))
        or clean_optional_job_field(labeled.get("title"))
        or clean_optional_job_field(heading.get("title"))
        or clean_optional_job_field(existing_title)
        or infer_heading_title(plain_text)
        or infer_title_from_url(source_url)
        or infer_title_from_description(plain_text)
    )
    company = (
        clean_optional_job_field(structured.get("company"))
        or clean_optional_job_field(labeled.get("company"))
        or clean_optional_job_field(heading.get("company"))
        or clean_optional_job_field(existing_company)
        or infer_company_from_url(source_url)
    )
    if company and company.lower() in _UNKNOWN_COMPANY:
        company = (
            clean_optional_job_field(heading.get("company"))
            or infer_company_from_url(source_url)
        )

    location = (
        clean_optional_job_field(structured.get("location"))
        or clean_optional_job_field(labeled.get("location"))
        or clean_optional_job_field(existing_location)
    )
    employment_type = clean_optional_job_field(
        structured.get("employment_type") or labeled.get("employment_type")
    )
    salary_range = clean_optional_job_field(
        structured.get("salary_range") or labeled.get("salary_range")
    )
    workplace = structured.get("workplace") or labeled.get("workplace")
    if not workplace and location and "remote" in location.lower():
        workplace = "remote"
    work_mode = resolve_display_work_mode(
        analysis_work_mode=normalize_work_mode_display(workplace)
        or normalize_work_mode_display(existing_work_mode),
        location=location,
        remote_policy=workplace,
        is_remote=False,
    )

    description = body_description_from_plain_text(plain_text)
    posted_date = _parse_posted_date(labeled.get("posted_date_raw"))
    return {
        "title": title,
        "company": company,
        "location": location,
        "employment_type": employment_type,
        "salary_range": salary_range,
        "work_mode": work_mode,
        "remote_policy": clean_optional_job_field(workplace),
        "description": description,
        "posted_date": posted_date,
    }


def to_job_description_schema(meta: dict[str, Any]) -> JobDescriptionSchema | None:
    title = clean_optional_job_field(meta.get("title"))
    description = (meta.get("description") or "").strip()
    if not title or len(description) < 10:
        return None
    return JobDescriptionSchema(
        title=title,
        company=clean_optional_job_field(meta.get("company")),
        location=clean_optional_job_field(meta.get("location")),
        employment_type=clean_optional_job_field(meta.get("employment_type")),
        salary_range=clean_optional_job_field(meta.get("salary_range")),
        description=description,
        remote_policy=clean_optional_job_field(meta.get("remote_policy")),
        work_mode=normalize_work_mode_display(meta.get("work_mode")),
        posted_date=meta.get("posted_date"),
        raw_metadata={"non_llm_hydrated": True},
    )


async def hydrate_job_metadata(
    *,
    job_id: str,
    extraction_id: str,
    plain_text: str | None = None,
    source_url: str | None = None,
    structured_data: dict[str, Any] | None = None,
    mark_completed: bool = False,
) -> bool:
    """Patch job + extraction display fields from non-LLM signals.

    When ``mark_completed`` is True (vector-engine path), also advances the
    extraction to COMPLETED / is_job_posting=True like the old LLM structuring
    pass did — without rewriting an already-rich LLM structured description
    unless description was empty.
    """
    async with get_session() as session:
        ext_repo = JobExtractionRepository(session)
        job_repo = JobRepository(session)
        extraction = await ext_repo.get_by_id(extraction_id)
        job = await job_repo.get_by_id(job_id)
        if extraction is None and job is None:
            return False

        text = plain_text
        if not text and extraction is not None:
            text = getattr(extraction, "raw_plain_text", None) or extraction.description
        url = source_url
        if not url and job is not None:
            url = job.source_url
        if not url and extraction is not None:
            url = extraction.source_url

        meta = build_metadata(
            plain_text=text,
            source_url=url,
            structured_data=structured_data,
            existing_title=(extraction.title if extraction else None)
            or (job.title if job else None),
            existing_company=(extraction.company if extraction else None)
            or (job.company if job else None),
            existing_location=(extraction.location if extraction else None)
            or (job.location if job else None),
            existing_work_mode=(extraction.work_mode if extraction else None)
            or (job.work_mode if job else None),
        )
        schema = to_job_description_schema(meta)
        if schema is None:
            logger.warning(
                "job_metadata_hydrate_insufficient",
                job_id=job_id,
                extraction_id=extraction_id,
                have_title=bool(meta.get("title")),
                desc_len=len(meta.get("description") or ""),
            )
            if mark_completed and extraction is not None:
                await ext_repo.update_is_job_posting(extraction_id, True)
                from app.models.schemas import ExtractionStatus

                await ext_repo.update_status(extraction_id, ExtractionStatus.COMPLETED)
            return False

        # Prefer keeping an existing long structured description if present.
        if extraction is not None and (extraction.description or "").strip():
            existing_desc = extraction.description.strip()
            if len(existing_desc) >= len(schema.description):
                schema = schema.model_copy(update={"description": existing_desc})

        if mark_completed:
            await ext_repo.update_extraction_result(
                extraction_id,
                schema,
                is_job_posting=True,
            )
        else:
            await ext_repo.patch_display_metadata(extraction_id, schema)
        await job_repo.update_from_structured_extraction(job_id, schema)

    logger.info(
        "job_metadata_hydrated",
        job_id=job_id,
        extraction_id=extraction_id,
        title=schema.title,
        company=schema.company,
        location=schema.location,
        work_mode=schema.work_mode,
        mark_completed=mark_completed,
    )
    return True
