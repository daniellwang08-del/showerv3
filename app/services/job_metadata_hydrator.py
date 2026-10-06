"""Fast structured metadata hydration for Jobs table columns (no torch).

Uses ATS API fields and labeled ``Title:`` / ``Company:`` lines. Messy HTML
embeds without those signals are filled later by MiniLM span ranking in
``metadata_vector_extractor`` during ``encode_job`` - not by vendor page regex.
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
    normalize_work_mode_display,
    resolve_display_work_mode,
)
from app.services.job_location_parse import (
    infer_location_from_text,
    prefer_job_location,
    strip_work_mode_from_location,
)
from app.services.job_source_boards import detect_board
from app.services.job_text_rules import (
    infer_employment_type,
    infer_salary_from_text,
    normalize_employment_type,
)
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
    # Recognized so the header scan does not stop here; value is unused. The
    # JSON-LD extractor emits Description between Title and Company.
    "Description",
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
        "create a job alert",
        "apply now »",
        "apply now",
        "what we offer",
        "diversity and inclusion",
    }
)

# ATS hosts where the employer slug lives in the path, not the subdomain:
# ats.rippling.com/<slug>/jobs/..., app.dover.com/apply/<Company>/...,
# app.trinethire.com/companies/<id>-<slug>/jobs/..., comeet.com/jobs/<slug>/...
_ATS_PATH_COMPANY = {
    "ats.rippling.com": 0,
    "careers-page.com": 0,
    "app.dover.com": 1,
    "app.trinethire.com": 1,
    "comeet.com": 1,
}
_ATS_PATH_NOISE = frozenset({"apply", "jobs", "job", "companies", "careers"})
_TRINET_ID_PREFIX_RE = re.compile(r"^\d+-")

# Job boards / aggregators: the host is never the employer, so a hostname-derived
# name here would label every posting with the board's own name.
_NON_EMPLOYER_HOSTS = frozenset({
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
    "dice",
    "indeed",
    "ziprecruiter",
    "fetchjobs",
    "linkedin",
    "glassdoor",
    "monster",
    "simplyhired",
    "jobright",
    "builtin",
    "wellfound",
    "lensa",
    "adzuna",
    "jooble",
    "talent",
})


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
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
        query = parsed.query or ""
        path_parts = [p for p in unquote(parsed.path or "").split("/") if p]
    except Exception:
        return None
    # Greenhouse embed: .../embed/job_app?for=boardtoken&token=JOBID
    if "greenhouse.io" in host and "for=" in query.lower():
        for part in query.split("&"):
            if part.lower().startswith("for="):
                tok = unquote(part.split("=", 1)[-1]).strip()
                if tok and tok.lower() not in {"embed", "job_app"}:
                    return _slug_to_company(tok)
    # ATS hosts that carry the employer as a path segment rather than a subdomain.
    for suffix, index in _ATS_PATH_COMPANY.items():
        if host == suffix or host.endswith("." + suffix):
            if len(path_parts) > index:
                slug = _TRINET_ID_PREFIX_RE.sub("", path_parts[index]).strip()
                if slug and slug.lower() not in _ATS_PATH_NOISE:
                    return _slug_to_company(slug)
            return None
    for prefix in ("www.", "jobs.", "careers.", "apply.", "boards.", "job-boards."):
        if host.startswith(prefix):
            host = host[len(prefix) :]
            break
    root = host.split(".")[0] if host else ""
    if root in _NON_EMPLOYER_HOSTS:
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
            # Blank after we already have labels usually ends the header,
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
        "posted_date": ("posted_date",),
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


def _usable_salary(value: str | None) -> str | None:
    """Drop labelled values that carry no amount (``Currency: USD``)."""
    if value and any(ch.isdigit() for ch in value):
        return value
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
    """Merge *structured* ATS fields for a fast hydrate (no torch).

    Final title/company fill for messy HTML embeds is done by MiniLM span
    ranking in ``metadata_vector_extractor`` during ``encode_job`` - not by
    vendor-specific page-text regexes.
    """
    labeled = parse_labeled_metadata(plain_text)
    structured = metadata_from_structured_data(structured_data)
    heading = parse_job_details_heading(plain_text)

    title = (
        clean_optional_job_field(structured.get("title"))
        or clean_optional_job_field(labeled.get("title"))
        or clean_optional_job_field(heading.get("title"))
        or clean_optional_job_field(existing_title)
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

    location = None
    for candidate in (
        clean_optional_job_field(structured.get("location")),
        clean_optional_job_field(labeled.get("location")),
        clean_optional_job_field(existing_location),
        infer_location_from_text(plain_text),
    ):
        location = prefer_job_location(location, candidate)
    employment_type = normalize_employment_type(
        clean_optional_job_field(structured.get("employment_type") or labeled.get("employment_type"))
    ) or infer_employment_type(title, plain_text)
    salary_range = _usable_salary(
        clean_optional_job_field(structured.get("salary_range") or labeled.get("salary_range"))
    ) or infer_salary_from_text(plain_text)
    explicit_workplace = structured.get("workplace") or labeled.get("workplace")
    if (explicit_workplace or "").strip().lower() in {"yes", "true", "y"}:
        explicit_workplace = "remote"
    elif (explicit_workplace or "").strip().lower() in {"no", "false", "n"}:
        explicit_workplace = None
    workplace = explicit_workplace
    if not workplace and location and "remote" in location.lower():
        workplace = "remote"
    is_remote_flag = bool(structured.get("is_remote"))
    if isinstance(structured.get("is_remote"), str):
        is_remote_flag = structured.get("is_remote", "").strip().lower() in {
            "1",
            "true",
            "yes",
        }

    # Fast deterministic path (no torch). Encoding worker upgrades via MiniLM.
    from app.services.work_mode_classifier import classify_work_mode

    work_mode, _mode_explain = classify_work_mode(
        title=title,
        location=location,
        workplace=explicit_workplace,
        remote_policy=explicit_workplace,
        plain_text=plain_text,
        is_remote=is_remote_flag,
        use_vector=False,
    )
    if not work_mode:
        work_mode = resolve_display_work_mode(
            analysis_work_mode=normalize_work_mode_display(workplace)
            or normalize_work_mode_display(existing_work_mode),
            location=location,
            remote_policy=workplace,
            title=title,
            is_remote=is_remote_flag,
        )

    description = body_description_from_plain_text(plain_text)
    posted_date = _parse_posted_date(structured.get("posted_date")) or _parse_posted_date(
        labeled.get("posted_date_raw")
    )
    return {
        "title": title,
        "company": company,
        "location": strip_work_mode_from_location(location),
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
    company = clean_optional_job_field(meta.get("company"))
    if len(description) < 10:
        return None
    # Title may be empty until MiniLM fill in encode_job; still hydrate
    # company / location / work_mode from structured or URL signals.
    if not title and not company and not clean_optional_job_field(meta.get("location")):
        return None
    return JobDescriptionSchema(
        title=title or "Untitled",
        company=company,
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
    pass did, without rewriting an already-rich LLM structured description
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
