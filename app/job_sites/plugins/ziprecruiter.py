"""ZipRecruiter Publisher Search API — user-supplied publisher key."""

from __future__ import annotations

from typing import Any

from app.job_sites.base import AuthType, CredentialField, FetchContext, JobSitePlugin
from app.job_sites.http import get_json
from app.job_sites.registry import register
from app.services.job_source_boards import BoardJob


async def _fetch(credentials: dict[str, Any], ctx: FetchContext) -> list[BoardJob]:
    api_key = str(credentials.get("api_key") or "").strip()
    if not api_key:
        raise ValueError("ZipRecruiter requires a publisher API key.")
    payload = await get_json(
        "https://api.ziprecruiter.com/jobs/v1",
        params={
            "search": "software engineer",
            "location": "Remote, US" if ctx.primary_country == "US" else ctx.primary_country,
            "radius_miles": 5000,
            "days_ago": 14,
            "jobs_per_page": min(50, ctx.max_jobs),
            "page": 1,
            "api_key": api_key,
        },
    )
    jobs: list[BoardJob] = []
    for item in (payload or {}).get("jobs") or []:
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or "").strip()
        title = str(item.get("name") or item.get("title") or "").strip()
        if not url or not title:
            continue
        company = ""
        hiring = item.get("hiring_company")
        if isinstance(hiring, dict):
            company = str(hiring.get("name") or "")
        jobs.append(
            BoardJob(
                url=url,
                title=title,
                location=str(item.get("location") or "").strip(),
                company=company.strip(),
            )
        )
        if len(jobs) >= ctx.max_jobs:
            break
    return jobs


register(
    JobSitePlugin(
        slug="ziprecruiter",
        name="ZipRecruiter",
        blurb="Pull listings with a ZipRecruiter publisher Search API key.",
        homepage="https://www.ziprecruiter.com/",
        signup_url="https://www.ziprecruiter.com/publishers",
        auth_type=AuthType.API_KEY,
        logo_file="ziprecruiter.svg",
        sort_order=50,
        credential_fields=(
            CredentialField(
                key="api_key",
                label="Publisher API key",
                placeholder="your ZipRecruiter publisher key",
                help_url="https://www.ziprecruiter.com/publishers",
            ),
        ),
        fetch=_fetch,
    )
)
