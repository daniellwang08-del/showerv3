"""USAJOBS official search API, free Authorization-Key."""

from __future__ import annotations

from typing import Any

from app.job_sites.base import AuthType, CredentialField, FetchContext, JobSitePlugin
from app.job_sites.http import get_json
from app.job_sites.registry import register
from app.services.job_source_boards import BoardJob


async def _fetch(credentials: dict[str, Any], ctx: FetchContext) -> list[BoardJob]:
    api_key = str(credentials.get("api_key") or "").strip()
    if not api_key:
        raise ValueError("USAJOBS requires an Authorization-Key from developer.usajobs.gov.")
    email = str(credentials.get("email") or ctx.user_email or "").strip()
    if not email:
        raise ValueError("USAJOBS requires the email you registered the API key with.")
    payload = await get_json(
        "https://data.usajobs.gov/api/search",
        params={
            "ResultsPerPage": min(50, ctx.max_jobs),
            "SortField": "opendate",
            "SortDirection": "desc",
            "DatePosted": 7,
        },
        headers={
            "Host": "data.usajobs.gov",
            "User-Agent": email,
            "Authorization-Key": api_key,
        },
    )
    search = (payload or {}).get("SearchResult") or {}
    items = search.get("SearchResultItems") or []
    jobs: list[BoardJob] = []
    for wrap in items:
        if not isinstance(wrap, dict):
            continue
        descriptor = wrap.get("MatchedObjectDescriptor") or wrap
        if not isinstance(descriptor, dict):
            continue
        apply = descriptor.get("ApplyURI") or []
        url = ""
        if isinstance(apply, list) and apply:
            url = str(apply[0] or "").strip()
        if not url:
            url = str(descriptor.get("PositionURI") or "").strip()
        title = str(descriptor.get("PositionTitle") or "").strip()
        if not url or not title:
            continue
        location = ""
        locs = descriptor.get("PositionLocationDisplay")
        if isinstance(locs, str):
            location = locs
        jobs.append(
            BoardJob(
                url=url,
                title=title,
                location=location.strip(),
                company=str(descriptor.get("OrganizationName") or "USAJOBS").strip(),
            )
        )
        if len(jobs) >= ctx.max_jobs:
            break
    return jobs


register(
    JobSitePlugin(
        slug="usajobs",
        name="USAJOBS",
        blurb="US federal openings via the official USAJOBS Job Search API.",
        homepage="https://www.usajobs.gov/",
        signup_url="https://developer.usajobs.gov/",
        auth_type=AuthType.API_KEY,
        logo_file="usajobs.svg",
        sort_order=80,
        credential_fields=(
            CredentialField(
                key="api_key",
                label="Authorization-Key",
                placeholder="USAJOBS API key",
                help_url="https://developer.usajobs.gov/",
            ),
            CredentialField(
                key="email",
                label="Registered email",
                placeholder="email used on developer.usajobs.gov",
                help_url="https://developer.usajobs.gov/",
                secret=False,
            ),
        ),
        fetch=_fetch,
    )
)
