"""Jobright.ai spider -- authenticated scraping via saved session cookies.

Authentication is handled separately by `python setup_jobright.py`
which opens a real Chrome browser for one-time manual login. Saved cookies
are loaded automatically by this spider on each run.

Uses the internal /swan/recommend/list/jobs JSON API discovered via
network interception. Pagination is offset-based: position=0&count=20
for page 1, position=20&count=20 for page 2, etc.

The API has a hard ceiling of 1000 jobs per sort mode. Two run modes:

  Incremental (default):
    Uses sort=1 (most recent) only. Checkpoint markers from the previous
    run's page 1 tell the spider when it has caught up with old jobs.
    This works because new postings always appear at the top of sort=1.

  Fresh (-a fresh=true):
    Ignores checkpoints and iterates through multiple sort conditions
    (0=best match, 1=most recent, 3=relevance) to maximize coverage.
    Each sort surfaces a different subset of ~1000 jobs; duplicates
    are skipped in-memory and deduped by the pipeline via source_job_id.

The API already returns the origin job URL in jobResult.originalUrl,
so no post-scrape resolution is needed.
"""

import json
import logging
from datetime import datetime, timezone

import scrapy
from scrapy import signals
from curl_cffi import requests as cffi_requests

from app.scraper.spiders.base import BaseJobSpider
from app.scraper.auth import load_session
from app.scraper.models.db import Base, ScrapeCheckpoint, get_engine, get_session

logger = logging.getLogger(__name__)

JOBS_PER_PAGE = 20
API_URL = "https://jobright.ai/swan/recommend/list/jobs"
API_CEILING = 1000
MARKER_COUNT = 3

SORT_MODES = {
    "0": "best match",
    "1": "most recent",
    "3": "relevance",
}
INCREMENTAL_SORT = "1"

BROWSER_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://jobright.ai/jobs/recommend",
    "Origin": "https://jobright.ai",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "DNT": "1",
}


