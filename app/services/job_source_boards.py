"""Per-user job sources: ATS board detection + listing fetch.

A "job source" is a company job board URL a user registers (Greenhouse,
Lever, Ashby, or Workable). All four vendors expose public, keyless JSON
APIs that return every open posting for a board, so syncing a source is one
HTTP request, no scraping or browser rendering.

The existing extractors in ``app/extractors`` fetch ONE job given its URL;
this module fetches the LIST of posting URLs for a board. Discovered URLs
are then fed through the normal submit/extract pipeline.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from urllib.parse import urlparse

import httpx

from app.core.logging import get_logger

logger = get_logger(__name__)

SUPPORTED_ATS = ("greenhouse", "lever", "ashby", "workable")

_TIMEOUT = httpx.Timeout(25.0)
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
    ),
    "Accept": "application/json",
}

# Board root URL patterns → (ats_type, token). Tokens are company slugs.
_GREENHOUSE_RE = re.compile(
    r"(?:boards|job-boards)\.(?:greenhouse\.io|eu\.greenhouse\.io)/([A-Za-z0-9_-]+)",
    re.IGNORECASE,
)
_GREENHOUSE_API_RE = re.compile(
    r"boards-api\.greenhouse\.io/v1/boards/([A-Za-z0-9_-]+)", re.IGNORECASE
)
_LEVER_RE = re.compile(r"jobs\.(?:eu\.)?lever\.co/([A-Za-z0-9_.-]+)", re.IGNORECASE)
_ASHBY_RE = re.compile(r"jobs\.ashbyhq\.com/([A-Za-z0-9_.%-]+)", re.IGNORECASE)
_WORKABLE_RE = re.compile(r"apply\.workable\.com/([A-Za-z0-9_-]+)", re.IGNORECASE)


@dataclass
class BoardInfo:
    ats_type: str
    token: str


@dataclass
class BoardJob:
    url: str
    title: str = ""
    location: str = ""
    company: str = ""
    # The board's own listing page when ``url`` is the employer's posting;
    # boards that require attribution link back here.
    source_url: str = ""


@dataclass
class BoardListing:
    jobs: list[BoardJob] = field(default_factory=list)
    company: str = ""


def detect_board(url: str) -> BoardInfo | None:
    """Identify the ATS + board token from a user-submitted board URL.

    Accepts board roots and individual posting URLs (the token part is the
    same). Returns None for unsupported hosts.
    """
    if not url or not url.strip():
        return None
    text = url.strip()
    if "://" not in text:
        text = f"https://{text}"
    try:
        parsed = urlparse(text)
    except ValueError:
        return None
    haystack = f"{parsed.netloc}{parsed.path}"

    m = _GREENHOUSE_RE.search(haystack) or _GREENHOUSE_API_RE.search(haystack)
    if m:
        token = m.group(1)
        if token.lower() not in ("embed",):
            return BoardInfo("greenhouse", token)
    m = _LEVER_RE.search(haystack)
    if m:
        return BoardInfo("lever", m.group(1))
    m = _ASHBY_RE.search(haystack)
    if m:
        return BoardInfo("ashby", m.group(1))
    m = _WORKABLE_RE.search(haystack)
    if m:
        token = m.group(1)
        if token.lower() not in ("api", "j"):
            return BoardInfo("workable", token)
    return None


async def _get_json(url: str, params: dict | None = None) -> dict | list:
    async with httpx.AsyncClient(
        timeout=_TIMEOUT, headers=_HEADERS, follow_redirects=True
    ) as client:
        response = await client.get(url, params=params)
        response.raise_for_status()
        return response.json()


def _parse_greenhouse(payload: dict, token: str) -> BoardListing:
    listing = BoardListing(company=token)
    for job in payload.get("jobs") or []:
        if not isinstance(job, dict):
            continue
        url = str(job.get("absolute_url") or "").strip()
        if not url:
            continue
        location = ""
        loc = job.get("location")
        if isinstance(loc, dict):
            location = str(loc.get("name") or "")
        listing.jobs.append(
            BoardJob(
                url=url,
                title=str(job.get("title") or "").strip(),
                location=location.strip(),
                company=str(job.get("company_name") or token).strip(),
            )
        )
    return listing


def _parse_lever(payload: list, token: str) -> BoardListing:
    listing = BoardListing(company=token)
    for job in payload or []:
        if not isinstance(job, dict):
            continue
        url = str(job.get("hostedUrl") or "").strip()
        if not url:
            continue
        categories = job.get("categories") or {}
        location = ""
        if isinstance(categories, dict):
            location = str(categories.get("location") or "")
        listing.jobs.append(
            BoardJob(
                url=url,
                title=str(job.get("text") or "").strip(),
                location=location.strip(),
                company=token,
            )
        )
    return listing


def _parse_ashby(payload: dict, token: str) -> BoardListing:
    company = str(payload.get("name") or token).strip()
    listing = BoardListing(company=company)
    for job in payload.get("jobs") or []:
        if not isinstance(job, dict):
            continue
        url = str(job.get("jobUrl") or job.get("applyUrl") or "").strip()
        if not url:
            continue
        listing.jobs.append(
            BoardJob(
                url=url,
                title=str(job.get("title") or "").strip(),
                location=str(job.get("location") or "").strip(),
                company=company,
            )
        )
    return listing


def _parse_workable(payload: dict, token: str) -> BoardListing:
    company = str(payload.get("name") or token).strip()
    listing = BoardListing(company=company)
    for job in payload.get("jobs") or []:
        if not isinstance(job, dict):
            continue
        url = str(job.get("url") or "").strip()
        if not url:
            shortcode = str(job.get("shortcode") or "").strip()
            if shortcode:
                url = f"https://apply.workable.com/{token}/j/{shortcode}/"
        if not url:
            continue
        city = str(job.get("city") or "").strip()
        country = str(job.get("country") or "").strip()
        location = ", ".join(p for p in (city, country) if p)
        listing.jobs.append(
            BoardJob(
                url=url,
                title=str(job.get("title") or "").strip(),
                location=location,
                company=company,
            )
        )
    return listing


async def fetch_board_listing(ats_type: str, token: str) -> BoardListing:
    """Fetch all open postings for a board. Raises on HTTP/parse errors."""
    if ats_type == "greenhouse":
        payload = await _get_json(
            f"https://boards-api.greenhouse.io/v1/boards/{token}/jobs"
        )
        return _parse_greenhouse(payload if isinstance(payload, dict) else {}, token)
    if ats_type == "lever":
        payload = await _get_json(
            f"https://api.lever.co/v0/postings/{token}", params={"mode": "json"}
        )
        return _parse_lever(payload if isinstance(payload, list) else [], token)
    if ats_type == "ashby":
        payload = await _get_json(
            f"https://api.ashbyhq.com/posting-api/job-board/{token}"
        )
        return _parse_ashby(payload if isinstance(payload, dict) else {}, token)
    if ats_type == "workable":
        payload = await _get_json(
            f"https://apply.workable.com/api/v1/widget/accounts/{token}",
            params={"details": "false"},
        )
        return _parse_workable(payload if isinstance(payload, dict) else {}, token)
    raise ValueError(f"Unsupported ATS type: {ats_type}")
