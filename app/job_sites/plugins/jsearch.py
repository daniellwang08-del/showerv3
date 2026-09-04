"""JSearch (RapidAPI) — aggregated LinkedIn / Indeed / Glassdoor / ZipRecruiter listings."""

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


async def _fetch(credentials: dict[str, Any], ctx: FetchContext) -> list[BoardJob]:
    api_key = str(credentials.get("api_key") or "").strip()
    if not api_key:
        raise ValueError("JSearch requires a RapidAPI key.")
    location = COUNTRY_NAMES.get(ctx.primary_country, "United States")
    payload = await get_json(
        "https://jsearch.p.rapidapi.com/search",
        params={
            "query": f"software engineer in {location}",
            "page": "1",
            "num_pages": "1",
            "date_posted": "week",
        },
        headers={
            "X-RapidAPI-Key": api_key,
            "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
        },
    )
    jobs: list[BoardJob] = []
    for item in (payload or {}).get("data") or []:
        if not isinstance(item, dict):
            continue
        url = str(item.get("job_apply_link") or item.get("job_google_link") or "").strip()
        title = str(item.get("job_title") or "").strip()
        if not url or not title:
            continue
        city = str(item.get("job_city") or "").strip()
        country = str(item.get("job_country") or "").strip()
        location = ", ".join(p for p in (city, country) if p)
        jobs.append(
            BoardJob(
                url=url,
                title=title,
                location=location,
                company=str(item.get("employer_name") or "").strip(),
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
        ),
        fetch=_fetch,
    )
)
