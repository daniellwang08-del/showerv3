"""Adzuna Job Search API — user developer app id + key."""

from __future__ import annotations

from typing import Any

from app.job_sites.base import (
    COUNTRY_TO_ADZUNA,
    AuthType,
    CredentialField,
    FetchContext,
    JobSitePlugin,
)
from app.job_sites.http import get_json
from app.job_sites.registry import register
from app.services.job_source_boards import BoardJob


async def _fetch(credentials: dict[str, Any], ctx: FetchContext) -> list[BoardJob]:
    app_id = str(credentials.get("app_id") or "").strip()
    app_key = str(credentials.get("app_key") or "").strip()
    if not app_id or not app_key:
        raise ValueError("Adzuna requires both App ID and App Key.")
    country = COUNTRY_TO_ADZUNA.get(ctx.primary_country, "us")
    payload = await get_json(
        f"https://api.adzuna.com/v1/api/jobs/{country}/search/1",
        params={
            "app_id": app_id,
            "app_key": app_key,
            "results_per_page": min(50, ctx.max_jobs),
            "sort_by": "date",
        },
    )
    jobs: list[BoardJob] = []
    for item in (payload or {}).get("results") or []:
        if not isinstance(item, dict):
            continue
        url = str(item.get("redirect_url") or item.get("adref") or "").strip()
        title = str(item.get("title") or "").strip()
        if not url or not title:
            continue
        company = ""
        co = item.get("company")
        if isinstance(co, dict):
            company = str(co.get("display_name") or "")
        location = ""
        loc = item.get("location")
        if isinstance(loc, dict):
            location = str(loc.get("display_name") or "")
        jobs.append(
            BoardJob(url=url, title=title, location=location.strip(), company=company.strip())
        )
        if len(jobs) >= ctx.max_jobs:
            break
    return jobs


register(
    JobSitePlugin(
        slug="adzuna",
        name="Adzuna",
        blurb="Search jobs across Adzuna with your free developer App ID and Key.",
        homepage="https://www.adzuna.com/",
        signup_url="https://developer.adzuna.com/signup",
        auth_type=AuthType.API_KEY,
        logo_file="adzuna.svg",
        sort_order=30,
        credential_fields=(
            CredentialField(
                key="app_id",
                label="App ID",
                placeholder="your Adzuna app id",
                help_url="https://developer.adzuna.com/signup",
                secret=False,
            ),
            CredentialField(
                key="app_key",
                label="App Key",
                placeholder="your Adzuna app key",
                help_url="https://developer.adzuna.com/docs",
            ),
        ),
        fetch=_fetch,
    )
)