class JobrightSpider(BaseJobSpider):
    name = "jobright"
    source_name = "jobright"
    base_url = "https://jobright.ai"
    allowed_domains = ["jobright.ai"]

    custom_settings = {
        "DOWNLOAD_DELAY": 2,
        "CONCURRENT_REQUESTS": 1,
        "CONCURRENT_REQUESTS_PER_DOMAIN": 1,
        "RETRY_ENABLED": False,
        "ROBOTSTXT_OBEY": False,
        "DOWNLOAD_HANDLERS": {
            "http": "scrapy.core.downloader.handlers.http11.HTTP11DownloadHandler",
            "https": "scrapy.core.downloader.handlers.http11.HTTP11DownloadHandler",
        },
        "DOWNLOADER_MIDDLEWARES": {
            "app.scraper.middlewares.retry_smart.SmartRetryMiddleware": None,
            "scrapy.downloadermiddlewares.retry.RetryMiddleware": None,
        },
    }

    def __init__(self, *args, **kwargs):
        fresh = kwargs.pop("fresh", None)
        sort = kwargs.pop("sort", None)
        kwargs.setdefault("pages", API_CEILING // JOBS_PER_PAGE)

        super().__init__(*args, **kwargs)

        self._session: cffi_requests.Session | None = None
        self._authenticated = False
        self._fresh_mode = str(fresh).lower() in ("1", "true", "yes") if fresh else False
        self._marker_ids: set[str] = set()
        self._page1_ids: list[str] = []
        self._marker_hit = False
        self._seen_job_ids: set[str] = set()

        if self._fresh_mode:
            if sort is not None:
                self._sort_modes = [str(sort)]
            else:
                self._sort_modes = list(SORT_MODES.keys())
        else:
            self._sort_modes = [INCREMENTAL_SORT]

        max_pages_per_sort = API_CEILING // JOBS_PER_PAGE
        if self.max_pages > max_pages_per_sort:
            self.max_pages = max_pages_per_sort

    @classmethod
    def from_crawler(cls, crawler, *args, **kwargs):
        spider = super().from_crawler(crawler, *args, **kwargs)
        crawler.signals.connect(spider._spider_closed, signal=signals.spider_closed)
        return spider

    def _spider_closed(self, spider):
        self._save_checkpoint()
        if self._session:
            self._session.close()

    # ------------------------------------------------------------------
    # Session / Cookie management
    # ------------------------------------------------------------------

    def _create_session(self) -> bool:
        cookies = load_session("jobright")
        if not cookies:
            return False

        self._session = cffi_requests.Session(impersonate="chrome", timeout=20)
        self._session.headers.update(BROWSER_HEADERS)

        injected = 0
        for c in cookies:
            name = c.get("name", "")
            value = c.get("value", "")
            if not name or not value:
                continue
            if "jobright" in c.get("domain", ""):
                self._session.cookies.set(
                    name, value,
                    domain=c.get("domain", ""),
                    path=c.get("path", "/"),
                )
                injected += 1

        if injected > 0:
            self._authenticated = True
            self.logger.info("Loaded %d Jobright cookies", injected)
            return True

        self.logger.warning("Session file had no valid Jobright cookies")
        return False

    def _fetch_api(self, position: int, sort_condition: str) -> dict | None:
        params = {
            "refresh": "true" if position == 0 else "false",
            "sortCondition": sort_condition,
            "position": str(position),
            "count": str(JOBS_PER_PAGE),
            "syncRerank": "false",
        }
        try:
            resp = self._session.get(API_URL, params=params)
            self.logger.info(
                "API position=%d sort=%s → %d (%d bytes)",
                position, sort_condition, resp.status_code, len(resp.content),
            )
            if resp.status_code == 401:
                self.logger.error(
                    "Session expired (401). Re-run: python setup_jobright.py"
                )
                return None
            if resp.status_code == 403:
                self.logger.error(
                    "Access denied (403). Re-run: python setup_jobright.py"
                )
                return None
            if resp.status_code == 429:
                self.logger.warning("Rate limited (429) - stopping pagination")
                return None
            resp.raise_for_status()
            return json.loads(resp.text)
        except Exception as e:
            self.logger.error("API request failed (position=%d): %s", position, e)
            return None

    # ------------------------------------------------------------------
    # Checkpoint persistence
    # ------------------------------------------------------------------

    def _load_checkpoint(self):
        if self._fresh_mode:
            self.logger.info(
                "Fresh mode - ignoring checkpoints, scraping up to %d pages × %d sort modes",
                self.max_pages, len(self._sort_modes),
            )
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
                self._marker_ids = set(str(mid) for mid in cp.marker_job_ids)
                self.logger.info(
                    "Loaded %d checkpoint markers: %s",
                    len(self._marker_ids), list(self._marker_ids),
                )
            else:
                self.logger.info("No checkpoint found - full scrape up to max_pages=%d", self.max_pages)
        finally:
            session.close()

    def _save_checkpoint(self):
        if not self._page1_ids:
            return
        markers = self._page1_ids[:MARKER_COUNT]
        db_url = self.settings.get("DATABASE_URL")
        engine = get_engine(db_url)
        session = get_session(engine)
        try:
            cp = session.query(ScrapeCheckpoint).filter_by(
                spider_name=self.name,
            ).first()
            if cp:
                cp.marker_job_ids = markers
                cp.updated_at = datetime.now(timezone.utc)
            else:
                cp = ScrapeCheckpoint(
                    spider_name=self.name,
                    marker_job_ids=markers,
                )
                session.add(cp)
            session.commit()
            self.logger.info("Saved checkpoint markers (from sort=%s page 1): %s", INCREMENTAL_SORT, markers)
        finally:
            session.close()

    # ------------------------------------------------------------------
    # start_requests
    # ------------------------------------------------------------------

    def start_requests(self):
        if not self._create_session():
            self.logger.error(
                "No saved session. Run: python -m app.scraper.auth setup jobright"
            )
            return

        self._load_checkpoint()

        sort_labels = [f"{s}={SORT_MODES.get(s, '?')}" for s in self._sort_modes]
        mode = "fresh" if self._fresh_mode else "incremental"
        self.logger.info(
            "Starting Jobright %s scrape: max_pages=%d, sort=[%s], %d jobs/page (API ceiling=%d)",
            mode, self.max_pages, ", ".join(sort_labels), JOBS_PER_PAGE, API_CEILING,
        )

        for sort_mode in self._sort_modes:
            yield scrapy.Request(
                f"{API_URL}?sort={sort_mode}&position=0",
                callback=self.parse_listing,
                meta={
                    "page": 1,
                    "position": 0,
                    "sort_condition": sort_mode,
                    "handle_httpstatus_all": True,
                },
                dont_filter=True,
            )

    # ------------------------------------------------------------------
    # parse_listing
    # ------------------------------------------------------------------

    def parse_listing(self, response):
        page = response.meta["page"]
        position = response.meta["position"]
        sort_condition = response.meta["sort_condition"]
        sort_label = SORT_MODES.get(sort_condition, sort_condition)

        data = self._fetch_api(position, sort_condition)
        if not data:
            self.logger.error("[sort=%s] Failed to fetch page %d (position=%d)", sort_label, page, position)
            return

        if not data.get("success"):
            self.logger.error(
                "[sort=%s] API error: %s (code=%s)",
                sort_label, data.get("errorMsg"), data.get("errorCode"),
            )
            return

        result = data.get("result", {})
        jobs = result.get("jobList", [])

        self.logger.info(
            "[sort=%s] Page %d (position=%d): %d jobs returned",
            sort_label, page, position, len(jobs),
        )

        if not jobs:
            self.logger.info("[sort=%s] Page %d returned 0 jobs - end of results", sort_label, page)
            return

        job_ids = [
            item.get("jobResult", {}).get("jobId", "")
            for item in jobs
        ]

        page_posted_dates = []
        for item in jobs:
            publish_time = item.get("jobResult", {}).get("publishTime")
            if publish_time:
                try:
                    page_posted_dates.append(
                        datetime.strptime(str(publish_time), "%Y-%m-%d %H:%M:%S").replace(
                            tzinfo=timezone.utc
                        )
                    )
                except (ValueError, TypeError):
                    pass

        # Save page 1 IDs for checkpoint - always from sort=1 (most recent)
        # regardless of which sort modes are active. In fresh mode we still
        # save markers so the next incremental run has them.
        if page == 1 and sort_condition == INCREMENTAL_SORT and not self._page1_ids:
            self._page1_ids = [jid for jid in job_ids if jid]

        if self._page_too_old(page_posted_dates):
            self.logger.info(
                "[sort=%s] Page %d jobs are older than posted_since - stopping pagination",
                sort_label,
                page,
            )
            for item in jobs:
                yield from self._parse_job_item(item)
            return

        # Checkpoint marker detection - only in incremental mode (sort=1 only)
        marker_hit_on_page = False
        if not self._fresh_mode and self._marker_ids:
            for item, jid in zip(jobs, job_ids):
                if jid and jid in self._marker_ids:
                    self.logger.info(
                        "[sort=%s] Checkpoint marker %s found on page %d - caught up with previous run",
                        sort_label, jid, page,
                    )
                    marker_hit_on_page = True
                    self._marker_hit = True
                    # Yield jobs before the marker (they are newer)
                    break
                if jid in self._seen_job_ids:
                    continue
                if jid:
                    self._seen_job_ids.add(jid)
                yield from self._parse_job_item(item)

            if marker_hit_on_page:
                return
        else:
            # Fresh mode or no markers - yield all new jobs
            new_on_page = 0
            for item, jid in zip(jobs, job_ids):
                if jid in self._seen_job_ids:
                    continue
                if jid:
                    self._seen_job_ids.add(jid)
                new_on_page += 1
                yield from self._parse_job_item(item)

            if new_on_page == 0:
                self.logger.info(
                    "[sort=%s] Page %d had 0 new jobs (all seen in other sort modes) - stopping this sort",
                    sort_label, page,
                )
                return

        next_page = page + 1
        next_position = position + JOBS_PER_PAGE
        should_continue = True

        if next_page > self.max_pages:
            self.logger.info("[sort=%s] Reached max_pages limit (%d) - stopping", sort_label, self.max_pages)
            should_continue = False
        elif next_position >= API_CEILING:
            self.logger.info("[sort=%s] Reached API ceiling (%d) - stopping", sort_label, API_CEILING)
            should_continue = False
        elif len(jobs) < JOBS_PER_PAGE:
            self.logger.info(
                "[sort=%s] Page %d had %d < %d jobs - last page",
                sort_label, page, len(jobs), JOBS_PER_PAGE,
            )
            should_continue = False

        if should_continue:
            yield scrapy.Request(
                f"{API_URL}?sort={sort_condition}&position={next_position}",
                callback=self.parse_listing,
                meta={
                    "page": next_page,
                    "position": next_position,
                    "sort_condition": sort_condition,
                    "handle_httpstatus_all": True,
                },
                dont_filter=True,
            )

    # ------------------------------------------------------------------
    # Job data parsing
    # ------------------------------------------------------------------

    def _parse_job_item(self, item: dict):
        jr = item.get("jobResult", {})
        cr = item.get("companyResult", {})

        job_id = jr.get("jobId", "")
        title = jr.get("jobTitle", "")
        if not job_id or not title:
            return

        origin_url = jr.get("originalUrl") or jr.get("applyLink") or ""
        url = origin_url if origin_url else f"{self.base_url}/jobs/{job_id}"

        company_name = cr.get("companyName", "")

        location = jr.get("jobLocation", "")
        is_remote = jr.get("isRemote", False)
        work_model = jr.get("workModel", "")

        salary_raw = jr.get("salaryDesc")
        salary_min = jr.get("minSalary")
        salary_max = jr.get("maxSalary")
        if not salary_raw and salary_min:
            if salary_max:
                salary_raw = f"${int(salary_min):,} - ${int(salary_max):,}/yr"
            else:
                salary_raw = f"${int(salary_min):,}+/yr"

        posted_at = None
        publish_time = jr.get("publishTime")
        if publish_time:
            try:
                posted_at = datetime.strptime(publish_time, "%Y-%m-%d %H:%M:%S")
                posted_at = posted_at.replace(tzinfo=timezone.utc)
            except (ValueError, TypeError):
                pass

        seniority = jr.get("jobSeniority", "")

        tags = []
        core_skills = jr.get("jdCoreSkills", [])
        if isinstance(core_skills, list):
            tags = [s for s in core_skills if isinstance(s, str)]
        if not tags:
            job_tags = jr.get("jobTags", [])
            if isinstance(job_tags, list):
                tags = [t for t in job_tags if isinstance(t, str)]

        remote_note = f" ({work_model})" if work_model and work_model != "Remote" else ""
        full_location = f"{location}{remote_note}" if location else work_model

        yield self.build_job_item(
            source_job_id=job_id,
            url=url,
            title=title,
            company_name=company_name,
            location=full_location,
            is_remote=is_remote,
            salary_raw=salary_raw,
            description=jr.get("jobSummary", ""),
            job_type=jr.get("employmentType"),
            experience_level=seniority if seniority else None,
            tags=tags,
            posted_at=posted_at,
        )

    def parse_job(self, response):
        pass
