"""ZipRecruiter spider -- Publisher Search API + apply-URL resolution.

Primary path (production):
  GET https://api.ziprecruiter.com/jobs/v1
  Requires ZIPRECRUITER_API_KEY (publisher Search API key), same pattern as
  Adzuna's ADZUNA_APP_ID / ADZUNA_APP_KEY.

Confirmed response fields (Jobs Common / publisher schema):
  id, name, snippet, url, location, city, state,
  hiring_company.{name,url}, posted_time, job_age, has_non_zr_url, …

The ``url`` field is a ZipRecruiter click/listing URL.  We follow it at
scrape time (Adzuna-style) and store:
  url         = ZR listing URL (aggregator provenance)
  origin_url  = final employer/ATS URL when the redirect leaves ziprecruiter.com

Fallback path:
  Playwright listing crawl with response interception for ConnectRPC
  HydrateJobCards / GetJobDetails payloads that include ``external_apply_url``.
  Used only when the publisher API is unavailable; Cloudflare often blocks it.

robots.txt defaults to ``Disallow: /`` for generic agents, so this spider
sets ROBOTSTXT_OBEY=False (same as Adzuna / Jobright / RRS).
"""

from __future__ import annotations

import json
import logging
import math
import random
import re
from datetime import datetime, timezone
from urllib.parse import urlencode, urlparse

import scrapy
from scrapy import signals
from scrapy.exceptions import CloseSpider

from app.scraper.config import settings
from app.scraper.models.db import Base, ScrapeCheckpoint, get_engine, get_session
from app.scraper.spiders.base import BaseJobSpider
from app.scraper.utils.captcha import detect_captcha

logger = logging.getLogger(__name__)

API_BASE = "https://api.ziprecruiter.com/jobs/v1"
JOBS_PER_PAGE = 100
MARKER_COUNT = 3
DEFAULT_DAYS_AGO = 30
DEFAULT_LOCATION = "Remote, US"
DEFAULT_RADIUS_MILES = 5000

DEFAULT_JOB_TITLES = [
    "Software Engineer",
    "Backend Engineer",
    "Frontend Engineer",
    "Full Stack Developer",
    "Data Engineer",
    "DevOps Engineer",
    "Machine Learning Engineer",
    "Product Manager",
    "Data Scientist",
    "Mobile Developer",
]

ZR_HOST_MARKERS = ("ziprecruiter.com", "www.ziprecruiter.com")


def _is_ziprecruiter_host(url: str) -> bool:
    try:
        host = urlparse(url).netloc.lower()
    except Exception:
        return False
    return any(host == h or host.endswith("." + h) for h in ZR_HOST_MARKERS)


def _days_ago_from_posted_since(posted_since: datetime | None, fallback: int) -> int:
    if posted_since is None:
        return fallback
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    dt = posted_since
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    delta = max(1, (now - dt).days + 1)
    return min(delta, 3650)


