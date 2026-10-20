"""Welcome to the Jungle: the public Algolia job index plus the public job API.

Algolia (the search key WTTJ's own site ships) lists the newest postings for a
query. The REST job endpoint adds the employer's ``apply_url`` and the posting
text. WTTJ's web pages challenge servers, so the posting text becomes the job
description and the employer posting (or the WTTJ page) becomes its URL.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx

from app.core.logging import get_logger
from app.job_sites.base import DEFAULT_SEARCH_KEYWORDS, AuthType, CredentialField, FetchContext, JobSitePlugin
from app.job_sites.html_fetch import html_to_text
from app.job_sites.http import get_json, post_json
from app.job_sites.registry import register
from app.services.job_source_boards import BoardJob

logger = get_logger(__name__)

SITE = "https://www.welcometothejungle.com"
ALGOLIA_APP_ID = "CSEKHVMS53"
ALGOLIA_API_KEY = "4bd8f6215d0cc52b26430765769e65a0"
ALGOLIA_URL = f"https://{ALGOLIA_APP_ID.lower()}-dsn.algolia.net/1/indexes/wttj_jobs_production_en/query"
API_BASE = "https://api.welcometothejungle.com/api/v1"
DEFAULT_KEYWORDS = DEFAULT_SEARCH_KEYWORDS
MAX_JOBS = 25
DETAIL_CONCURRENCY = 4

_ORIGIN_HEADERS = {"Referer": f"{SITE}/", "Origin": SITE}
_ALGOLIA_HEADERS = {
    "x-algolia-application-id": ALGOLIA_APP_ID,
    "x-algolia-api-key": ALGOLIA_API_KEY,
    **_ORIGIN_HEADERS,
}


def _text(value: Any) -> str:
    if not value:
        return ""
    if isinstance(value, list):
        return "\n".join(f"- {v}" for v in value if v)
    text = str(value)
    return html_to_text(text) if "<" in text else text.strip()


def search_body(keywords: str, country: str, *, hits: int) -> dict:
    body: dict[str, Any] = {"query": keywords, "hitsPerPage": hits, "page": 0}
    if country:
        body["facetFilters"] = [[f"offices.country_code:{country}"]]
    return body


def listing_url(hit: dict) -> str:
    org = hit.get("organization") if isinstance(hit.get("organization"), dict) else {}
    org_slug = str(org.get("slug") or "").strip()
    job_slug = str(hit.get("slug") or "").strip()
    return f"{SITE}/en/companies/{org_slug}/jobs/{job_slug}" if org_slug and job_slug else ""


def hit_to_job(hit: dict, rest_job: dict | None = None) -> BoardJob | None:
    title = str(hit.get("name") or "").strip()
    listing = listing_url(hit)
    if not title or not listing:
        return None
    org = hit.get("organization") if isinstance(hit.get("organization"), dict) else {}
    offices = hit.get("offices") if isinstance(hit.get("offices"), list) else []
    location = ""
    if offices and isinstance(offices[0], dict):
        first = offices[0]
        parts = [first.get("city"), first.get("state"), first.get("country")]
        location = ", ".join(str(p) for p in parts if p)
    if hit.get("remote") == "fulltime":
        location = f"Remote ({location})" if location else "Remote"

    rest = rest_job or {}
    apply_url = str(rest.get("apply_url") or "").strip()
    if not apply_url.startswith(("http://", "https://")):
        apply_url = ""
    sections = [
        _text(rest.get("description")) or _text(hit.get("summary")),
        _text(rest.get("profile")) or _text(hit.get("profile")),
        _text(rest.get("key_missions")) or _text(hit.get("key_missions")),
    ]
    return BoardJob(
        url=apply_url or listing,
        title=title,
        company=str(org.get("name") or "").strip(),
        location=location,
        source_url=listing if apply_url else "",
        description="\n\n".join(s for s in sections if s),
    )


async def _rest_job(hit: dict, gate: asyncio.Semaphore) -> dict | None:
    org = hit.get("organization") if isinstance(hit.get("organization"), dict) else {}
    org_slug = str(org.get("slug") or "").strip()
    job_slug = str(hit.get("slug") or "").strip()
    if not org_slug or not job_slug:
        return None
    async with gate:
        try:
            payload = await get_json(f"{API_BASE}/organizations/{org_slug}/jobs/{job_slug}", headers=_ORIGIN_HEADERS)
        except (httpx.HTTPError, ValueError) as e:
            logger.warning("wttj_job_detail_failed", org=org_slug, job=job_slug, error=str(e)[:200])
            return None
    job = payload.get("job") if isinstance(payload, dict) else None
    return job if isinstance(job, dict) else None


async def _fetch(credentials: dict[str, Any], ctx: FetchContext) -> list[BoardJob]:
    keywords = str(credentials.get("keywords") or "").strip() or DEFAULT_KEYWORDS
    limit = min(MAX_JOBS, ctx.max_jobs)
    country = ctx.primary_country if ctx.country_codes else ""
    payload = await post_json(
        ALGOLIA_URL,
        json_body=search_body(keywords, country, hits=limit),
        headers=_ALGOLIA_HEADERS,
    )
    hits = [h for h in (payload or {}).get("hits") or [] if isinstance(h, dict)][:limit]
    gate = asyncio.Semaphore(DETAIL_CONCURRENCY)
    details = await asyncio.gather(*(_rest_job(hit, gate) for hit in hits))
    jobs = [hit_to_job(hit, rest) for hit, rest in zip(hits, details)]
    return [job for job in jobs if job is not None]


register(
    JobSitePlugin(
        slug="welcometothejungle",
        name="Welcome to the Jungle",
        blurb="Sync the newest Welcome to the Jungle jobs for your search. No account needed.",
        homepage=SITE + "/en/jobs",
        auth_type=AuthType.NONE,
        logo_file="welcometothejungle.svg",
        sort_order=32,
        credential_fields=(
            CredentialField(
                key="keywords",
                label="Search keywords",
                placeholder=DEFAULT_SEARCH_KEYWORDS,
                default=DEFAULT_SEARCH_KEYWORDS,
                secret=False,
                required=False,
                help_text=(
                    "Jobs whose offices are in your preferred country. Leave empty to search for "
                    "remote senior software engineer roles."
                ),
            ),
        ),
        fetch=_fetch,
    )
)
