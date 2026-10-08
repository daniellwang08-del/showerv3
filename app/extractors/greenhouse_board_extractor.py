"""
Extract job content via Greenhouse Job Board API (no API key).

Embedded career sites often render a Greenhouse ``job_app`` iframe (application
form + EEO), not the JD.  The public endpoint returns the real ``content`` HTML.

Returns plain text content for downstream LLM analysis.

https://developers.greenhouse.io/job-board-integration.html
"""

from __future__ import annotations

import html as html_lib
import json
import re
from urllib.parse import urlparse

from app.extractors.base import GONE_STATUSES, BaseExtractor, ExtractionResult, http_status_of
from app.models.schemas import ExtractionMethod
from app.services.http_client import HTTPService
from app.services.job_content_cleaner import plain_text_from_fragment_html
from app.core.logging import get_logger

logger = get_logger(__name__)

GREENHOUSE_API_BASE = "https://boards-api.greenhouse.io/v1/boards"

_BOARD_JOBS_IN_PATH = re.compile(
    r"(?:boards|job-boards|jobs)\.greenhouse\.io/([^/\"'\s<>]+)/jobs/(\d+)",
    re.IGNORECASE,
)
_JOBS_NUMERIC_PATH = re.compile(r"/jobs/(\d+)(?:[/?#]|$)", re.IGNORECASE)
_GH_JID_QUERY = re.compile(r"[?&]gh_jid=(\d+)", re.IGNORECASE)
# Jobright / embed iframes often use token=<numeric job id> (not gh_jid).
_GH_EMBED_TOKEN_QUERY = re.compile(r"[?&]token=(\d+)", re.IGNORECASE)
_EMBED_FOR_QUERY = re.compile(r"[?&]for=([^&\"'\s<>]+)", re.IGNORECASE)

_TOKEN_FROM_HTML_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(
        r"(?:job-boards|boards)\.greenhouse\.io/embed/[^\"'\s<>]*[?&]for=([^&\"'\s<>]+)",
        re.IGNORECASE,
    ),
    re.compile(
        r"(?:boards|job-boards)\.greenhouse\.io/([^/\"'\s<>]+)/jobs/",
        re.IGNORECASE,
    ),
    re.compile(
        r"boards-api\.greenhouse\.io/v1/boards/([^/\"'\s<>]+)/",
        re.IGNORECASE,
    ),
    re.compile(
        r"greenhouse\.io/embed/job_app\?[^\"'\s<>]*[?&]for=([^&\"'\s<>]+)",
        re.IGNORECASE,
    ),
    # data-board / data-host attributes used by GH's embedded job board widget
    re.compile(
        r"data-(?:board|host|board-token|for)=[\"']([a-z0-9_-]+)[\"']",
        re.IGNORECASE,
    ),
)
_MAX_TOKEN_CANDIDATES = 4


def normalize_work_mode_hint(text: str | None) -> str | None:
    """Map Greenhouse location / metadata strings to remote|hybrid|onsite."""
    from app.services.job_field_utils import normalize_work_mode_display

    return normalize_work_mode_display(text)


def workplace_from_greenhouse_metadata(metadata: object) -> str | None:
    """Scan Greenhouse custom ``metadata`` array for workplace-like fields."""
    if not isinstance(metadata, list):
        return None
    for item in metadata:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip().lower()
        value = item.get("value")
        if isinstance(value, list):
            value = ", ".join(str(v) for v in value if v is not None)
        value_s = str(value or "").strip()
        if not value_s:
            continue
        if any(
            key in name
            for key in (
                "remote",
                "workplace",
                "work type",
                "work mode",
                "location type",
                "office type",
            )
        ):
            mode = normalize_work_mode_hint(value_s)
            if mode:
                return mode
        mode = normalize_work_mode_hint(value_s)
        if mode and name in {"location", "job location", "job posting location"}:
            # Only accept when the whole value is a mode keyword, not a city.
            if normalize_work_mode_hint(value_s) and len(value_s) < 40:
                if re.fullmatch(
                    r"(?i)\s*(remote|hybrid|on-?\s*site|onsite|in-?\s*office|wfh).*\s*",
                    value_s,
                ):
                    return mode
    return None


