"""Real-Time LinkedIn Scraper API (RockApis on RapidAPI).

Search results carry no description, so each kept job costs one more credit
for ``/get-job-details``, which also gives the employer's own apply link when
the job is not Easy Apply. Detail calls are capped per sync; a job whose
detail call fails is kept with its LinkedIn link.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any

from app.job_sites.base import (
    DEFAULT_SEARCH_KEYWORDS,
    AuthType,
    CredentialField,
    FetchContext,
    JobSitePlugin,
)
from app.job_sites.errors import ConnectionConfigError, SessionExpired
from app.job_sites.rapidapi import rapidapi_key_field, rapidapi_request, require_key
from app.job_sites.registry import register
from app.services.job_source_boards import BoardJob

HOST = "linkedin-data-api.p.rapidapi.com"
LISTING_URL = "https://rapidapi.com/rockapis-rockapis-default/api/linkedin-data-api"
API_NAME = "Real-Time LinkedIn Scraper API"
MAX_DETAIL_CALLS = 15
_REMOTE_WORD = re.compile(r"\bremote\b", re.IGNORECASE)

# LinkedIn geo ids (urn:li:geo:<id>) for our country preference codes.
GEO_IDS = {
    "US": "103644278",
    "GB": "101165590",
    "UK": "101165590",
    "CA": "101174742",
    "AU": "101452733",
    "DE": "101282230",
    "FR": "105015875",
    "NL": "102890719",
    "IN": "102713980",
    "SG": "102454443",
    "IE": "104738515",
    "NZ": "105490917",
}
WORLDWIDE = "92000000"


def _text(value: Any) -> str:
    return str(value or "").strip()


def search_params(credentials: dict[str, Any], ctx: FetchContext) -> dict[str, str]:
    raw = " ".join(str(credentials.get("keywords") or "").split()) or DEFAULT_SEARCH_KEYWORDS
    remote = bool(_REMOTE_WORD.search(raw))
    params = {
        "keywords": " ".join(_REMOTE_WORD.sub(" ", raw).split()) or raw,
        "locationId": GEO_IDS.get(ctx.primary_country, WORLDWIDE),
        "datePosted": "past24Hours",
        "sort": "mostRecent",
        "start": "0",
    }
    if remote:
        params["onsiteRemote"] = "remote"
    return params


def _data(payload: Any) -> Any:
    if not isinstance(payload, dict):
        return payload
    if payload.get("success") is False:
        message = _text(payload.get("message")) or "the API reported a failure"
        raise ConnectionConfigError(f"{API_NAME}: {message}")
    return payload.get("data")


async def _call(path: str, key: str, params: dict[str, str]) -> Any:
    return await rapidapi_request(
        "GET", HOST, path, api_key=key, api_name=API_NAME, listing_url=LISTING_URL, params=params
    )


async def _details(key: str, job_id: str) -> dict:
    try:
        data = _data(await _call("/get-job-details", key, {"id": job_id}))
    except SessionExpired:
        raise
    except Exception:
        # Quota or throttling mid-sync: keep the search results; the next search reports it.
        return {}
    return data if isinstance(data, dict) else {}


async def _fetch(credentials: dict[str, Any], ctx: FetchContext) -> list[BoardJob]:
    key = require_key(credentials, "LinkedIn Scraper")
    found = _data(await _call("/search-jobs-v2", key, search_params(credentials, ctx)))
    items = found if isinstance(found, list) else (found or {}).get("items") or []
    picked: list[dict] = []
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        job_id, title = _text(item.get("id")), _text(item.get("title"))
        if not job_id or not title or job_id in seen:
            continue
        seen.add(job_id)
        picked.append(item)
        if len(picked) >= ctx.max_jobs:
            break

    gate = asyncio.Semaphore(3)

    async def detail(item: dict) -> dict:
        async with gate:
            return await _details(key, _text(item.get("id")))

    detailed = picked[:MAX_DETAIL_CALLS]
    details = await asyncio.gather(*(detail(i) for i in detailed))
    details += [{}] * (len(picked) - len(detailed))

    jobs: list[BoardJob] = []
    for item, info in zip(picked, details):
        listing = _text(item.get("url")) or f"https://www.linkedin.com/jobs/view/{_text(item.get('id'))}/"
        apply = _text((info.get("applyMethod") or {}).get("companyApplyUrl"))
        company = item.get("company") or info.get("company") or {}
        location = _text(item.get("location")) or _text(info.get("location"))
        if info.get("workRemoteAllowed") and "remote" not in location.lower():
            location = f"{location} | Remote" if location else "Remote"
        jobs.append(
            BoardJob(
                url=apply if apply.startswith("http") else listing,
                title=_text(item.get("title")),
                company=_text(company.get("name") if isinstance(company, dict) else company),
                location=location,
                source_url=listing if apply.startswith("http") else "",
                description=_text(info.get("description")),
            )
        )
    return jobs


register(
    JobSitePlugin(
        slug="linkedinscraper",
        name="LinkedIn Scraper",
        blurb=(
            "LinkedIn's newest jobs from the last 24 hours with full descriptions and the employer's own apply "
            "link, via the RockApis Real-Time LinkedIn Scraper API on RapidAPI."
        ),
        homepage=LISTING_URL,
        signup_url=LISTING_URL,
        auth_type=AuthType.API_KEY,
        logo_file="linkedinscraper.svg",
        sort_order=46,
        verify_max_jobs=2,
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
