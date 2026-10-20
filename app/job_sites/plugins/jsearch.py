"""JSearch (RapidAPI), aggregated LinkedIn / Indeed / Glassdoor / ZipRecruiter listings."""

from __future__ import annotations

from typing import Any

from app.job_sites.base import (
    COUNTRY_NAMES,
    AuthType,
    CredentialField,
    FetchContext,
    JobSitePlugin,
)
from app.job_sites.http import get_json
from app.job_sites.registry import register
from app.services.job_source_boards import BoardJob

DEFAULT_KEYWORDS = "software engineer"
# The original /search endpoint was retired and now answers 404 "Endpoint '/search' does not exist".
SEARCH_URL = "https://jsearch.p.rapidapi.com/search-v2"


def search_country(ctx: FetchContext) -> str:
    code = (ctx.primary_country or "US").lower()
    return "gb" if code == "uk" else code


def result_items(payload: Any) -> list[dict]:
    """Jobs from a v2 payload (``data.jobs``), tolerating the old list-shaped ``data``."""
    data = (payload or {}).get("data") if isinstance(payload, dict) else None
    items = data.get("jobs") if isinstance(data, dict) else data
    return [item for item in items or [] if isinstance(item, dict)]


def search_query(credentials: dict[str, Any], ctx: FetchContext) -> str:
    keywords = " ".join(str(credentials.get("keywords") or "").split()) or DEFAULT_KEYWORDS
    location = COUNTRY_NAMES.get(ctx.primary_country, "United States")
    return f"{keywords} in {location}"


async def _fetch(credentials: dict[str, Any], ctx: FetchContext) -> list[BoardJob]:
    api_key = str(credentials.get("api_key") or "").strip()
    if not api_key:
        raise ValueError("JSearch requires a RapidAPI key.")
    payload = await get_json(
        SEARCH_URL,
        params={
            "query": search_query(credentials, ctx),
            "num_pages": "1",
            "date_posted": "week",
            "country": search_country(ctx),
        },
        headers={
            "X-RapidAPI-Key": api_key,
            "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
        },
    )
    jobs: list[BoardJob] = []
    for item in result_items(payload):
        url = str(item.get("job_apply_link") or item.get("job_google_link") or "").strip()
        title = str(item.get("job_title") or "").strip()
        if not url or not title:
            continue
        location = str(item.get("job_location") or "").strip() or ", ".join(
            p for p in (str(item.get(k) or "").strip() for k in ("job_city", "job_state", "job_country")) if p
        )
        jobs.append(
            BoardJob(
                url=url,
                title=title,
                location=location,
                company=str(item.get("employer_name") or "").strip(),
                description=str(item.get("job_description") or "").strip(),
            )
        )
        if len(jobs) >= ctx.max_jobs:
            break
    return jobs


register(
    JobSitePlugin(
        slug="jsearch",
        name="JSearch",
        blurb="Pull aggregated openings from LinkedIn, Indeed, Glassdoor, and ZipRecruiter via RapidAPI.",
        homepage="https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch",
        signup_url="https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch",
        auth_type=AuthType.API_KEY,
        logo_file="jsearch.svg",
        sort_order=40,
        credential_fields=(
            CredentialField(
                key="api_key",
                label="RapidAPI key",
                placeholder="your X-RapidAPI-Key",
                help_url="https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch",
            ),
            CredentialField(
                key="keywords",
                label="Search keywords",
                placeholder="software engineer",
                secret=False,
                required=False,
                help_text=(
                    "The job title or skills to search for. Jobs come from your preferred country. "
                    "Leave empty to search for software engineer roles."
                ),
            ),
        ),
        fetch=_fetch,
    )
)