def parse_greenhouse_job_id_from_url(url: str) -> str | None:
    if not url:
        return None
    m = _BOARD_JOBS_IN_PATH.search(url)
    if m:
        return m.group(2)
    m = _JOBS_NUMERIC_PATH.search(url)
    if m:
        return m.group(1)
    m = _GH_JID_QUERY.search(url)
    if m:
        return m.group(1)
    # Embed application URLs: .../embed/job_app?for=board&token=JOBID
    if "greenhouse.io" in url.lower() and "embed" in url.lower():
        m = _GH_EMBED_TOKEN_QUERY.search(url)
        if m:
            return m.group(1)
    return None


def greenhouse_board_tokens_from_url(url: str) -> list[str]:
    if not url:
        return []
    tokens: list[str] = []
    m = _BOARD_JOBS_IN_PATH.search(url)
    if m:
        tokens.append(m.group(1).strip())
    embed_m = _EMBED_FOR_QUERY.search(url)
    if embed_m and "greenhouse.io" in url.lower():
        tok = embed_m.group(1).strip()
        if tok and tok not in tokens:
            tokens.append(tok)
    return tokens


def extract_greenhouse_board_tokens_from_html(html: str | None) -> list[str]:
    if not html:
        return []
    seen: list[str] = []
    for pat in _TOKEN_FROM_HTML_PATTERNS:
        for m in pat.finditer(html):
            tok = m.group(1).strip().rstrip("/")
            if tok and tok not in seen and len(tok) <= 120:
                seen.append(tok)
            if len(seen) >= _MAX_TOKEN_CANDIDATES:
                return seen
    return seen


_GENERIC_HOST_LABELS = frozenset({"www", "careers", "jobs", "job", "apply", "boards", "en", "us"})


def greenhouse_board_tokens_from_domain(url: str) -> list[str]:
    """Board tokens guessed from a company careers domain (``voxel51.com`` -> ``voxel51``).

    Many companies render ``?gh_jid=`` postings with a client-side widget, so
    the board token never appears in the fetched HTML. The token is usually
    the company's domain name.
    """
    if "gh_jid" not in (url or "").lower():
        return []
    host = (urlparse(url).netloc or "").lower().split(":")[0]
    labels = [p for p in host.split(".") if p and p not in _GENERIC_HOST_LABELS]
    if len(labels) < 2 or "greenhouse" in labels:
        return []
    name = labels[-2]
    out = [name]
    if "-" in name:
        out.append(name.replace("-", ""))
    return out


def greenhouse_extraction_token_candidates(url: str, html: str | None) -> list[str]:
    out: list[str] = []
    for t in (
        *greenhouse_board_tokens_from_url(url),
        *extract_greenhouse_board_tokens_from_html(html),
        *greenhouse_board_tokens_from_domain(url),
    ):
        if t not in out:
            out.append(t)
    return out