class ZipRecruiterSpider(BaseJobSpider):
    name = "ziprecruiter"
    source_name = "ziprecruiter"
    base_url = "https://www.ziprecruiter.com"
    # Omit allowed_domains so redirect hops can leave ziprecruiter.com.

    custom_settings = {
        "CONCURRENT_REQUESTS": 8,
        "CONCURRENT_REQUESTS_PER_DOMAIN": 2,
        "DOWNLOAD_DELAY": 0.75,
        "DOWNLOAD_TIMEOUT": 20,
        "ROBOTSTXT_OBEY": False,
        "PLAYWRIGHT_MAX_CONTEXTS": 2,
    }

    def __init__(self, *args, **kwargs):
        job_titles = kwargs.pop("job_titles", None)
        days_ago = kwargs.pop("days_ago", None)
        radius_miles = kwargs.pop("radius_miles", None)
        use_playwright_fallback = kwargs.pop("use_playwright_fallback", None)
        # Accept Adzuna-style ``locations`` alias from ALL_SPIDERS.
        locations = kwargs.pop("locations", None)
        if locations and not kwargs.get("location"):
            kwargs["location"] = locations
        kwargs.setdefault("pages", "20")
        super().__init__(*args, **kwargs)

        if job_titles:
            self.job_titles = [t.strip() for t in str(job_titles).split(",") if t.strip()]
        elif self.query:
            self.job_titles = [self.query]
        else:
            self.job_titles = list(DEFAULT_JOB_TITLES)

        self.filter_location = self.search_location or DEFAULT_LOCATION
        raw_days = int(days_ago) if days_ago not in (None, "") else DEFAULT_DAYS_AGO
        self.days_ago = _days_ago_from_posted_since(self.posted_since, raw_days)
        self.radius_miles = int(radius_miles) if radius_miles not in (None, "") else DEFAULT_RADIUS_MILES
        self._api_key = (settings.ZIPRECRUITER_API_KEY or "").strip()
        # Playwright fallback is opt-in: Cloudflare Turnstile blocks headless
        # listing/API calls in most environments. Prefer publisher API key.
        self._use_playwright_fallback = str(use_playwright_fallback).lower() in (
            "1",
            "true",
            "yes",
        )

        self._marker_ids_by_title: dict[str, set[str]] = {}
        self._page1_ids_by_title: dict[str, list[str]] = {}
        self._seen_ids: set[str] = set()
        self._mode = "api" if self._api_key else "playwright"

    @classmethod
    def from_crawler(cls, crawler, *args, **kwargs):
        spider = super().from_crawler(crawler, *args, **kwargs)
        crawler.signals.connect(spider._spider_closed, signal=signals.spider_closed)
        return spider

    def _spider_closed(self, spider):
        self._save_checkpoint()

    # ------------------------------------------------------------------
    # Checkpoints
    # ------------------------------------------------------------------

    def _load_checkpoint(self):
        if self._fresh_mode:
            self.logger.info("Fresh mode - ignoring ZipRecruiter checkpoints")
            return
        try:
            db_url = self.settings.get("DATABASE_URL")
            engine = get_engine(db_url)
            Base.metadata.create_all(engine)
            session = get_session(engine)
            try:
                cp = session.query(ScrapeCheckpoint).filter_by(spider_name=self.name).first()
                if cp and cp.marker_job_ids:
                    raw = cp.marker_job_ids
                    if isinstance(raw, dict):
                        for title, ids in raw.items():
                            self._marker_ids_by_title[title] = {str(mid) for mid in ids}
                        self.logger.info(
                            "Loaded ZR checkpoint markers for %d titles",
                            len(self._marker_ids_by_title),
                        )
                    elif isinstance(raw, list):
                        legacy = {str(mid) for mid in raw}
                        for title in self.job_titles:
                            self._marker_ids_by_title[title] = legacy
            finally:
                session.close()
        except Exception as e:
            self.logger.warning("Failed to load ZR checkpoints: %s", e)

    def _save_checkpoint(self):
        if not self._page1_ids_by_title:
            return
        markers_dict = {
            title: ids[:MARKER_COUNT]
            for title, ids in self._page1_ids_by_title.items()
            if ids
        }
        if not markers_dict:
            return
        try:
            db_url = self.settings.get("DATABASE_URL")
            engine = get_engine(db_url)
            session = get_session(engine)
            try:
                cp = session.query(ScrapeCheckpoint).filter_by(spider_name=self.name).first()
                if cp:
                    cp.marker_job_ids = markers_dict
                    cp.updated_at = datetime.now(timezone.utc)
                else:
                    cp = ScrapeCheckpoint(
                        spider_name=self.name,
                        marker_job_ids=markers_dict,
                    )
                    session.add(cp)
                session.commit()
                self.logger.info(
                    "Saved ZR checkpoint markers for %d titles",
                    len(markers_dict),
                )
            finally:
                session.close()
        except Exception as e:
            self.logger.warning("Failed to save ZR checkpoints: %s", e)

    # ------------------------------------------------------------------
    # Start
    # ------------------------------------------------------------------

    async def start(self):
        self._load_checkpoint()
        if self._api_key:
            self.logger.info(
                "ZipRecruiter publisher API mode: titles=%d location=%r days_ago=%d pages=%d",
                len(self.job_titles),
                self.filter_location,
                self.days_ago,
                self.max_pages,
            )
            for title in self.job_titles:
                yield self._api_request(title, page=1)
            return

        if not self._use_playwright_fallback:
            raise CloseSpider(
                "ziprecruiter_api_key_missing: set ZIPRECRUITER_API_KEY "
                "(ZipRecruiter publisher Search API key)"
            )

        self.logger.warning(
            "ZIPRECRUITER_API_KEY not set - using Playwright fallback "
            "(Cloudflare may block; prefer publisher API key)"
        )
        for title in self.job_titles:
            for page in range(1, self.max_pages + 1):
                params = {
                    "search": title,
                    "location": self.filter_location,
                    "page": page,
                    "days": self.days_ago,
                }
                url = f"{self.base_url}/jobs-search?{urlencode(params)}"
                yield self.make_playwright_request(
                    url,
                    callback=self.parse_listing_playwright,
                    meta={
                        "page": page,
                        "search_title": title,
                        "playwright": True,
                        "playwright_include_page": True,
                        "playwright_page_methods": [
                            {
                                "method": "wait_for_timeout",
                                "args": [random.randint(2500, 4500)],
                            },
                        ],
                    },
                )

    def _api_request(self, title: str, page: int):
        params = {
            "search": title,
            "location": self.filter_location,
            "radius_miles": self.radius_miles,
            "days_ago": self.days_ago,
            "jobs_per_page": JOBS_PER_PAGE,
            "page": page,
            "api_key": self._api_key,
        }
        url = f"{API_BASE}?{urlencode(params)}"
        return scrapy.Request(
            url,
            callback=self.parse_api_page,
            errback=self._api_errback,
            meta={
                "search_title": title,
                "page": page,
                "playwright": False,
                "handle_httpstatus_list": [401, 403, 429, 500, 502, 503],
            },
            dont_filter=True,
            headers={
                "Accept": "application/json",
                "User-Agent": "Mozilla/5.0 (compatible; ShowerScraper/1.0)",
            },
        )

    def _api_errback(self, failure):
        self.logger.error("ZipRecruiter API network error: %s", failure.value)
        raise CloseSpider(f"ziprecruiter_api_network_error: {failure.value}")

    # ------------------------------------------------------------------
    # Publisher API parsing
    # ------------------------------------------------------------------

    def parse_api_page(self, response):
        title = response.meta["search_title"]
        page = int(response.meta["page"])

        if response.status >= 400:
            self.logger.error(
                "ZipRecruiter API HTTP %s for title=%r page=%s body=%s",
                response.status,
                title,
                page,
                response.text[:300],
            )
            if page == 1 and title == self.job_titles[0]:
                raise CloseSpider(
                    f"ziprecruiter_api_http_{response.status}: "
                    "check ZIPRECRUITER_API_KEY / publisher Search API access"
                )
            return

        try:
            data = json.loads(response.text)
        except json.JSONDecodeError:
            self.logger.error("ZipRecruiter API returned non-JSON for %s", response.url)
            raise CloseSpider("ziprecruiter_api_invalid_json")

        jobs = data.get("jobs") or []
        total = data.get("num_paginable_jobs") or data.get("total_jobs") or 0
        self.logger.info(
            "ZR API title=%r page=%d jobs=%d total=%s",
            title,
            page,
            len(jobs),
            total,
        )

        if not jobs:
            return

        marker_ids = self._marker_ids_by_title.get(title, set())
        hit_marker = False
        page_ids: list[str] = []

        for job in jobs:
            if not isinstance(job, dict):
                continue
            job_id = str(job.get("id") or "").strip()
            if not job_id:
                continue
            if job_id in self._seen_ids:
                continue
            self._seen_ids.add(job_id)
            page_ids.append(job_id)

            if (not self._fresh_mode) and job_id in marker_ids:
                hit_marker = True
                self.logger.info("ZR checkpoint marker hit for %r id=%s", title, job_id)
                break

            req = self._request_resolve_apply(job, title)
            if req is not None:
                yield req

        if page == 1 and page_ids:
            self._page1_ids_by_title[title] = page_ids[:MARKER_COUNT]

        if hit_marker:
            return

        # Paginate while jobs remain and under max_pages.
        max_page_by_total = (
            int(math.ceil(float(total) / JOBS_PER_PAGE)) if total else self.max_pages
        )
        if page < self.max_pages and page < max_page_by_total and len(jobs) >= JOBS_PER_PAGE:
            yield self._api_request(title, page=page + 1)
        elif page < self.max_pages and len(jobs) >= JOBS_PER_PAGE:
            # total missing, keep going until short page
            yield self._api_request(title, page=page + 1)

    def _request_resolve_apply(self, job: dict, search_title: str):
        title = (job.get("name") or job.get("title") or "").strip()
        job_id = str(job.get("id") or "").strip()
        if not title or not job_id:
            return None

        zr_url = (job.get("url") or "").strip()
        if zr_url and not zr_url.startswith("http"):
            zr_url = f"{self.base_url}{zr_url}"
        if not zr_url:
            zr_url = f"{self.base_url}/jobs/{job_id}"

        company = ""
        hc = job.get("hiring_company")
        if isinstance(hc, dict):
            company = hc.get("name") or ""
        elif isinstance(hc, str):
            company = hc

        location = job.get("location") or ""
        if not location:
            city = job.get("city") or ""
            state = job.get("state") or ""
            location = f"{city}, {state}".strip(", ")

        posted_at = None
        posted = job.get("posted_time") or job.get("posted_time_friendly") or ""
        if isinstance(posted, str) and posted:
            try:
                posted_at = datetime.fromisoformat(posted.replace("Z", "+00:00"))
            except (ValueError, TypeError):
                posted_at = None

        salary_raw = None
        for key in ("salary_min_annual", "salary_max_annual", "salary_interval"):
            if job.get(key) is not None:
                smin = job.get("salary_min_annual")
                smax = job.get("salary_max_annual")
                if smin and smax:
                    salary_raw = f"${int(smin):,} - ${int(smax):,}/yr"
                elif smin:
                    salary_raw = f"${int(smin):,}+/yr"
                break

        job_meta = {
            "source_job_id": job_id,
            "zr_url": zr_url,
            "title": title,
            "company_name": company,
            "location": location,
            "is_remote": "remote" in f"{title} {location}".lower(),
            "salary_raw": salary_raw,
            "description": job.get("snippet") or job.get("description") or "",
            "job_type": job.get("employment_type") or job.get("category"),
            "posted_at": posted_at,
            "has_non_zr_url": bool(job.get("has_non_zr_url")),
            "search_title": search_title,
        }

        # Always try to follow the ZR URL to capture external ATS destination.
        return scrapy.Request(
            url=zr_url,
            callback=self.parse_apply_redirect,
            errback=self._redirect_errback,
            meta={
                "job_data": job_meta,
                "dont_retry": True,
                "playwright": False,
                "handle_httpstatus_list": [403, 404, 429, 500, 502, 503],
            },
            dont_filter=True,
            headers={"Referer": "https://www.ziprecruiter.com/"},
        )

    def parse_apply_redirect(self, response):
        job_meta = response.meta.get("job_data") or {}
        zr_url = job_meta.get("zr_url") or response.request.url
        final_url = response.url

        origin_url = None
        if response.status < 400 and final_url and not _is_ziprecruiter_host(final_url):
            origin_url = final_url
            self.logger.info(
                "ZR redirect resolved: %s → %s",
                zr_url,
                origin_url,
            )
        elif response.status >= 400:
            self.logger.warning(
                "ZR redirect HTTP %s for %s - keeping ZR URL only",
                response.status,
                job_meta.get("source_job_id"),
            )
        else:
            # Still on ZR (Zip Apply / interstitial). Keep listing only.
            self.logger.debug(
                "ZR redirect stayed on ziprecruiter for %s",
                job_meta.get("source_job_id"),
            )

        yield self.build_job_item(
            source_job_id=job_meta["source_job_id"],
            url=zr_url,
            origin_url=origin_url,
            title=job_meta["title"],
            company_name=job_meta.get("company_name"),
            location=job_meta.get("location"),
            is_remote=job_meta.get("is_remote", False),
            salary_raw=job_meta.get("salary_raw"),
            description=job_meta.get("description") or "",
            job_type=str(job_meta["job_type"]).lower() if job_meta.get("job_type") else None,
            posted_at=job_meta.get("posted_at"),
        )

    def _redirect_errback(self, failure):
        job_meta = failure.request.meta.get("job_data") or {}
        zr_url = job_meta.get("zr_url") or failure.request.url
        self.logger.warning(
            "ZR redirect network error for %s: %s - keeping ZR URL",
            job_meta.get("source_job_id"),
            failure.value,
        )
        if not job_meta.get("source_job_id") or not job_meta.get("title"):
            return
        yield self.build_job_item(
            source_job_id=job_meta["source_job_id"],
            url=zr_url,
            origin_url=None,
            title=job_meta["title"],
            company_name=job_meta.get("company_name"),
            location=job_meta.get("location"),
            is_remote=job_meta.get("is_remote", False),
            salary_raw=job_meta.get("salary_raw"),
            description=job_meta.get("description") or "",
            job_type=str(job_meta["job_type"]).lower() if job_meta.get("job_type") else None,
            posted_at=job_meta.get("posted_at"),
        )

    # ------------------------------------------------------------------
    # Playwright fallback (HTML + intercepted JSON)
    # ------------------------------------------------------------------

    async def parse_listing_playwright(self, response):
        if detect_captcha(response) or "Just a moment" in (response.text or "")[:2000]:
            self.logger.warning("CAPTCHA/Cloudflare on %s - skipping", response.url)
            return

        page = response.meta.get("playwright_page")
        intercepted_jobs: list[dict] = []

        if page is not None:
            try:
                # Pull any hydrated job-card JSON already in memory if the SPA exposed it.
                intercepted_jobs = await page.evaluate(
                    """() => {
                      const out = [];
                      const scripts = [...document.querySelectorAll('script')];
                      for (const s of scripts) {
                        const t = s.textContent || '';
                        if (t.includes('external_apply_url') || t.includes('externalApplyUrl')) {
                          out.push(t.slice(0, 500000));
                        }
                      }
                      return out;
                    }"""
                )
            except Exception as e:
                self.logger.debug("Playwright evaluate failed: %s", e)
                intercepted_jobs = []

        # Prefer LD+JSON / embedded objects from HTML (legacy path).
        yielded = 0
        for item in self._parse_html_listing(response):
            yielded += 1
            yield item

        # Attempt to mine external_apply_url from any captured script text.
        if isinstance(intercepted_jobs, list):
            for blob in intercepted_jobs:
                if not isinstance(blob, str):
                    continue
                for m in re.finditer(
                    r'"external_apply_url"\s*:\s*"([^"]+)"',
                    blob,
                ):
                    apply_url = m.group(1)
                    # Best-effort companion fields near the match.
                    window = blob[max(0, m.start() - 800) : m.end() + 800]
                    title_m = re.search(r'"title"\s*:\s*"([^"]+)"', window)
                    id_m = re.search(r'"listing_key"\s*:\s*"([^"]+)"', window) or re.search(
                        r'"id"\s*:\s*"([^"]+)"', window
                    )
                    company_m = re.search(r'"company(?:Name|_name)?"\s*:\s*"([^"]+)"', window)
                    if not title_m or not id_m:
                        continue
                    job_id = id_m.group(1)
                    if job_id in self._seen_ids:
                        continue
                    self._seen_ids.add(job_id)
                    listing = f"{self.base_url}/jobs/{job_id}"
                    yielded += 1
                    yield self.build_job_item(
                        source_job_id=job_id,
                        url=listing,
                        origin_url=apply_url if apply_url.startswith("http") else None,
                        title=title_m.group(1),
                        company_name=company_m.group(1) if company_m else None,
                    )

        self.logger.info(
            "ZR Playwright page=%s yielded=%d",
            response.meta.get("page"),
            yielded,
        )

    def _parse_html_listing(self, response):
        ld_json = response.css('script[type="application/ld+json"]::text').getall()
        for ld in ld_json:
            try:
                data = json.loads(ld)
            except json.JSONDecodeError:
                continue
            items = data if isinstance(data, list) else [data]
            for item in items:
                if not isinstance(item, dict):
                    continue
                if item.get("@type") == "JobPosting":
                    yield from self._parse_ld_json(item)
                if item.get("@type") == "ItemList":
                    for el in item.get("itemListElement") or []:
                        job = el.get("item") if isinstance(el, dict) else None
                        if isinstance(job, dict) and job.get("@type") == "JobPosting":
                            yield from self._parse_ld_json(job)

    def _parse_ld_json(self, data: dict):
        title = (data.get("title") or "").strip()
        if not title:
            return
        company_data = data.get("hiringOrganization") or {}
        company = company_data.get("name", "") if isinstance(company_data, dict) else ""
        url = (data.get("url") or "").strip()
        source_id = ""
        if url:
            m = re.search(r"/([a-f0-9]{6,})(?:\?|$)", url)
            source_id = m.group(1) if m else url.rstrip("/").split("/")[-1]
        if not source_id:
            source_id = re.sub(r"\W+", "-", title.lower())[:48]
        if source_id in self._seen_ids:
            return
        self._seen_ids.add(source_id)

        posted_at = None
        posted = data.get("datePosted") or ""
        if posted:
            try:
                posted_at = datetime.fromisoformat(str(posted).replace("Z", "+00:00"))
            except (ValueError, TypeError):
                posted_at = None

        location = ""
        location_data = data.get("jobLocation") or {}
        if isinstance(location_data, dict):
            address = location_data.get("address") or {}
            if isinstance(address, dict):
                city = address.get("addressLocality") or ""
                state = address.get("addressRegion") or ""
                location = f"{city}, {state}".strip(", ")

        listing = url if url.startswith("http") else f"{self.base_url}{url}" if url else (
            f"{self.base_url}/jobs/{source_id}"
        )
        yield self.build_job_item(
            source_job_id=source_id,
            url=listing,
            origin_url=None,
            title=title,
            company_name=company,
            location=location,
            description=data.get("description") or "",
            job_type=(data.get("employmentType") or "").lower() or None,
            posted_at=posted_at,
        )

    def parse_listing(self, response):
        """BaseJobSpider abstract hook, API mode uses ``parse_api_page``."""
        return

    def parse_job(self, response):
        """Unused detail callback kept for BaseJobSpider abstract contract."""
        return
