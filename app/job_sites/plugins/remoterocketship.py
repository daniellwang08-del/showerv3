"""RemoteRocketship official Jobs API, personal API key (paid subscription)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from app.job_sites.base import (
    COUNTRY_NAMES,
    AuthType,
    CredentialField,
    FetchContext,
    JobSitePlugin,
)
from app.job_sites.errors import ConnectionConfigError, QuotaExhausted, RateLimited, SessionExpired
from app.job_sites.http import post_json
from app.job_sites.registry import register
from app.services.job_source_boards import BoardJob
from app.services.remoterocketship_search import SearchLinkError, parse_search_link

API_URL = "https://www.remoterocketship.com/api/openclaw/jobs"
SITE = "https://www.remoterocketship.com"
MAX_PER_PAGE = 50


def _next_utc_midnight() -> datetime:
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    return (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)


def _error_message(response: httpx.Response) -> str:
    try:
        body = response.json()
    except Exception:
        return ""
    return str(body.get("message") or "") if isinstance(body, dict) else ""


def _filters(ctx: FetchContext, search_link: str = "") -> dict:
    filters: dict[str, Any] = {}
    if search_link.strip():
        try:
            filters.update(parse_search_link(search_link).api_filters())
        except SearchLinkError as e:
            raise ConnectionConfigError(str(e)) from e
    if not filters.get("locationFilters"):
        filters.pop("locationFilters", None)
        country = COUNTRY_NAMES.get(ctx.primary_country)
        if ctx.country_codes and country:
            filters["locationFilters"] = [country]
    filters.update(
        {
            "page": 1,
            "itemsPerPage": min(MAX_PER_PAGE, ctx.max_jobs),
            # Newest first regardless of the link's sort, so each sync sees new postings.
            "sortBy": "DateAdded",
            "showRemoteJobs": True,
        }
    )
    return filters


def parse_jobs(payload: Any, *, max_jobs: int) -> list[BoardJob]:
    jobs: list[BoardJob] = []
    openings = payload.get("jobOpenings") if isinstance(payload, dict) else None
    for job in openings or []:
        if not isinstance(job, dict):
            continue
        title = str(job.get("roleTitle") or "").strip()
        company = job.get("company") if isinstance(job.get("company"), dict) else {}
        company_slug = str(company.get("slug") or "").strip()
        job_slug = str(job.get("slug") or "").strip()
        listing = f"{SITE}/company/{company_slug}/jobs/{job_slug}" if company_slug and job_slug else ""
        url = str(job.get("url") or "").strip() or listing
        if not url or not title:
            continue
        location = job.get("location") or ""
        if isinstance(location, list):
            location = ", ".join(str(x) for x in location if isinstance(x, str))
        jobs.append(
            BoardJob(
                url=url,
                title=title,
                location=str(location or "Remote").strip(),
                company=str(company.get("name") or "RemoteRocketship").strip(),
                source_url=listing if listing != url else "",
            )
        )
        if len(jobs) >= max_jobs:
            break
    return jobs


async def _fetch(credentials: dict[str, Any], ctx: FetchContext) -> list[BoardJob]:
    api_key = str(credentials.get("api_key") or "").strip()
    if not api_key:
        raise ConnectionConfigError("RemoteRocketship requires an API key.")
    try:
        payload = await post_json(
            API_URL,
            json_body={
                "filters": _filters(ctx, str(credentials.get("search_url") or "")),
                "includeJobDescription": False,
            },
            headers={"Authorization": f"Bearer {api_key}", "RR-API-Version": "1"},
        )
    except httpx.HTTPStatusError as e:
        code = e.response.status_code
        detail = _error_message(e.response)
        if code == 401:
            raise SessionExpired("RemoteRocketship rejected this API key. Generate a new one and reconnect.") from e
        if code == 403:
            raise SessionExpired(
                "RemoteRocketship needs an active subscription for API access. Renew it, then reconnect."
            ) from e
        if code == 429:
            if "daily" in detail.lower():
                raise QuotaExhausted(
                    "RemoteRocketship daily quota reached. Syncing resumes after midnight UTC.",
                    resets_at=_next_utc_midnight(),
                ) from e
            retry = e.response.headers.get("retry-after")
            raise RateLimited(
                "RemoteRocketship is rate limiting requests.",
                retry_after_seconds=float(retry) if retry and retry.isdigit() else None,
            ) from e
        raise
    return parse_jobs(payload, max_jobs=ctx.max_jobs)


register(
    JobSitePlugin(
        slug="remoterocketship",
        name="RemoteRocketship",
        blurb="Sync new remote roles from your saved RemoteRocketship search with your personal API key.",
        homepage=SITE + "/",
        signup_url=SITE + "/developers/",
        auth_type=AuthType.API_KEY,
        logo_file="remoterocketship.svg",
        sort_order=1,
        credential_fields=(
            CredentialField(
                key="api_key",
                label="API key",
                placeholder="Advanced, API access, Generate key",
                help_url=SITE + "/api-docs/",
            ),
            CredentialField(
                key="search_url",
                label="Search link",
                placeholder=SITE + "/remote-jobs/?jobTitle=...&locations=United+States",
                help_url=SITE + "/remote-jobs/",
                secret=False,
                required=False,
                help_text=(
                    "Set your filters on RemoteRocketship (job titles, location, salary, seniority, "
                    "employment type), then paste the address bar link. Without it, sync pulls every "
                    "new remote role in your preferred country."
                ),
            ),
        ),
        fetch=_fetch,
    )
)
