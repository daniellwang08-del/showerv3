"""Adzuna public job search: the website's newest results, no developer key.

Search pages list ten cards each; every card's ``/details/<id>`` page carries
the full posting text, which becomes the job description. The employer link
behind ``/land/ad/<id>`` is a short-lived tracking redirect that servers cannot
follow, so the details page is the job's URL.
"""

from __future__ import annotations

import asyncio
import re
from html import unescape
from typing import Any

from app.core.logging import get_logger
from app.job_sites.base import AuthType, CredentialField, FetchContext, JobSitePlugin
from app.job_sites.errors import RateLimited
from app.job_sites.html_fetch import BotChallenge, HtmlSession, html_to_text
from app.job_sites.registry import register
from app.services.job_source_boards import BoardJob

logger = get_logger(__name__)

DEFAULT_KEYWORDS = "software engineer"
MAX_JOBS = 20
PAGE_SIZE = 10
DETAIL_DELAY_SECONDS = 1.5
THROTTLE_PAUSE_SECONDS = 8.0

# Adzuna runs one site per country; the US site needs no location filter.
SITE_BY_COUNTRY = {
    "US": "https://www.adzuna.com",
    "GB": "https://www.adzuna.co.uk",
    "UK": "https://www.adzuna.co.uk",
    "CA": "https://www.adzuna.ca",
    "AU": "https://www.adzuna.com.au",
    "DE": "https://www.adzuna.de",
    "FR": "https://www.adzuna.fr",
    "NL": "https://www.adzuna.nl",
    "IN": "https://www.adzuna.in",
    "SG": "https://www.adzuna.sg",
    "NZ": "https://www.adzuna.co.nz",
    "IT": "https://www.adzuna.it",
    "ES": "https://www.adzuna.es",
    "PL": "https://www.adzuna.pl",
    "BR": "https://www.adzuna.com.br",
    "MX": "https://www.adzuna.com.mx",
    "ZA": "https://www.adzuna.co.za",
    "AT": "https://www.adzuna.at",
    "BE": "https://www.adzuna.be",
    "CH": "https://www.adzuna.ch",
}

_ARTICLE = re.compile(r'<article\b[^>]*\bdata-aid="(\d+)"[^>]*>(.*?)</article>', re.DOTALL | re.IGNORECASE)
_TITLE = re.compile(r"<h2\b[^>]*>.*?<a\b[^>]*>(.*?)</a>", re.DOTALL | re.IGNORECASE)
_COMPANY_ATTR = re.compile(r'data-company-name="([^"]*)"', re.IGNORECASE)
_COMPANY_DIV = re.compile(r'<div\b[^>]*class="[^"]*\bui-company\b[^"]*"[^>]*>(.*?)</div>', re.DOTALL | re.IGNORECASE)
_LOCATION_DIV = re.compile(r'<div\b[^>]*class="[^"]*\bui-location\b[^"]*"[^>]*>(.*?)</div>', re.DOTALL | re.IGNORECASE)
_BODY = re.compile(r'<section\b[^>]*class="[^"]*\badp-body\b[^"]*"[^>]*>(.*?)</section>', re.DOTALL | re.IGNORECASE)


def _inline(fragment: str) -> str:
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", fragment or ""))).strip()


def site_for(ctx: FetchContext) -> str:
    return SITE_BY_COUNTRY.get(ctx.primary_country, SITE_BY_COUNTRY["US"])


def parse_search_page(html: str, site: str) -> list[BoardJob]:
    jobs: list[BoardJob] = []
    for article in _ARTICLE.finditer(html or ""):
        aid, block = article.group(1), article.group(2)
        title_match = _TITLE.search(block)
        title = _inline(title_match.group(1)) if title_match else ""
        if not title:
            continue
        company_attr = _COMPANY_ATTR.search(article.group(0))
        company_div = _COMPANY_DIV.search(block)
        company = unescape(company_attr.group(1)).strip() if company_attr else ""
        if not company and company_div:
            company = _inline(company_div.group(1))
        location_div = _LOCATION_DIV.search(block)
        jobs.append(
            BoardJob(
                url=f"{site}/details/{aid}",
                title=title,
                company=company,
                location=_inline(location_div.group(1)) if location_div else "",
            )
        )
    return jobs


def parse_details_page(html: str) -> str:
    match = _BODY.search(html or "")
    return html_to_text(match.group(1)) if match else ""


async def _fetch(credentials: dict[str, Any], ctx: FetchContext) -> list[BoardJob]:
    keywords = str(credentials.get("keywords") or "").strip() or DEFAULT_KEYWORDS
    site = site_for(ctx)
    limit = min(MAX_JOBS, ctx.max_jobs)
    jobs: list[BoardJob] = []
    seen: set[str] = set()
    async with HtmlSession() as http:
        page = 1
        while len(jobs) < limit and page <= (limit + PAGE_SIZE - 1) // PAGE_SIZE + 1:
            try:
                html = await http.get(f"{site}/search", params={"q": keywords, "sb": "date", "p": page})
            except BotChallenge:
                if not jobs:
                    raise
                break
            cards = parse_search_page(html, site)
            if not cards:
                break
            for card in cards:
                if card.url not in seen and len(jobs) < limit:
                    seen.add(card.url)
                    jobs.append(card)
            page += 1
        throttled = False
        for job in jobs:
            await asyncio.sleep(DETAIL_DELAY_SECONDS)
            try:
                job.description = parse_details_page(await http.get(job.url))
            except BotChallenge:
                logger.warning("adzuna_details_bot_check", remaining_from=job.url)
                break
            except RateLimited:
                if throttled:
                    # Second throttle in a row: the rest keep their card data and
                    # extraction reads their pages later.
                    logger.warning("adzuna_details_throttled", remaining_from=job.url)
                    break
                throttled = True
                await asyncio.sleep(THROTTLE_PAUSE_SECONDS)
                try:
                    job.description = parse_details_page(await http.get(job.url))
                    throttled = False
                except Exception as e:  # noqa: BLE001
                    logger.warning("adzuna_details_failed", url=job.url, error=str(e)[:200])
            except Exception as e:  # noqa: BLE001 - the job still syncs; extraction retries the page
                logger.warning("adzuna_details_failed", url=job.url, error=str(e)[:200])
    return jobs


register(
    JobSitePlugin(
        slug="adzuna",
        name="Adzuna",
        blurb="Sync the newest Adzuna listings for your search. No account or key needed.",
        homepage="https://www.adzuna.com/",
        auth_type=AuthType.NONE,
        logo_file="adzuna.svg",
        sort_order=30,
        credential_fields=(
            CredentialField(
                key="keywords",
                label="Search keywords",
                placeholder="software engineer",
                secret=False,
                required=False,
                help_text=(
                    "What you would type into Adzuna's search box. Jobs come from Adzuna's site "
                    "for your preferred country. Leave empty to search for software engineer roles."
                ),
            ),
        ),
        fetch=_fetch,
    )
)
