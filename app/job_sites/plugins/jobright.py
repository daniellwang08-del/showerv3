"""Jobright.ai, personalized recommendations via account email/password."""

from __future__ import annotations

import asyncio
from typing import Any

from app.job_sites.base import AuthType, CredentialField, FetchContext, JobSitePlugin, SessionCapture
from app.job_sites.registry import register
from app.job_sites.session_http import (
    BROWSER_HEADERS,
    cookies_for_domain,
    get_json_with_cookies,
    normalize_cookies,
)
from app.services.job_source_boards import BoardJob

API_URL = "https://jobright.ai/swan/recommend/list/jobs"
LOGIN_URL = "https://jobright.ai/swan/auth/login/pwd"
HEADERS = {
    "Referer": "https://jobright.ai/jobs/recommend",
    "Origin": "https://jobright.ai",
}


def _cookies_from_response(session) -> list[dict]:
    out: list[dict] = []
    jar = getattr(session, "cookies", None)
    if jar is None:
        return out
    # curl_cffi jar supports iteration like RequestsCookieJar
    try:
        for cookie in jar:
            name = getattr(cookie, "name", None) or ""
            value = getattr(cookie, "value", None)
            if not name or value is None:
                continue
            domain = getattr(cookie, "domain", None) or ".jobright.ai"
            path = getattr(cookie, "path", None) or "/"
            out.append(
                {
                    "name": str(name),
                    "value": str(value),
                    "domain": str(domain),
                    "path": str(path),
                    "secure": True,
                    "httpOnly": True,
                }
            )
    except TypeError:
        # Mapping-like jar: name -> value
        try:
            for name, value in jar.items():
                if not name or value is None:
                    continue
                out.append(
                    {
                        "name": str(name),
                        "value": str(value),
                        "domain": ".jobright.ai",
                        "path": "/",
                        "secure": True,
                        "httpOnly": True,
                    }
                )
        except Exception:
            return out
    return out


def _login_sync(email: str, password: str) -> list[dict]:
    from curl_cffi import requests as cffi_requests

    session = cffi_requests.Session(impersonate="chrome124", timeout=25)
    try:
        session.headers.update(
            {
                **BROWSER_HEADERS,
                "Origin": "https://jobright.ai",
                "Referer": "https://jobright.ai/",
                "Content-Type": "application/json",
            }
        )
        response = session.post(
            LOGIN_URL,
            json={"email": email, "password": password},
        )
        payload: dict = {}
        try:
            payload = response.json() if response.content else {}
        except Exception:
            payload = {}
        if response.status_code in (401, 403):
            msg = (
                payload.get("errorMsg")
                if isinstance(payload, dict)
                else None
            ) or "Jobright rejected this email or password."
            raise PermissionError(str(msg))
        response.raise_for_status()
        if isinstance(payload, dict) and payload.get("success") is False:
            raise ValueError(
                payload.get("errorMsg") or "Jobright login failed. Check email and password."
            )
        cookies = _cookies_from_response(session)
        # Prefer Set-Cookie parsing if the jar was empty
        if not any(c["name"] == "SESSION_ID" for c in cookies):
            raw = response.headers.get("set-cookie") or response.headers.get("Set-Cookie") or ""
            if isinstance(raw, list):
                parts = raw
            else:
                parts = [raw] if raw else []
            for part in parts:
                if "SESSION_ID=" not in part:
                    continue
                value = part.split("SESSION_ID=", 1)[1].split(";", 1)[0].strip()
                if value:
                    cookies.append(
                        {
                            "name": "SESSION_ID",
                            "value": value,
                            "domain": ".jobright.ai",
                            "path": "/",
                            "secure": True,
                            "httpOnly": True,
                        }
                    )
        if not cookies_for_domain(cookies, "jobright.ai"):
            raise ValueError("Jobright login succeeded but no session cookie was returned.")
        return cookies
    finally:
        session.close()


async def login_jobright(email: str, password: str) -> list[dict]:
    return await asyncio.to_thread(_login_sync, email, password)


async def resolve_jobright_cookies(credentials: dict[str, Any]) -> list[dict]:
    """Return usable cookies: reuse stored ones, or log in with email/password."""
    cookies = cookies_for_domain(
        normalize_cookies(credentials.get("cookies")), "jobright.ai"
    )
    email = str(credentials.get("email") or "").strip()
    password = str(credentials.get("password") or "")
    if cookies and not (email and password):
        return cookies
    if email and password:
        return await login_jobright(email, password)
    if cookies:
        return cookies
    raise ValueError(
        "No Jobright session. Click Connect to sign in through your browser, "
        "or enter your Jobright email and password."
    )


async def _fetch(credentials: dict[str, Any], ctx: FetchContext) -> list[BoardJob]:
    cookies = await resolve_jobright_cookies(credentials)

    async def _once(cookie_list: list[dict]) -> dict:
        payload = await get_json_with_cookies(
            API_URL,
            cookies=cookie_list,
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
        return payload

    try:
        payload = await _once(cookies)
    except PermissionError:
        email = str(credentials.get("email") or "").strip()
        password = str(credentials.get("password") or "")
        if not (email and password):
            raise PermissionError(
                "Your Jobright session expired. Open Integrations and click Connect "
                "to sign in through your browser again."
            )
        cookies = await login_jobright(email, password)
        payload = await _once(cookies)

    if not payload.get("success"):
        # Stale cookies with stored password, one re-login retry
        email = str(credentials.get("email") or "").strip()
        password = str(credentials.get("password") or "")
        if email and password:
            cookies = await login_jobright(email, password)
            payload = await _once(cookies)
        if not payload.get("success"):
            raise ValueError(
                payload.get("errorMsg")
                or "Jobright rejected this session. Reconnect from Integrations."
            )

    # Stash refreshed cookies on the credentials dict so connect can persist them.
    credentials["cookies"] = cookies

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
        login_url="https://jobright.ai/jobs/recommend",
        auth_type=AuthType.ACCOUNT,
        logo_file="jobright.svg",
        sort_order=10,
        credential_fields=(
            CredentialField(
                key="email",
                label="Email",
                placeholder="you@example.com",
                secret=False,
            ),
            CredentialField(
                key="password",
                label="Password",
                placeholder="Jobright password",
                secret=True,
            ),
        ),
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
