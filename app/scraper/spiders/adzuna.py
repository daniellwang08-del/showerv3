"""Adzuna spider -- uses the free Adzuna REST API.

Register for free API keys at https://developer.adzuna.com/signup
and set ADZUNA_APP_ID / ADZUNA_APP_KEY in your .env file.

Pagination uses the page number in the URL path (/search/1, /search/2, ...).
Results are sorted by date (newest first), so checkpoints work correctly:
markers from each title's page 1 tell us where we left off.

Checkpoint markers are stored per-title as a dict so each title query
has its own independent set of markers.
"""

import json
import math
import logging
from datetime import datetime, timezone
from urllib.parse import urlencode

import scrapy
from scrapy import signals

from app.scraper.spiders.base import BaseJobSpider
from app.scraper.config import settings
from app.scraper.models.db import Base, ScrapeCheckpoint, get_engine, get_session

logger = logging.getLogger(__name__)

RESULTS_PER_PAGE = 50
API_BASE = "https://api.adzuna.com/v1/api/jobs"
MARKER_COUNT = 3

DEFAULT_JOB_TITLES = [
    "Software Engineer",
    "Backend Engineer",
    "Frontend Engineer",
    "AI Engineer",
    "Data Engineer",
    "Cloud Engineer",
    "DevOps Engineer",
    "Infrastructure Engineer",
    "Solutions Engineer",
]
DEFAULT_COUNTRY = "us"
DEFAULT_LOCATION = "United States"
DEFAULT_MIN_SALARY = 140000


