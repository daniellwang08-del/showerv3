"""RemoteRocketship — listing API with the user's logged-in cookies."""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote

from app.job_sites.base import AuthType, FetchContext, JobSitePlugin
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
    cookies = cookies_for_domain(
        normalize_cookies(credentials.get("cookies")), "remoterocketship.com"
    )
    if not cookies:
        raise ValueError(
            "No RemoteRocketship session cookies. Sign in and capture your session."
        )

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
        auth_type=AuthType.SESSION,
        logo_file="remoterocketship.svg",
        sort_order=20,
        cookie_domains=("remoterocketship.com",),
        host_origins=(
            "https://*.remoterocketship.com/*",
            "https://www.remoterocketship.com/*",
            "https://remoterocketship.com/*",
        ),
        signed_in_url_patterns=(
            "remoterocketship.com/remote-jobs",
            "remoterocketship.com/jobs",
        ),
        session_cookie_names=("session", "token", "auth", "jwt", "sb-", "supabase"),
        login_path_patterns=("/log-in", "/login", "/signin", "/sign-in"),
        fetch=_fetch,
    )
)
