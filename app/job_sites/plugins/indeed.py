"""Indeed via the Mantiks Indeed API (indeed12 on RapidAPI).

Search hits carry no description and Indeed's pages block servers, so each
kept job gets one ``/job/{id}`` call for its HTML description. Paid plans cap
calls per minute or hour, so detail calls run one at a time and a throttled
call is retried once before the rest are skipped.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any
from urllib.parse import parse_qsl, urlsplit

from app.job_sites.base import (
    DEFAULT_SEARCH_KEYWORDS,
    AuthType,
    CredentialField,
    FetchContext,
    JobSitePlugin,
)
from app.job_sites.errors import RateLimited, SessionExpired
from app.job_sites.html_fetch import html_to_text
from app.job_sites.rapidapi import rapidapi_key_field, rapidapi_request, require_key
from app.job_sites.registry import register
from app.services.job_source_boards import BoardJob

HOST = "indeed12.p.rapidapi.com"
LISTING_URL = "https://rapidapi.com/mantiks-mantiks-default/api/indeed12"
API_NAME = "Indeed API (Mantiks)"
MAX_DETAIL_CALLS = 15
THROTTLE_WAIT_SECONDS = 7.0
_REMOTE_WORD = re.compile(r"\bremote\b", re.IGNORECASE)

# Indeed's country sites, keyed by our country preference codes.
LOCALITIES = {
    "US": "us",
    "GB": "gb",
    "UK": "gb",
    "CA": "ca",
    "AU": "au",
    "DE": "de",
    "FR": "fr",
    "NL": "nl",
    "IN": "in",
    "SG": "sg",
    "IE": "ie",
    "NZ": "nz",
}
_VIEW_HOSTS = {"us": "www.indeed.com", "gb": "uk.indeed.com"}


def _text(value: Any) -> str:
    return str(value or "").strip()


def locality(ctx: FetchContext) -> str:
    return LOCALITIES.get(ctx.primary_country, "us")


def view_url(job_id: str, loc: str) -> str:
    return f"https://{_VIEW_HOSTS.get(loc, f'{loc}.indeed.com')}/viewjob?jk={job_id}"


def clean_view_url(url: str) -> str:
    """Indeed viewjob links reduced to ``?jk=``; other links unchanged.

    The API's final URL carries ``spa=1``, which makes Indeed answer with the page's
    raw JSON instead of the job page.
    """
    parts = urlsplit(url)
    host = parts.netloc.lower()
    if not (host == "indeed.com" or host.endswith(".indeed.com")) or not parts.path.rstrip("/").endswith("/viewjob"):
        return url
    jk = dict(parse_qsl(parts.query)).get("jk", "").strip()
    return f"https://{host}/viewjob?jk={jk}" if jk else url


def search_params(credentials: dict[str, Any], ctx: FetchContext) -> dict[str, str]:
    raw = " ".join(str(credentials.get("keywords") or "").split()) or DEFAULT_SEARCH_KEYWORDS
    remote = bool(_REMOTE_WORD.search(raw))
    params = {
        "query": " ".join(_REMOTE_WORD.sub(" ", raw).split()) or raw,
        "locality": locality(ctx),
        "fromage": "1",
        "sort": "date",
        "page_id": "1",
    }
    if remote:
        params["location"] = "remote"
    return params


async def _call(path: str, key: str, params: dict[str, str]) -> Any:
    return await rapidapi_request(
        "GET", HOST, path, api_key=key, api_name=API_NAME, listing_url=LISTING_URL, params=params
    )


async def _details(key: str, job_id: str, loc: str) -> dict | None:
    """Detail payload, {} when this job failed, None when the remaining calls should be skipped."""
    for attempt in (1, 2):
        try:
            data = await _call(f"/job/{job_id}", key, {"locality": loc})
            return data if isinstance(data, dict) else {}
        except SessionExpired:
            raise
        except RateLimited as exc:
            if attempt == 2:
                return None
            await asyncio.sleep(min(exc.retry_after_seconds or THROTTLE_WAIT_SECONDS, 30.0))
        except Exception:
            # Quota used up mid-sync also lands here: keep the search results.
            return {}
    return None


async def _fetch(credentials: dict[str, Any], ctx: FetchContext) -> list[BoardJob]:
    key = require_key(credentials, "Indeed")
    params = search_params(credentials, ctx)
    loc = params["locality"]
    hits: list[dict] = []
    seen: set[str] = set()
    for page in (1, 2, 3):
        params["page_id"] = str(page)
        payload = await _call("/jobs/search", key, params)
        page_hits = (payload or {}).get("hits") if isinstance(payload, dict) else None
        if not page_hits:
            break
        for hit in page_hits:
            job_id = _text(hit.get("id")) if isinstance(hit, dict) else ""
            if job_id and _text(hit.get("title")) and job_id not in seen:
                seen.add(job_id)
                hits.append(hit)
        if len(hits) >= ctx.max_jobs or not (payload or {}).get("next_page_id"):
            break
    hits = hits[: ctx.max_jobs]

    details: list[dict] = []
    for hit in hits[:MAX_DETAIL_CALLS]:
        info = await _details(key, _text(hit.get("id")), loc)
        if info is None:
            break
        details.append(info)
    details += [{}] * (len(hits) - len(details))

    jobs: list[BoardJob] = []
    for hit, info in zip(hits, details):
        job_id = _text(hit.get("id"))
        company = info.get("company") if isinstance(info.get("company"), dict) else {}
        url = clean_view_url(_text(info.get("indeed_final_url")) or view_url(job_id, loc))
        jobs.append(
            BoardJob(
                url=url,
                title=_text(hit.get("title")) or _text(info.get("job_title")),
                company=_text(hit.get("company_name")) or _text(company.get("name")),
                location=_text(hit.get("location")) or _text(info.get("location")),
                description=html_to_text(_text(info.get("description")))[:60000],
            )
        )
    return jobs


register(
    JobSitePlugin(
        slug="indeed",
        name="Indeed",
        blurb="Indeed jobs posted in the last day, with full descriptions, via the Mantiks Indeed API on RapidAPI.",
        homepage=LISTING_URL,
        signup_url=LISTING_URL,
        auth_type=AuthType.API_KEY,
        logo_file="indeed.svg",
        sort_order=43,
        min_sync_hours=12.0,
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
                    "Jobs come from Indeed in your first preferred country."
                ),
            ),
        ),
        fetch=_fetch,
    )
)
