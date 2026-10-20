"""Glassdoor via Real-Time Glassdoor Data (OpenWeb Ninja on RapidAPI).

The job search answers ``{status, data: {jobs, cursor}}``. Each request is one
call no matter how many jobs come back, so a sync asks for up to the job
budget in a single page.
"""

from __future__ import annotations

import re
from typing import Any

from app.job_sites.base import (
    COUNTRY_NAMES,
    DEFAULT_SEARCH_KEYWORDS,
    AuthType,
    CredentialField,
    FetchContext,
    JobSitePlugin,
)
from app.job_sites.errors import ConnectionConfigError
from app.job_sites.html_fetch import html_to_text
from app.job_sites.rapidapi import rapidapi_key_field, rapidapi_request, require_key
from app.job_sites.registry import register
from app.services.job_source_boards import BoardJob

HOST = "real-time-glassdoor-data.p.rapidapi.com"
LISTING_URL = "https://rapidapi.com/letscrape-6bRBa3QguO5/api/real-time-glassdoor-data"
API_NAME = "Real-Time Glassdoor Data"
_REMOTE_WORD = re.compile(r"\bremote\b", re.IGNORECASE)

DOMAINS = {
    "US": "www.glassdoor.com",
    "GB": "www.glassdoor.co.uk",
    "UK": "www.glassdoor.co.uk",
    "CA": "www.glassdoor.ca",
    "AU": "www.glassdoor.com.au",
    "DE": "www.glassdoor.de",
    "FR": "www.glassdoor.fr",
    "NL": "www.glassdoor.nl",
    "IN": "www.glassdoor.co.in",
    "SG": "www.glassdoor.sg",
    "IE": "www.glassdoor.ie",
    "NZ": "www.glassdoor.co.nz",
}


def _text(value: Any) -> str:
    return str(value or "").strip()


def search_params(credentials: dict[str, Any], ctx: FetchContext) -> dict[str, str]:
    raw = " ".join(str(credentials.get("keywords") or "").split()) or DEFAULT_SEARCH_KEYWORDS
    remote = bool(_REMOTE_WORD.search(raw))
    country = ctx.primary_country
    return {
        "query": " ".join(_REMOTE_WORD.sub(" ", raw).split()) or raw,
        "location": COUNTRY_NAMES.get(country, "United States"),
        "location_type": "COUNTRY",
        "date_posted": "3days",
        "remote_only": "true" if remote else "false",
        "limit": str(max(1, min(ctx.max_jobs, 100))),
        "domain": DOMAINS.get(country, "www.glassdoor.com"),
    }


def to_board_job(item: dict) -> BoardJob | None:
    listing = _text(item.get("job_link") or item.get("job_url"))
    apply = _text(item.get("job_apply_link") or item.get("apply_link"))
    title = _text(item.get("job_title") or item.get("title"))
    url = apply if apply.startswith("http") else listing
    if not url or not title:
        return None
    raw_description = _text(item.get("job_description") or item.get("description"))
    description = html_to_text(raw_description) if "<" in raw_description else raw_description
    location = _text(item.get("location_name") or item.get("location"))
    if item.get("is_remote") is True and "remote" not in location.lower():
        location = f"{location} | Remote" if location else "Remote"
    return BoardJob(
        url=url,
        title=title,
        company=_text(item.get("company_name") or item.get("employer_name")),
        location=location,
        source_url=listing if url != listing else "",
        description=description[:60000],
    )


async def _fetch(credentials: dict[str, Any], ctx: FetchContext) -> list[BoardJob]:
    payload = await rapidapi_request(
        "GET",
        HOST,
        "/job-search",
        api_key=require_key(credentials, "Glassdoor"),
        api_name=API_NAME,
        listing_url=LISTING_URL,
        params=search_params(credentials, ctx),
    )
    if isinstance(payload, dict) and _text(payload.get("status")).upper() == "ERROR":
        error = payload.get("error") or {}
        message = _text(error.get("message") if isinstance(error, dict) else error) or "search failed"
        raise ConnectionConfigError(f"{API_NAME}: {message}")
    data = (payload or {}).get("data") if isinstance(payload, dict) else None
    items = data.get("jobs") if isinstance(data, dict) else data
    jobs: list[BoardJob] = []
    seen: set[str] = set()
    for item in items or []:
        job = to_board_job(item) if isinstance(item, dict) else None
        if job is None or job.url in seen:
            continue
        seen.add(job.url)
        jobs.append(job)
        if len(jobs) >= ctx.max_jobs:
            break
    return jobs


register(
    JobSitePlugin(
        slug="glassdoor",
        name="Glassdoor",
        blurb="Glassdoor jobs from the last few days via OpenWeb Ninja's Real-Time Glassdoor Data API on RapidAPI.",
        homepage=LISTING_URL,
        signup_url=LISTING_URL,
        auth_type=AuthType.API_KEY,
        logo_file="glassdoor.svg",
        sort_order=44,
        verify_max_jobs=3,
        credential_fields=(
            rapidapi_key_field(LISTING_URL),
            CredentialField(
                key="keywords",
                label="Search keywords",
                placeholder=DEFAULT_SEARCH_KEYWORDS,
                default=DEFAULT_SEARCH_KEYWORDS,
                secret=False,
                required=False,
                help_text=(
                    "The job title or skills to search for. Include \"remote\" to keep only remote jobs. "
                    "Jobs come from Glassdoor in your first preferred country."
                ),
            ),
        ),
        fetch=_fetch,
    )
)
