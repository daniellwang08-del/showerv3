"""RemoteRocketship — listing API with a pasted browser session cookie header."""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote

from app.job_sites.base import AuthType, CredentialField, FetchContext, JobSitePlugin, SessionCapture
from app.job_sites.registry import register
from app.job_sites.session_http import (
    cookies_for_domain,
    get_json_with_cookies,
    normalize_cookies,
)
from app.services.job_source_boards import BoardJob

API_URL = "https://www.remoterocketship.com/api/fetch_job_openings/"
HEADERS = {
    "Referer": "https://www.remoterocketship.com/",
    "Origin": "https://www.remoterocketship.com",
}


def parse_cookie_header(raw: str, *, default_domain: str) -> list[dict]:
    """Parse a Cookie request header or `name=value; name2=value2` paste."""
    text = str(raw or "").strip()
    if not text:
        return []
    # Allow users to paste the full "Cookie: a=b; c=d" line.
    if text.lower().startswith("cookie:"):
        text = text.split(":", 1)[1].strip()
    out: list[dict] = []
    for part in text.split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        name, value = part.split("=", 1)
        name = name.strip()
        value = value.strip()
        if not name or not value:
            continue
        out.append(
            {
                "name": name,
                "value": value,
                "domain": default_domain,
                "path": "/",
                "secure": True,
                "httpOnly": True,
            }
        )
    return out


def resolve_rrs_cookies(credentials: dict[str, Any]) -> list[dict]:
    cookies = cookies_for_domain(
        normalize_cookies(credentials.get("cookies")), "remoterocketship.com"
    )
    if cookies:
        return cookies
    pasted = parse_cookie_header(
        str(credentials.get("cookie_header") or ""),
        default_domain=".remoterocketship.com",
    )
    if pasted:
        credentials["cookies"] = pasted
        return pasted
    raise ValueError(
        "Paste your RemoteRocketship Cookie header from DevTools "
        "(Application → Cookies, or the Cookie request header)."
    )


def _query(page: int) -> dict:
    return {
        "seniorityFilters": [],
        "locationFilters": [],
        "locationUSStatesFilters": [],
        "locationCityFilters": [],
        "showHybridJobs": True,
        "showOnsiteJobs": False,
        "showRemoteJobs": True,
        "techStackFilters": [],
        "requiredLanguagesFilters": [],
        "excludeRequiredLanguagesFilters": [],
        "jobTitleFilters": [],
        "keywordFilters": [],
        "excludedKeywordFilters": [],
        "companySizeFilters": [],
        "employmentTypeFilters": [],
        "visaFilter": None,
        "minSalaryFilter": 0,
        "showJobsWithoutSalaryWithMinSalaryFilter": True,
        "degreeRequiredFilter": None,
        "isOnLinkedInFilter": None,
        "industriesFilters": [],
        "excludeIndustriesFilters": [],
        "companyIdFilter": None,
        "page": page,
        "itemsPerPage": 20,
        "sortBy": "DateAdded",
        "showOnlySavedJobs": False,
        "showOnlyAppliedJobs": False,
        "showOnlyHiddenJobs": False,
        "savedJobOpeningIds": [],
        "appliedJobOpeningIds": [],
        "hiddenJobOpeningIds": [],
        "numberOfJobsHiddenInThisSession": 0,
        "language": "en",
    }


def _jobs_from_payload(payload: Any) -> list[dict]:
    if isinstance(payload, list):
        return [j for j in payload if isinstance(j, dict)]
    if not isinstance(payload, dict):
        return []
    for key in ("jobOpenings", "jobs", "results", "data"):
        val = payload.get(key)
        if isinstance(val, list):
            return [j for j in val if isinstance(j, dict)]
        if isinstance(val, dict):
            inner = val.get("jobOpenings") or val.get("jobs") or val.get("items")
            if isinstance(inner, list):
                return [j for j in inner if isinstance(j, dict)]
    return []


async def _fetch(credentials: dict[str, Any], ctx: FetchContext) -> list[BoardJob]:
    cookies = resolve_rrs_cookies(credentials)

    q = quote(json.dumps(_query(1), separators=(",", ":")))
    payload = await get_json_with_cookies(
        f"{API_URL}?q={q}",
        cookies=cookies,
        headers=HEADERS,
        impersonate="chrome123",
    )
    jobs: list[BoardJob] = []
    for job in _jobs_from_payload(payload):
        title = str(job.get("roleTitle") or job.get("title") or job.get("name") or "").strip()
        company_data = job.get("company") or job.get("organization") or {}
        if isinstance(company_data, dict):
            company = str(company_data.get("name") or "").strip()
            company_slug = str(company_data.get("slug") or "").strip()
        else:
            company = str(company_data or "").strip()
            company_slug = ""
        job_slug = str(job.get("slug") or job.get("id") or "").strip()
        url = str(job.get("url") or job.get("apply_url") or "").strip()
        if not url and company_slug and job_slug:
            url = f"https://www.remoterocketship.com/company/{company_slug}/jobs/{job_slug}"
        if not url or not title:
            continue
        location = job.get("location") or ""
        if isinstance(location, dict):
            location = location.get("city") or location.get("name") or ""
        elif isinstance(location, list) and location:
            first = location[0]
            location = first if isinstance(first, str) else (first or {}).get("city") or ""
        jobs.append(
            BoardJob(
                url=url,
                title=title,
                location=str(location or "").strip(),
                company=company or "RemoteRocketship",
            )
        )
        if len(jobs) >= ctx.max_jobs:
            break
    return jobs


register(
    JobSitePlugin(
        slug="remoterocketship",
        name="RemoteRocketship",
        blurb="Pull remote roles from your RemoteRocketship account (newest first).",
        homepage="https://www.remoterocketship.com/",
        login_url="https://www.remoterocketship.com/log-in/",
        auth_type=AuthType.ACCOUNT,
        logo_file="remoterocketship.svg",
        sort_order=20,
        credential_fields=(
            CredentialField(
                key="cookie_header",
                label="Cookie header",
                placeholder="Paste Cookie header after signing in (DevTools → Network → any request → Cookie)",
                help_url="https://www.remoterocketship.com/log-in/",
                secret=True,
            ),
        ),
        session_capture=SessionCapture(
            cookie_domains=("remoterocketship.com",),
            # The log-in page bounces already-authenticated users to the jobs feed.
            start_url="https://www.remoterocketship.com/log-in/",
            verify_url="https://www.remoterocketship.com/remote-jobs",
            signed_in_url_patterns=(
                "remoterocketship.com/remote-jobs",
                "remoterocketship.com/jobs",
                "remoterocketship.com/?page=",
                "remoterocketship.com/saved",
            ),
            logged_out_url_patterns=("/log-in", "/login", "/signin", "/sign-in"),
            session_cookie_names=("sb-", "supabase", "access-token", "session"),
        ),
        fetch=_fetch,
    )
)
