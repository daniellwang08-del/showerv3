"""Reed.co.uk publisher API, API key as HTTP Basic username."""

from __future__ import annotations

from typing import Any

from app.job_sites.base import AuthType, CredentialField, FetchContext, JobSitePlugin
from app.job_sites.http import get_json
from app.job_sites.registry import register
from app.services.job_source_boards import BoardJob


async def _fetch(credentials: dict[str, Any], ctx: FetchContext) -> list[BoardJob]:
    api_key = str(credentials.get("api_key") or "").strip()
    if not api_key:
        raise ValueError("Reed requires an API key.")
    payload = await get_json(
        "https://www.reed.co.uk/api/1.0/search",
        params={
            "keywords": "software engineer",
            "resultsToTake": min(50, ctx.max_jobs),
        },
        auth=(api_key, ""),
    )
    jobs: list[BoardJob] = []
    for item in (payload or {}).get("results") or []:
        if not isinstance(item, dict):
            continue
        url = str(item.get("jobUrl") or item.get("externalUrl") or "").strip()
        title = str(item.get("jobTitle") or "").strip()
        if not url or not title:
            continue
        jobs.append(
            BoardJob(
                url=url,
                title=title,
                location=str(item.get("locationName") or "").strip(),
                company=str(item.get("employerName") or "").strip(),
            )
        )
        if len(jobs) >= ctx.max_jobs:
            break
    return jobs


register(
    JobSitePlugin(
        slug="reed",
        name="Reed",
        blurb="Pull UK roles from Reed with your developer API key.",
        homepage="https://www.reed.co.uk/",
        signup_url="https://www.reed.co.uk/developers",
        auth_type=AuthType.API_KEY,
        logo_file="reed.svg",
        sort_order=70,
        credential_fields=(
            CredentialField(
                key="api_key",
                label="API key",
                placeholder="your Reed API key",
                help_url="https://www.reed.co.uk/developers",
            ),
        ),
        fetch=_fetch,
    )
)