class GreenhouseBoardExtractor(BaseExtractor):
    """Fetch a single job via Greenhouse boards API, return plain text."""

    def __init__(self, http_service: HTTPService | None = None):
        self._http = http_service or HTTPService()

    @property
    def method(self) -> ExtractionMethod:
        return ExtractionMethod.API_VENDOR

    async def can_extract(self, url: str, html: str | None = None) -> bool:
        jid = parse_greenhouse_job_id_from_url(url)
        if not jid:
            return False
        if greenhouse_board_tokens_from_url(url):
            return True
        # ?gh_jid=N on a careers page strongly implies Greenhouse, even before
        # the HTML loads - let extract() try HTML token discovery.
        if "gh_jid" in (url or "").lower():
            return True
        if html and "greenhouse" in html.lower():
            return True
        return False

    async def extract(self, url: str, html: str | None = None) -> ExtractionResult:
        job_id = parse_greenhouse_job_id_from_url(url)
        if not job_id:
            return ExtractionResult(
                success=False,
                method=self.method,
                error="Could not parse Greenhouse job id from URL",
            )
        tokens = greenhouse_extraction_token_candidates(url, html)
        if not tokens:
            return ExtractionResult(
                success=False,
                method=self.method,
                error="No Greenhouse board token (company slug) found in URL or HTML",
            )
        last_err: str | None = None
        url_tokens = greenhouse_board_tokens_from_url(url)
        native_gone = False
        for board_token in tokens:
            res = await self._fetch_job(board_token, job_id, url)
            if res.success:
                logger.info(
                    "greenhouse_board_api_success",
                    url=url,
                    job_id=job_id,
                    board_token=board_token,
                )
                return res
            last_err = res.error
            if url_tokens and board_token == url_tokens[0]:
                native_gone = res.closed
        return ExtractionResult(
            success=False,
            method=self.method,
            error=last_err or "Greenhouse board API extraction failed",
            closed=native_gone,
        )

    async def _fetch_job(self, board_token: str, job_id: str, source_url: str) -> ExtractionResult:
        api_url = f"{GREENHOUSE_API_BASE}/{board_token}/jobs/{job_id}"
        try:
            text, status_code, _ = await self._http.fetch_json(api_url)
        except Exception as e:
            logger.debug("greenhouse_board_api_fetch_failed", url=api_url, error=str(e))
            return ExtractionResult(
                success=False,
                method=self.method,
                error=str(e),
                closed=http_status_of(e) in GONE_STATUSES,
            )
        if status_code != 200:
            return ExtractionResult(
                success=False,
                method=self.method,
                error=f"Greenhouse API returned {status_code}",
                closed=status_code in GONE_STATUSES,
            )
        try:
            data = json.loads(text)
        except json.JSONDecodeError as e:
            return ExtractionResult(
                success=False,
                method=self.method,
                error=f"Invalid JSON: {e}",
            )
        if not isinstance(data, dict):
            return ExtractionResult(
                success=False,
                method=self.method,
                error="Unexpected Greenhouse API response",
            )

        plain_text = self._job_to_plain_text(data)
        if not plain_text or len(plain_text) < 40:
            return ExtractionResult(
                success=False,
                method=self.method,
                error="Insufficient content from Greenhouse API",
            )

        title = (data.get("title") or "").strip() or None
        company = (
            data.get("company_name").strip()
            if isinstance(data.get("company_name"), str) and data.get("company_name").strip()
            else None
        )
        location = None
        loc = data.get("location")
        if isinstance(loc, dict):
            location = (loc.get("name") or "").strip() or None
        elif isinstance(loc, str) and loc.strip():
            location = loc.strip()

        # Greenhouse has no workplaceType; infer a soft signal from location /
        # custom metadata so the hydrator / MiniLM classifier can resolve mode.
        workplace = None
        if location and normalize_work_mode_hint(location):
            workplace = normalize_work_mode_hint(location)
        else:
            workplace = workplace_from_greenhouse_metadata(data.get("metadata"))

        return ExtractionResult(
            success=True,
            method=self.method,
            raw_content=plain_text,
            structured_data={
                "title": title,
                "company": company,
                "location": location,
                "workplace": workplace,
                "is_remote": workplace == "remote",
            },
        )

    def _job_to_plain_text(self, job: dict) -> str:
        """Convert Greenhouse API job object to readable plain text."""
        parts: list[str] = []

        title = (job.get("title") or "").strip()
        if title:
            parts.append(f"Title: {title}")

        company = job.get("company_name")
        if isinstance(company, str) and company.strip():
            parts.append(f"Company: {company.strip()}")

        loc = job.get("location")
        if isinstance(loc, dict):
            loc_name = (loc.get("name") or "").strip()
            if loc_name:
                parts.append(f"Location: {loc_name}")
        elif isinstance(loc, str) and loc.strip():
            parts.append(f"Location: {loc.strip()}")

        departments = job.get("departments") or []
        if isinstance(departments, list):
            dept_names = [d.get("name") for d in departments if isinstance(d, dict) and d.get("name")]
            if dept_names:
                parts.append(f"Department: {', '.join(dept_names)}")

        offices = job.get("offices") or []
        if isinstance(offices, list):
            office_names = [o.get("name") for o in offices if isinstance(o, dict) and o.get("name")]
            if office_names:
                parts.append(f"Office: {', '.join(office_names)}")

        workplace = None
        loc_name = None
        loc = job.get("location")
        if isinstance(loc, dict):
            loc_name = (loc.get("name") or "").strip() or None
        elif isinstance(loc, str):
            loc_name = loc.strip() or None
        if loc_name:
            workplace = normalize_work_mode_hint(loc_name)
        if not workplace:
            workplace = workplace_from_greenhouse_metadata(job.get("metadata"))
        if workplace:
            parts.append(f"Workplace Type: {workplace}")

        raw_content = job.get("content") or ""
        if isinstance(raw_content, str) and raw_content.strip():
            # Greenhouse Job Board API often returns HTML escaped as entities
            # (&lt;div&gt;...), so unescape before stripping tags.
            decoded = html_lib.unescape(raw_content)
            description = (
                plain_text_from_fragment_html(decoded)
                if "<" in decoded
                else decoded.strip()
            )
            if description:
                parts.append(f"\n{description}")

        return "\n".join(parts)
