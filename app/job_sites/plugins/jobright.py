"""Jobright.ai — personalized recommendations via the signed-in session."""

from __future__ import annotations

from typing import Any

from app.job_sites.base import AuthType, FetchContext, JobSitePlugin
from app.job_sites.registry import register
from app.job_sites.session_http import (
    cookies_for_domain,
    get_json_with_cookies,
    normalize_cookies,
)
from app.services.job_source_boards import BoardJob

API_URL = "https://jobright.ai/swan/recommend/list/jobs"
HEADERS = {
    "Referer": "https://jobright.ai/jobs/recommend",
    "Origin": "https://jobright.ai",
}


async def _fetch(credentials: dict[str, Any], ctx: FetchContext) -> list[BoardJob]:
    cookies = cookies_for_domain(
        normalize_cookies(credentials.get("cookies")), "jobright.ai"
    )
    if not cookies:
        raise ValueError("No Jobright session cookies. Sign in and capture your session.")

    payload = await get_json_with_cookies(
        API_URL,
        cookies=cookies,
        headers=HEADERS,
        params={
            "refresh": "true",
            "sortCondition": "1",
            "position": "0",
            "count": str(min(20, ctx.max_jobs)),
            "syncRerank": "false",
        },
    )
    if not isinstance(payload, dict):
        raise ValueError("Unexpected Jobright response.")
    if not payload.get("success"):
        raise ValueError(
            payload.get("errorMsg") or "Jobright rejected this session. Recapture cookies."
        )

    jobs: list[BoardJob] = []
    for item in (payload.get("result") or {}).get("jobList") or []:
        if not isinstance(item, dict):
            continue
        jr = item.get("jobResult") or {}
        cr = item.get("companyResult") or {}
        url = str(jr.get("originalUrl") or jr.get("applyLink") or "").strip()
        job_id = str(jr.get("jobId") or "").strip()
        if not url and job_id:
            url = f"https://jobright.ai/jobs/{job_id}"
        title = str(jr.get("jobTitle") or "").strip()
        if not url or not title:
            continue
        jobs.append(
            BoardJob(
                url=url,
                title=title,
                location=str(jr.get("jobLocation") or "").strip(),
                company=str(cr.get("companyName") or "Jobright").strip(),
            )
        )
        if len(jobs) >= ctx.max_jobs:
            break
    return jobs


register(
    JobSitePlugin(
        slug="jobright",
        name="Jobright",
        blurb="Pull your signed-in Jobright recommendations (best matches + newest roles).",
        homepage="https://jobright.ai/",
        login_url="https://jobright.ai/",
        auth_type=AuthType.SESSION,
        logo_file="jobright.svg",
        sort_order=10,
        cookie_domains=("jobright.ai",),
        host_origins=("https://*.jobright.ai/*", "https://jobright.ai/*"),
        fetch=_fetch,
    )
)
