"""Jooble Jobs API — user API key, POST search."""

from __future__ import annotations

from typing import Any

from app.job_sites.base import (
    COUNTRY_NAMES,
    AuthType,
    CredentialField,
    FetchContext,
    JobSitePlugin,
)
from app.job_sites.http import post_json
from app.job_sites.registry import register
from app.services.job_source_boards import BoardJob


async def _fetch(credentials: dict[str, Any], ctx: FetchContext) -> list[BoardJob]:
    api_key = str(credentials.get("api_key") or "").strip()
    if not api_key:
        raise ValueError("Jooble requires an API key.")
    payload = await post_json(
        f"https://jooble.org/api/{api_key}",
        json_body={
            "keywords": "software engineer",
            "location": COUNTRY_NAMES.get(ctx.primary_country, ""),
            "page": 1,
        },
    )
    jobs: list[BoardJob] = []
    for item in (payload or {}).get("jobs") or []:
        if not isinstance(item, dict):
            continue
        url = str(item.get("link") or item.get("url") or "").strip()
        title = str(item.get("title") or "").strip()
        if not url or not title:
            continue
        jobs.append(
            BoardJob(
                url=url,
                title=title,
                location=str(item.get("location") or "").strip(),
                company=str(item.get("company") or "").strip(),
            )
        )
        if len(jobs) >= ctx.max_jobs:
            break
    return jobs


register(
    JobSitePlugin(
        slug="jooble",
        name="Jooble",
        blurb="Search Jooble's multi-country index with your API key.",
        homepage="https://jooble.org/",
        signup_url="https://jooble.org/api/about",
        auth_type=AuthType.API_KEY,
        logo_file="jooble.svg",
        sort_order=60,
        credential_fields=(
            CredentialField(
                key="api_key",
                label="API key",
                placeholder="your Jooble API key",
                help_url="https://jooble.org/api/about",
            ),
        ),
        fetch=_fetch,
    )
)
