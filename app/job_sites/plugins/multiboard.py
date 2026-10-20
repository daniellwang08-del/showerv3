"""Multi-board search (JOBS SEARCH API on RapidAPI): Indeed, LinkedIn, ZipRecruiter and Glassdoor in one call.

The API runs JobSpy for each requested site, so ``results_wanted`` is per site
and the reply is JobSpy's job rows under ``jobs``. Rows come from a pandas
frame, so missing values can arrive as NaN.
"""

from __future__ import annotations

import math
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
from app.job_sites.rapidapi import rapidapi_key_field, rapidapi_request, require_key
from app.job_sites.registry import register
from app.services.job_source_boards import BoardJob

HOST = "jobs-search-api.p.rapidapi.com"
LISTING_URL = "https://rapidapi.com/rphrp1985/api/jobs-search-api"
API_NAME = "JOBS SEARCH API"
_REMOTE_WORD = re.compile(r"\bremote\b", re.IGNORECASE)

# JobSpy's Indeed/Glassdoor country names for our preference codes.
INDEED_COUNTRIES = {
    "US": "USA",
    "GB": "UK",
    "UK": "UK",
    "CA": "Canada",
    "AU": "Australia",
    "DE": "Germany",
    "FR": "France",
    "NL": "Netherlands",
    "IN": "India",
    "SG": "Singapore",
    "IE": "Ireland",
    "NZ": "New Zealand",
}
# ZipRecruiter only lists jobs in the US and Canada.
ZIP_COUNTRIES = {"US", "CA"}


def _text(value: Any) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return ""
    return str(value).strip()


def search_body(credentials: dict[str, Any], ctx: FetchContext) -> dict[str, Any]:
    raw = " ".join(str(credentials.get("keywords") or "").split()) or DEFAULT_SEARCH_KEYWORDS
    remote = bool(_REMOTE_WORD.search(raw))
    term = " ".join(_REMOTE_WORD.sub(" ", raw).split()) or raw
    country = ctx.primary_country
    sites = ["indeed", "linkedin", "glassdoor"]
    if country in ZIP_COUNTRIES:
        sites.insert(2, "zip_recruiter")
    return {
        "search_term": term,
        "location": COUNTRY_NAMES.get(country, "United States"),
        "country_indeed": INDEED_COUNTRIES.get(country, "USA"),
        "site_name": sites,
        "results_wanted": max(5, math.ceil(ctx.max_jobs / len(sites)) + 2),
        "hours_old": 24,
        "is_remote": remote,
        "linkedin_fetch_description": True,
        "description_format": "markdown",
    }


def to_board_job(item: dict) -> BoardJob | None:
    listing = _text(item.get("job_url"))
    direct = _text(item.get("job_url_direct"))
    url = direct or listing
    title = _text(item.get("title"))
    if not url or not title:
        return None
    location = _text(item.get("location"))
    if item.get("is_remote") is True and "remote" not in location.lower():
        location = f"{location} | Remote" if location else "Remote"
    return BoardJob(
        url=url,
        title=title,
        company=_text(item.get("company")),
        location=location,
        source_url=listing if direct and listing != direct else "",
        description=_text(item.get("description")),
    )


def result_items(payload: Any) -> list[dict]:
    if isinstance(payload, list):
        items = payload
    elif isinstance(payload, dict):
        items = payload.get("jobs")
        if items is None and isinstance(payload.get("data"), (list, dict)):
            data = payload["data"]
            items = data.get("jobs") if isinstance(data, dict) else data
    else:
        items = None
    return [i for i in items or [] if isinstance(i, dict)]


async def _fetch(credentials: dict[str, Any], ctx: FetchContext) -> list[BoardJob]:
    payload = await rapidapi_request(
        "POST",
        HOST,
        "/getjobs",
        api_key=require_key(credentials, "Multi-board search"),
        api_name=API_NAME,
        listing_url=LISTING_URL,
        json_body=search_body(credentials, ctx),
        timeout_seconds=150,
    )
    jobs: list[BoardJob] = []
    seen: set[str] = set()
    for item in result_items(payload):
        job = to_board_job(item)
        if job is None or job.url in seen:
            continue
        seen.add(job.url)
        jobs.append(job)
        if len(jobs) >= ctx.max_jobs:
            break
    return jobs


register(
    JobSitePlugin(
        slug="multiboard",
        name="Multi-Board Search",
        blurb=(
            "Search Indeed, LinkedIn, ZipRecruiter and Glassdoor together for jobs posted in the last 24 hours, "
            "via JOBS SEARCH API on RapidAPI."
        ),
        homepage=LISTING_URL,
        signup_url=LISTING_URL,
        auth_type=AuthType.API_KEY,
        logo_file="multiboard.svg",
        sort_order=45,
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
                    "Jobs come from your first preferred country."
                ),
            ),
        ),
        fetch=_fetch,
    )
)
