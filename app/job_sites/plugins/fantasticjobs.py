"""Fantastic.jobs on RapidAPI: LinkedIn Job Search API and Active Jobs DB (company career sites).

Both feeds are indexed hourly and share one query language. ``title`` is
Google-style (space means AND), so "remote" is lifted out of the keywords into
the ``ai_work_arrangement`` filter instead of being required in the job title.
Every job returned costs one job credit, so each sync asks for a 24-hour
window capped at the sync's job budget.

The v1 API takes ``/active-jb?time_frame=24h``; listings that still run the
previous release answer 404 there and serve ``/active-jb-24h`` with
``*_filter`` parameter names instead.
"""

from __future__ import annotations

import re
from typing import Any

import httpx

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

REMOTE_ARRANGEMENTS = "Remote OK,Remote Solely"
_REMOTE_WORD = re.compile(r"\bremote\b", re.IGNORECASE)


def split_keywords(credentials: dict[str, Any]) -> tuple[str, bool]:
    """(title query, remote only) from the user's keywords."""
    raw = " ".join(str(credentials.get("keywords") or "").split()) or DEFAULT_SEARCH_KEYWORDS
    remote = bool(_REMOTE_WORD.search(raw))
    title = " ".join(_REMOTE_WORD.sub(" ", raw).split())
    return title, remote


def location_query(ctx: FetchContext) -> str:
    names: list[str] = []
    for code in ctx.country_codes or ("US",):
        name = COUNTRY_NAMES.get(code.upper())
        if name and name not in names:
            names.append(name)
    return " OR ".join(f'"{n}"' for n in names or ["United States"])


def _text(value: Any) -> str:
    return str(value or "").strip()


def to_board_job(item: dict) -> BoardJob | None:
    url = _text(item.get("url"))
    title = _text(item.get("title"))
    if not url or not title:
        return None
    places = [p for p in (_text(x) for x in item.get("locations_derived") or []) if p]
    arrangement = _text(item.get("ai_work_arrangement"))
    if not arrangement and item.get("remote_derived"):
        arrangement = "Remote"
    location = "; ".join(places[:3])
    if arrangement:
        location = f"{location} | {arrangement}" if location else arrangement
    return BoardJob(
        url=url,
        title=title,
        company=_text(item.get("organization")),
        location=location,
        description=_text(item.get("description_text")),
    )


def make_fetch(*, host: str, path: str, api_name: str, listing_url: str):
    async def fetch(credentials: dict[str, Any], ctx: FetchContext) -> list[BoardJob]:
        key = require_key(credentials, api_name)
        title, remote = split_keywords(credentials)
        limit = str(max(1, min(ctx.max_jobs, 100)))
        params: dict[str, str] = {
            "time_frame": "24h",
            "title": title,
            "location": location_query(ctx),
            "description_format": "text",
            "limit": limit,
            "offset": "0",
        }
        if remote:
            params["ai_work_arrangement"] = REMOTE_ARRANGEMENTS
        try:
            payload = await rapidapi_request(
                "GET", host, path, api_key=key, api_name=api_name, listing_url=listing_url, params=params
            )
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code != 404:
                raise
            legacy = {
                "title_filter": f'"{title}"' if title else "",
                "location_filter": params["location"],
                "description_type": "text",
                "limit": limit,
                "offset": "0",
            }
            if remote:
                legacy["remote"] = "true"
            payload = await rapidapi_request(
                "GET",
                host,
                f"{path}-24h",
                api_key=key,
                api_name=api_name,
                listing_url=listing_url,
                params={k: v for k, v in legacy.items() if v},
            )
        items = payload if isinstance(payload, list) else (payload or {}).get("data") or []
        jobs: list[BoardJob] = []
        seen: set[str] = set()
        for item in items:
            job = to_board_job(item) if isinstance(item, dict) else None
            if job is None or job.url in seen:
                continue
            seen.add(job.url)
            jobs.append(job)
            if len(jobs) >= ctx.max_jobs:
                break
        return jobs

    return fetch


def _keywords_field(what: str) -> CredentialField:
    return CredentialField(
        key="keywords",
        label="Job title keywords",
        placeholder=DEFAULT_SEARCH_KEYWORDS,
        default=DEFAULT_SEARCH_KEYWORDS,
        secret=False,
        required=False,
        help_text=(
            f"Words that must all appear in the {what} job title. Include \"remote\" to keep only remote "
            "jobs. Jobs come from your preferred countries, posted in the last 24 hours."
        ),
    )


LINKEDIN_LISTING = "https://rapidapi.com/fantastic-jobs-fantastic-jobs-default/api/linkedin-job-search-api"
ATS_LISTING = "https://rapidapi.com/fantastic-jobs-fantastic-jobs-default/api/active-jobs-db"

register(
    JobSitePlugin(
        slug="linkedin",
        name="LinkedIn",
        blurb="New LinkedIn jobs every hour (plus Wellfound and Y Combinator) via the Fantastic.jobs LinkedIn API on RapidAPI.",
        homepage=LINKEDIN_LISTING,
        signup_url=LINKEDIN_LISTING,
        auth_type=AuthType.API_KEY,
        logo_file="linkedin.svg",
        sort_order=41,
        min_sync_hours=8.0,
        verify_max_jobs=3,
        credential_fields=(rapidapi_key_field(LINKEDIN_LISTING), _keywords_field("LinkedIn")),
        fetch=make_fetch(
            host="linkedin-job-search-api.p.rapidapi.com",
            path="/active-jb",
            api_name="LinkedIn Job Search API",
            listing_url=LINKEDIN_LISTING,
        ),
    )
)

register(
    JobSitePlugin(
        slug="careersites",
        name="Company Career Sites",
        blurb=(
            "Jobs posted straight on employer career pages (Greenhouse, Lever, Workday, Ashby and 50+ more) "
            "via Active Jobs DB on RapidAPI. Links go to the employer's own application."
        ),
        homepage=ATS_LISTING,
        signup_url=ATS_LISTING,
        auth_type=AuthType.API_KEY,
        logo_file="careersites.svg",
        sort_order=42,
        min_sync_hours=8.0,
        verify_max_jobs=3,
        credential_fields=(rapidapi_key_field(ATS_LISTING), _keywords_field("career-site")),
        fetch=make_fetch(
            host="active-jobs-db.p.rapidapi.com",
            path="/active-ats",
            api_name="Active Jobs DB",
            listing_url=ATS_LISTING,
        ),
    )
)