class AdzunaSpider(BaseJobSpider):
    name = "adzuna"
    source_name = "adzuna"
    base_url = "https://www.adzuna.com"

    # NOTE: allowed_domains is intentionally omitted.  The spider only makes
    # explicit requests (API calls + Adzuna redirect URLs), so there is no
    # risk of accidental off-site crawling.  Keeping allowed_domains would
    # block Scrapy from following the 302 redirects that land on employer
    # domains (greenhouse.io, lever.co, workday, etc.).
    custom_settings = {
        # Allow parallel redirect resolution across different employer domains
        # (greenhouse.io, lever.co, workday, etc.).
        # CONCURRENT_REQUESTS_PER_DOMAIN=1 keeps us polite per host, so the
        # Adzuna API still gets at most 1 concurrent request while up to 8
        # redirect requests to different employer domains can run in parallel.
        "CONCURRENT_REQUESTS": 8,
        "CONCURRENT_REQUESTS_PER_DOMAIN": 1,
        "DOWNLOAD_DELAY": 1,
        "AUTOTHROTTLE_TARGET_CONCURRENCY": 4.0,

        # Cap individual request time at 15 s.  Scrapy's default (180 s) means
        # a single stalled redirect (e.g. expired Adzuna token) blocks a worker
        # slot for 3 minutes.
        "DOWNLOAD_TIMEOUT": 15,

        "ROBOTSTXT_OBEY": False,
    }

    def __init__(self, *args, **kwargs):
        job_titles = kwargs.pop("job_titles", None)
        locations = kwargs.pop("locations", None)
        min_salary = kwargs.pop("min_salary", None)
        country = kwargs.pop("country", None)
        fresh = kwargs.pop("fresh", None)

        super().__init__(*args, **kwargs)

        self.job_titles = (
            [t.strip() for t in job_titles.split(",") if t.strip()]
            if job_titles
            else DEFAULT_JOB_TITLES
        )
        self.filter_location = locations if locations else DEFAULT_LOCATION
        self.min_salary = int(min_salary) if min_salary else DEFAULT_MIN_SALARY
        self.country = country if country else DEFAULT_COUNTRY
        self._fresh_mode = str(fresh).lower() in ("1", "true", "yes") if fresh else False

        self._app_id = settings.ADZUNA_APP_ID
        self._app_key = settings.ADZUNA_APP_KEY

        # Per-title checkpoint markers: {"Software Engineer": {"id1","id2","id3"}, ...}
        self._marker_ids_by_title: dict[str, set[str]] = {}
        # Per-title page-1 IDs to save as new markers: {"Software Engineer": ["id1","id2","id3"], ...}
        self._page1_ids_by_title: dict[str, list[str]] = {}

    @classmethod
    def from_crawler(cls, crawler, *args, **kwargs):
        spider = super().from_crawler(crawler, *args, **kwargs)
        crawler.signals.connect(spider._spider_closed, signal=signals.spider_closed)
        return spider

    def _spider_closed(self, spider):
        self._save_checkpoint()

    # ------------------------------------------------------------------
    # Checkpoint persistence
    # ------------------------------------------------------------------

    def _load_checkpoint(self):
        if self._fresh_mode:
            self.logger.info("Fresh mode - ignoring checkpoints")
            return
        db_url = self.settings.get("DATABASE_URL")
        engine = get_engine(db_url)
        Base.metadata.create_all(engine)
        session = get_session(engine)
        try:
            cp = session.query(ScrapeCheckpoint).filter_by(
                spider_name=self.name,
            ).first()
            if cp and cp.marker_job_ids:
                raw = cp.marker_job_ids
                if isinstance(raw, dict):
                    for title, ids in raw.items():
                        self._marker_ids_by_title[title] = set(str(mid) for mid in ids)
                    total = sum(len(v) for v in self._marker_ids_by_title.values())
                    self.logger.info(
                        "Loaded checkpoint markers for %d titles (%d total IDs)",
                        len(self._marker_ids_by_title), total,
                    )
                elif isinstance(raw, list):
                    # Legacy format: single list. Apply to all titles as best-effort.
                    legacy_set = set(str(mid) for mid in raw)
                    for title in self.job_titles:
                        self._marker_ids_by_title[title] = legacy_set
                    self.logger.info(
                        "Loaded legacy checkpoint (%d markers), applied to all titles",
                        len(legacy_set),
                    )
            else:
                self.logger.info("No checkpoint found - will use max_pages=%d", self.max_pages)
        finally:
            session.close()

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
        db_url = self.settings.get("DATABASE_URL")
        engine = get_engine(db_url)
        session = get_session(engine)
        try:
            cp = session.query(ScrapeCheckpoint).filter_by(
                spider_name=self.name,
            ).first()
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
            total = sum(len(v) for v in markers_dict.values())
            self.logger.info(
                "Saved checkpoint markers for %d titles (%d total IDs)",
                len(markers_dict), total,
            )
        finally:
            session.close()

    # ------------------------------------------------------------------
    # URL building
    # ------------------------------------------------------------------

    def _build_search_url(self, title: str, page: int) -> str:
        params = {
            "app_id": self._app_id,
            "app_key": self._app_key,
            "what": title,
            "salary_min": str(self.min_salary),
            "sort_by": "date",
            "results_per_page": str(RESULTS_PER_PAGE),
            "full_time": "1",
            "content-type": "application/json",
        }
        if self.filter_location:
            params["where"] = self.filter_location
        return f"{API_BASE}/{self.country}/search/{page}?{urlencode(params)}"

    # ------------------------------------------------------------------
    # start_requests
    # ------------------------------------------------------------------

    def start_requests(self):
        if not self._app_id or not self._app_key:
            self.logger.error(
                "Adzuna API keys not configured. "
                "Register at https://developer.adzuna.com/signup "
                "and set ADZUNA_APP_ID / ADZUNA_APP_KEY in .env"
            )
            return

        self._load_checkpoint()

        mode = "fresh" if self._fresh_mode else "incremental"
        self.logger.info(
            "Starting Adzuna %s search: titles=%s, location=%s, minSalary=%s, country=%s",
            mode, ",".join(self.job_titles), self.filter_location,
            self.min_salary, self.country,
        )

        for title in self.job_titles:
            url = self._build_search_url(title, page=1)
            yield scrapy.Request(
                url,
                callback=self.parse_listing,
                meta={"page": 1, "title": title},
                dont_filter=True,
            )

    # ------------------------------------------------------------------
    # parse_listing
    # ------------------------------------------------------------------

    def parse_listing(self, response):
        page = response.meta["page"]
        title = response.meta["title"]

        try:
            data = json.loads(response.text)
        except json.JSONDecodeError as e:
            self.logger.error("[%s] Failed to parse JSON for page %d: %s", title, page, e)
            return

        jobs = data.get("results", [])
        total_count = data.get("count")

        if total_count is not None:
            total_pages = math.ceil(total_count / RESULTS_PER_PAGE)
            self.logger.info(
                "[%s] Page %d: %d jobs, %d total (%d pages)",
                title, page, len(jobs), total_count, total_pages,
            )
        else:
            total_pages = None
            self.logger.info("[%s] Page %d: %d jobs (total unknown)", title, page, len(jobs))

        if not jobs:
            self.logger.info("[%s] Page %d returned 0 jobs - stopping", title, page)
            return

        job_ids = [str(j.get("id", "")) for j in jobs]
        page_posted_dates = []
        for job in jobs:
            created = job.get("created")
            if created:
                try:
                    page_posted_dates.append(
                        datetime.fromisoformat(str(created).replace("Z", "+00:00"))
                    )
                except ValueError:
                    pass

        if page == 1:
            self._page1_ids_by_title[title] = [jid for jid in job_ids if jid]

        if self._page_too_old(page_posted_dates):
            self.logger.info(
                "[%s] Page %d jobs are older than posted_since - stopping pagination",
                title,
                page,
            )
            for job in jobs:
                yield from self._parse_job_data(job)
            return

        title_markers = self._marker_ids_by_title.get(title, set())
        marker_hit_on_page = False

        if not self._fresh_mode and title_markers:
            for job, jid in zip(jobs, job_ids):
                if jid and jid in title_markers:
                    self.logger.info(
                        "[%s] Checkpoint marker %s found on page %d - caught up",
                        title, jid, page,
                    )
                    marker_hit_on_page = True
                    break
                yield from self._parse_job_data(job)
        else:
            for job in jobs:
                yield from self._parse_job_data(job)

        if marker_hit_on_page:
            return

        next_page = page + 1
        should_continue = True

        if next_page > self.max_pages:
            if title_markers:
                self.logger.warning(
                    "[%s] Reached max_pages limit (%d) without hitting checkpoint",
                    title, self.max_pages,
                )
            else:
                self.logger.info("[%s] Reached max_pages limit (%d) - stopping", title, self.max_pages)
            should_continue = False
        elif total_pages is not None and next_page > total_pages:
            self.logger.info("[%s] Reached last page (%d/%d) - stopping", title, page, total_pages)
            should_continue = False
        elif len(jobs) < RESULTS_PER_PAGE:
            self.logger.info("[%s] Page %d had %d < %d jobs - last page", title, page, len(jobs), RESULTS_PER_PAGE)
            should_continue = False

        if should_continue:
            next_url = self._build_search_url(title, next_page)
            yield scrapy.Request(
                next_url,
                callback=self.parse_listing,
                meta={"page": next_page, "title": title},
                dont_filter=True,
            )

    # ------------------------------------------------------------------
    # Job data parsing
    # ------------------------------------------------------------------

    def _parse_job_data(self, job: dict):
        """Yield a Scrapy Request to follow the Adzuna redirect URL.

        Adzuna's API returns a ``redirect_url`` that is either:
        - ``/land/ad/<id>?se=<token>&v=<hash>``  - a time-bound click-tracking
          URL that performs an HTTP 302 redirect to the actual employer page.
        - ``/details/<id>``                       - the Adzuna detail page.

        In both cases, fetching from the extraction worker later fails because
        Adzuna blocks programmatic access (Cloudflare 403).  By following the
        redirect at spider run-time, when Adzuna's tokens are still valid and
        our headers look like a real browser, we capture the final employer
        URL (e.g. greenhouse.io, lever.co, workday) and store that instead.
        The original Adzuna URL is preserved as ``origin_url`` for provenance.
        """
        title = job.get("title", "")
        if not title:
            return

        source_job_id = str(job.get("id", ""))
        if not source_job_id:
            return

        redirect_url = job.get("redirect_url", "")
        if not redirect_url:
            return

        company_data = job.get("company", {})
        company_name = company_data.get("display_name", "") if isinstance(company_data, dict) else ""

        location_data = job.get("location", {})
        location = location_data.get("display_name", "") if isinstance(location_data, dict) else ""

        salary_min = job.get("salary_min")
        salary_max = job.get("salary_max")
        salary_raw = None
        if salary_min and salary_max:
            salary_raw = f"${int(salary_min):,} - ${int(salary_max):,} per year"
        elif salary_min:
            salary_raw = f"${int(salary_min):,}+ per year"

        contract_time = job.get("contract_time", "")
        job_type = "full-time" if contract_time == "full_time" else (
            "part-time" if contract_time == "part_time" else contract_time or None
        )

        posted_at = None
        created = job.get("created")
        if created:
            try:
                posted_at = datetime.fromisoformat(created.replace("Z", "+00:00"))
            except (ValueError, AttributeError):
                pass

        category = job.get("category", {})
        tags = []
        if isinstance(category, dict) and category.get("label"):
            tags = [category["label"]]

        job_meta = {
            "source_job_id": source_job_id,
            "origin_url": redirect_url,
            "title": title,
            "company_name": company_name,
            "location": location,
            "is_remote": "remote" in title.lower() or "remote" in location.lower(),
            "salary_raw": salary_raw,
            "description": job.get("description", ""),
            "job_type": job_type,
            "tags": tags,
            "posted_at": posted_at,
        }

        yield scrapy.Request(
            url=redirect_url,
            callback=self.parse_job,
            errback=self._redirect_errback,
            meta={
                "job_data": job_meta,
                # Don't waste retry attempts on expired/invalid tokens -
                # the errback / status check handles that gracefully.
                "dont_retry": True,
                # Deliver 4xx / 5xx responses to parse_job so we can fall
                # back to the Adzuna URL rather than dropping the job entirely.
                "handle_httpstatus_list": [403, 404, 429, 500, 502, 503],
            },
            dont_filter=True,
            headers={"Referer": "https://www.adzuna.com/"},
        )

    def parse_job(self, response):
        """Capture the employer URL after Adzuna's redirect has been followed.

        ``response.url`` is the final URL after all HTTP 302 hops.  If it
        resolved to a non-Adzuna domain we have the real employer job page.
        If it stayed on adzuna.com (JS-redirect, Cloudflare challenge, or
        HTTP error) we fall back to storing the original Adzuna URL so the
        job is still persisted - the extraction worker will attempt it and
        the validator will handle any wall pages gracefully.
        """
        job_meta = response.meta.get("job_data", {})
        origin_url: str = job_meta.get("origin_url", response.request.url)
        final_url: str = response.url

        if response.status >= 400:
            self.logger.warning(
                "Adzuna redirect returned HTTP %d for job %s - "
                "falling back to Adzuna URL",
                response.status,
                job_meta.get("source_job_id"),
            )
            final_url = origin_url

        elif "adzuna.com" in final_url:
            # Redirect did not leave adzuna.com - most likely a /details/ page
            # that returned 200 directly (no HTTP-level redirect to employer).
            # Store the Adzuna URL; the extraction service handles it from here.
            self.logger.info(
                "Adzuna redirect stayed on adzuna.com for job %s (url=%s)",
                job_meta.get("source_job_id"),
                final_url,
            )

        else:
            self.logger.info(
                "Adzuna redirect resolved: %s → %s",
                origin_url,
                final_url,
            )

        yield self.build_job_item(
            source_job_id=job_meta["source_job_id"],
            url=final_url,
            origin_url=origin_url if origin_url != final_url else None,
            title=job_meta["title"],
            company_name=job_meta.get("company_name"),
            location=job_meta.get("location"),
            is_remote=job_meta.get("is_remote", False),
            salary_raw=job_meta.get("salary_raw"),
            description=job_meta.get("description", ""),
            job_type=job_meta.get("job_type"),
            tags=job_meta.get("tags", []),
            posted_at=job_meta.get("posted_at"),
        )

    def _redirect_errback(self, failure):
        """Handle network-level errors (DNS, SSL, connection refused) when
        following the Adzuna redirect URL.

        Falls back to storing the original Adzuna URL so the job is not lost.
        """
        request = failure.request
        job_meta = request.meta.get("job_data", {})
        origin_url: str = job_meta.get("origin_url", request.url)

        self.logger.warning(
            "Network error following Adzuna redirect for job %s: %s - "
            "falling back to Adzuna URL",
            job_meta.get("source_job_id"),
            failure.getErrorMessage(),
        )

        yield self.build_job_item(
            source_job_id=job_meta["source_job_id"],
            url=origin_url,
            origin_url=None,
            title=job_meta["title"],
            company_name=job_meta.get("company_name"),
            location=job_meta.get("location"),
            is_remote=job_meta.get("is_remote", False),
            salary_raw=job_meta.get("salary_raw"),
            description=job_meta.get("description", ""),
            job_type=job_meta.get("job_type"),
            tags=job_meta.get("tags", []),
            posted_at=job_meta.get("posted_at"),
        )
