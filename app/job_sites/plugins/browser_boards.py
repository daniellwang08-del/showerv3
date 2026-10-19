"""Boards the NAO extension reads in the user's browser (they block servers)."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote_plus, urlparse

from app.job_sites.base import AuthType, BrowserSync, CredentialField, FetchContext, JobSitePlugin
from app.job_sites.registry import register

DEFAULT_KEYWORDS = "software engineer"
GLASSDOOR = "https://www.glassdoor.com"
REMOTE_CO = "https://remote.co"
REMOTE_CO_DEFAULT_CATEGORIES = ("developer", "software-engineer", "it")
MAX_START_URLS = 4


def _links(raw: str, hosts: tuple[str, ...]) -> list[str]:
    out: list[str] = []
    # Glassdoor search paths contain commas, so links are separated by whitespace only.
    for token in (raw or "").split():
        try:
            parsed = urlparse(token.strip().rstrip(",;"))
        except ValueError:
            continue
        host = parsed.netloc.lower()
        if parsed.scheme in ("http", "https") and any(host == h or host.endswith("." + h) for h in hosts):
            link = parsed._replace(scheme="https", fragment="").geturl()
            if link not in out:
                out.append(link)
    return out[:MAX_START_URLS]


def glassdoor_start_urls(credentials: dict[str, Any], _ctx: FetchContext) -> list[str]:
    links = _links(str(credentials.get("search_url") or ""), ("glassdoor.com",))
    if links:
        return links[:1]
    keywords = str(credentials.get("keywords") or "").strip() or DEFAULT_KEYWORDS
    return [f"{GLASSDOOR}/Job/jobs.htm?sc.keyword={quote_plus(keywords)}&fromAge=3"]


def remoteco_start_urls(credentials: dict[str, Any], _ctx: FetchContext) -> list[str]:
    links = [u for u in _links(str(credentials.get("search_url") or ""), ("remote.co",)) if "/remote-jobs" in u]
    return links or [f"{REMOTE_CO}/remote-jobs/{slug}" for slug in REMOTE_CO_DEFAULT_CATEGORIES]


async def _no_server_fetch(_credentials: dict[str, Any], _ctx: FetchContext):
    raise NotImplementedError("This board is read by the NAO extension, not the server.")


register(
    JobSitePlugin(
        slug="glassdoor",
        name="Glassdoor",
        blurb="Sync new Glassdoor jobs for your search through the NAO extension in your browser.",
        homepage=GLASSDOOR + "/Job/index.htm",
        auth_type=AuthType.BROWSER,
        logo_file="glassdoor.svg",
        sort_order=40,
        min_sync_hours=6.0,
        credential_fields=(
            CredentialField(
                key="keywords",
                label="Search keywords",
                placeholder="software engineer",
                secret=False,
                required=False,
                help_text="Jobs posted in the last 3 days. Leave empty to search for software engineer roles.",
            ),
            CredentialField(
                key="search_url",
                label="Search link",
                placeholder=GLASSDOOR + "/Job/...-jobs-SRCH_....htm",
                help_url=GLASSDOOR + "/Job/index.htm",
                secret=False,
                required=False,
                help_text=(
                    "Optional. Set location, date and other filters on Glassdoor, then paste the "
                    "address bar link. It replaces the keywords above."
                ),
            ),
        ),
        browser_sync=BrowserSync(
            collector="glassdoor",
            start_urls=glassdoor_start_urls,
            host_patterns=("https://*.glassdoor.com/*",),
            max_jobs=20,
        ),
        fetch=_no_server_fetch,
    )
)

register(
    JobSitePlugin(
        slug="remoteco",
        name="Remote.co",
        blurb="Sync Remote.co's free remote listings, with the employer's apply link, through the NAO extension.",
        homepage=REMOTE_CO + "/remote-jobs",
        auth_type=AuthType.BROWSER,
        logo_file="remoteco.svg",
        sort_order=41,
        min_sync_hours=6.0,
        credential_fields=(
            CredentialField(
                key="search_url",
                label="Category links",
                placeholder=REMOTE_CO + "/remote-jobs/developer",
                help_url=REMOTE_CO + "/remote-jobs",
                secret=False,
                required=False,
                help_text=(
                    "Optional. Paste up to four Remote.co category links, separated by spaces. "
                    "Without them, sync reads the developer, software engineer and IT categories. "
                    "Only listings Remote.co shows without a paid membership come through."
                ),
            ),
        ),
        browser_sync=BrowserSync(
            collector="remoteco",
            start_urls=remoteco_start_urls,
            host_patterns=("https://remote.co/*",),
            max_jobs=25,
        ),
        fetch=_no_server_fetch,
    )
)
