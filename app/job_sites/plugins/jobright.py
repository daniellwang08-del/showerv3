"""Jobright.ai, personalized recommendations from a browser session captured by the extension."""

from __future__ import annotations

from typing import Any

from app.job_sites.base import AuthType, FetchContext, JobSitePlugin, SessionCapture
from app.job_sites.errors import ConnectionConfigError, SessionExpired
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
RECONNECT = (
    "Your Jobright session expired. Open Integrations and click Reconnect "
    "to sign in through your browser again."
)


def resolve_jobright_cookies(credentials: dict[str, Any]) -> list[dict]:
    cookies = cookies_for_domain(normalize_cookies(credentials.get("cookies")), "jobright.ai")
    if not cookies:
        raise ConnectionConfigError(
            "No Jobright session. Click Connect to sign in through your browser."
        )
    return cookies


def parse_jobs(payload: dict, *, max_jobs: int) -> list[BoardJob]:
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
        if len(jobs) >= max_jobs:
            break
    return jobs


async def _fetch(credentials: dict[str, Any], ctx: FetchContext) -> list[BoardJob]:
    cookies = resolve_jobright_cookies(credentials)
    try:
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
    except SessionExpired as e:
        raise SessionExpired(RECONNECT) from e
    if not isinstance(payload, dict):
        raise RuntimeError("Unexpected Jobright response.")
    if not payload.get("success"):
        raise SessionExpired(payload.get("errorMsg") or RECONNECT)
    return parse_jobs(payload, max_jobs=ctx.max_jobs)


register(
    JobSitePlugin(
        slug="jobright",
        name="Jobright",
        blurb="Pull your signed-in Jobright recommendations (best matches + newest roles).",
        homepage="https://jobright.ai/",
        login_url="https://jobright.ai/jobs/recommend",
        auth_type=AuthType.ACCOUNT,
        logo_file="jobright.svg",
        sort_order=10,
        session_capture=SessionCapture(
            cookie_domains=("jobright.ai",),
            # Signed-in users asking for the root are redirected to their
            # recommendations; signed-out users stay on the landing page.
            start_url="https://jobright.ai/",
            verify_url="https://jobright.ai/jobs/recommend",
            signed_in_url_patterns=("jobright.ai/jobs/recommend",),
            logged_out_url_patterns=(
                "/login",
                "/signin",
                "/sign-in",
                "/sign_in",
                "/auth",
                "/swan/auth",
            ),
            session_cookie_names=("SESSION_ID",),
        ),
        fetch=_fetch,
    )
)
