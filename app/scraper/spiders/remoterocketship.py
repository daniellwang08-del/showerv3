"""RemoteRocketship spider -- authenticated scraping via saved session.

Authentication is handled separately by `python -m app.scraper.auth setup`
which opens a real browser for the user to log in once. The saved cookies
are loaded automatically by CloudflareSession on each run.

Uses the internal /api/fetch_job_openings/ JSON API for reliable pagination,
since the SSR __NEXT_DATA__ always returns page-1 data regardless of the
page query parameter. The API accepts a JSON query object with filters,
pagination, and sort parameters.

Incremental scraping: saves the first 3 job IDs from page 1 as checkpoint
markers after each run. On the next run, pagination stops as soon as a
marker is encountered, so only new jobs are scraped.
"""

import json
import math
import logging
from datetime import datetime, timezone
from urllib.parse import quote

import scrapy
from scrapy import signals

from app.scraper.spiders.base import BaseJobSpider
from app.scraper.utils.cloudflare import CloudflareSession
from app.scraper.models.db import Base, ScrapeCheckpoint, get_engine, get_session

logger = logging.getLogger(__name__)

JOBS_PER_PAGE = 20
API_PATH = "/api/fetch_job_openings/"
MARKER_COUNT = 3

DEFAULT_JOB_TITLES = [
    "Software Engineer",
    "Backend Engineer",
    "Frontend Engineer",
    "Application Engineer",
    "AI Engineer",
    "Data Engineer",
    "Artificial Intelligence",
    "Cloud Engineer",
    "Implementation Specialist",
    "Computer Vision Engineer",
    "DevOps Engineer",
    "Infrastructure Engineer",
    "Solutions Engineer",
    "IT Support",
]
DEFAULT_LOCATION = "United States"
DEFAULT_MIN_SALARY = 140000
DEFAULT_SORT = "DateAdded"


class RemoteRocketshipSpider(BaseJobSpider):
    name = "remoterocketship"
    source_name = "remoterocketship"
    base_url = "https://www.remoterocketship.com"
    allowed_domains = ["remoterocketship.com"]

    custom_settings = {
        "DOWNLOAD_DELAY": 0,
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
        job_titles = kwargs.pop("job_titles", None)
        locations = kwargs.pop("locations", None)
        min_salary = kwargs.pop("min_salary", None)
        sort = kwargs.pop("sort", None)

        super().__init__(*args, **kwargs)

        self._cf_session: CloudflareSession | None = None
        self._use_filtered_search = not self.query
        self._marker_ids: set[str] = set()
        self._page1_ids: list[str] = []
        self._marker_hit = False

        if self._use_filtered_search:
            self.job_titles = (
                [t.strip() for t in job_titles.split(",") if t.strip()]
                if job_titles
                else DEFAULT_JOB_TITLES
            )
            self.filter_locations = locations if locations else DEFAULT_LOCATION
            self.min_salary = int(min_salary) if min_salary else DEFAULT_MIN_SALARY
            self.sort_order = sort if sort else DEFAULT_SORT

    @classmethod
    def from_crawler(cls, crawler, *args, **kwargs):
        spider = super().from_crawler(crawler, *args, **kwargs)
        crawler.signals.connect(spider._spider_closed, signal=signals.spider_closed)
        return spider

    def _spider_closed(self, spider):
        self._save_checkpoint()
        if self._cf_session:
            self._cf_session.close()

    # ------------------------------------------------------------------
    # Checkpoint persistence
    # ------------------------------------------------------------------

    def _load_checkpoint(self):
        """Load marker job IDs from the last successful run."""
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
                self._marker_ids = set(str(mid) for mid in cp.marker_job_ids)
                self.logger.info(
                    "Loaded %d checkpoint markers: %s",
                    len(self._marker_ids), list(self._marker_ids),
                )
            else:
                self.logger.info("No checkpoint found - will use max_pages=%d", self.max_pages)
        finally:
            session.close()

    def _save_checkpoint(self):
        """Persist the first N job IDs from page 1 as the new checkpoint."""
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
            self.logger.info("Saved checkpoint markers: %s", markers)
        finally:
            session.close()

    def _get_session(self) -> CloudflareSession:
        if self._cf_session is None:
            proxy_path = self.settings.get("PROXY_LIST_PATH", "")
            self._cf_session = CloudflareSession(proxy_path=proxy_path)
        return self._cf_session

    # ------------------------------------------------------------------
    # API query building
    # ------------------------------------------------------------------

    def _build_api_query(self, page: int) -> dict:
        """Build the JSON query object for /api/fetch_job_openings/."""
        locations = self.filter_locations if self._use_filtered_search else ""
        location_list = [locations] if locations else []

        return {
            "seniorityFilters": [],
            "locationFilters": location_list,
            "locationUSStatesFilters": [],
            "locationCityFilters": [],
            "showHybridJobs": False,
            "showOnsiteJobs": False,
            "showRemoteJobs": True,
            "techStackFilters": [],
            "requiredLanguagesFilters": [],
            "excludeRequiredLanguagesFilters": [],
            "jobTitleFilters": self.job_titles if self._use_filtered_search else [],
            "keywordFilters": [self.query] if not self._use_filtered_search and self.query else [],
            "excludedKeywordFilters": [],
            "companySizeFilters": [],
            "employmentTypeFilters": [],
            "visaFilter": None,
            "minSalaryFilter": self.min_salary if self._use_filtered_search else 0,
            "showJobsWithoutSalaryWithMinSalaryFilter": True,
            "degreeRequiredFilter": None,
            "isOnLinkedInFilter": None,
            "industriesFilters": [],
            "excludeIndustriesFilters": [],
            "companyIdFilter": None,
            "page": page,
            "itemsPerPage": JOBS_PER_PAGE,
            "sortBy": self.sort_order if self._use_filtered_search else DEFAULT_SORT,
            "showOnlySavedJobs": False,
            "showOnlyAppliedJobs": False,
            "showOnlyHiddenJobs": False,
            "savedJobOpeningIds": [],
            "appliedJobOpeningIds": [],
            "hiddenJobOpeningIds": [],
            "numberOfJobsHiddenInThisSession": 0,
            "language": "en",
        }

    def _build_api_url(self, page: int) -> str:
        q_json = json.dumps(self._build_api_query(page), separators=(",", ":"))
        return f"{self.base_url}{API_PATH}?q={quote(q_json)}"

    # ------------------------------------------------------------------
    # start_requests
    # ------------------------------------------------------------------

    def start_requests(self):
        session = self._get_session()
        if not session.is_authenticated:
            self.logger.error(
                "No saved session found. Run: python -m app.scraper.auth setup rrs"
            )
            return

        self._load_checkpoint()

        if self._use_filtered_search:
            self.logger.info(
                "Starting filtered search: titles=%s, location=%s, minSalary=%s, sort=%s",
                ",".join(self.job_titles), self.filter_locations,
                self.min_salary, self.sort_order,
            )
        else:
            self.logger.info("Starting keyword search: query=%s", self.query)

        api_url = self._build_api_url(page=1)
        yield scrapy.Request(
            api_url,
            callback=self.parse_listing,
            meta={"page": 1, "_rrs_url": api_url, "handle_httpstatus_all": True},
            dont_filter=True,
        )

    # ------------------------------------------------------------------
    # parse_listing
    # ------------------------------------------------------------------

    def parse_listing(self, response):
        """Fetch via curl_cffi and parse the JSON API response."""
        page = response.meta["page"]
        real_url = response.meta["_rrs_url"]

        session = self._get_session()
        body = session.fetch(real_url)

        if not body:
            self.logger.error("Failed to fetch page %d after all retries", page)
            return

        try:
            data = json.loads(body)
        except json.JSONDecodeError as e:
            self.logger.error("Failed to parse JSON for page %d: %s", page, e)
            return

        jobs = data.get("jobOpenings", [])
        total_count = data.get("totalCount")

        if total_count is not None:
            total_pages = math.ceil(total_count / JOBS_PER_PAGE)
            self.logger.info(
                "Page %d: %d jobs, %d total (%d pages)",
                page, len(jobs), total_count, total_pages,
            )
        else:
            total_pages = None
            self.logger.info("Page %d: %d jobs (total unknown)", page, len(jobs))

        if not jobs:
            self.logger.info("Page %d returned 0 jobs - stopping", page)
            return

        job_ids = [str(j.get("id", "")) for j in jobs]

        if page == 1:
            self._page1_ids = job_ids[:]

        marker_hit_on_page = False
        if not self._fresh_mode and self._marker_ids:
            for job, jid in zip(jobs, job_ids):
                if jid and jid in self._marker_ids:
                    self.logger.info(
                        "Checkpoint marker %s found on page %d - caught up with previous run",
                        jid, page,
                    )
                    marker_hit_on_page = True
                    self._marker_hit = True
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
            if self._marker_ids:
                self.logger.warning(
                    "Reached max_pages limit (%d) without hitting a checkpoint marker - "
                    "markers may have expired",
                    self.max_pages,
                )
            else:
                self.logger.info("Reached max_pages limit (%d) - stopping", self.max_pages)
            should_continue = False
        elif total_pages is not None and next_page > total_pages:
            self.logger.info("Reached last page (%d/%d) - stopping", page, total_pages)
            should_continue = False
        elif len(jobs) < JOBS_PER_PAGE:
            self.logger.info("Page %d had %d < %d jobs - last page", page, len(jobs), JOBS_PER_PAGE)
            should_continue = False

        if should_continue:
            next_url = self._build_api_url(next_page)
            yield scrapy.Request(
                next_url,
                callback=self.parse_listing,
                meta={"page": next_page, "_rrs_url": next_url, "handle_httpstatus_all": True},
                dont_filter=True,
            )

    # ------------------------------------------------------------------
    # Job data parsing
    # ------------------------------------------------------------------

    def _parse_job_data(self, job: dict):
        if isinstance(job, str):
            return

        title = job.get("roleTitle", job.get("title", job.get("name", "")))
        if not title:
            return

        company_data = job.get("company", job.get("organization", {}))
        if isinstance(company_data, dict):
            company_name = company_data.get("name", "")
            company_slug = company_data.get("slug", "")
        else:
            company_name = str(company_data) if company_data else ""
            company_slug = ""

        job_slug = job.get("slug", job.get("id", ""))
        source_job_id = str(job.get("id", job_slug))

        origin_url = job.get("url", job.get("apply_url", ""))
        if origin_url:
            url = origin_url
        elif company_slug and job_slug:
            url = f"{self.base_url}/company/{company_slug}/jobs/{job_slug}"
        else:
            url = f"{self.base_url}/jobs/{source_job_id}"

        location = job.get("location", "")
        if isinstance(location, dict):
            location = location.get("city", location.get("name", ""))
        elif isinstance(location, list) and location:
            location = location[0] if isinstance(location[0], str) else location[0].get("city", "")

        salary_range = job.get("salaryRange", job.get("salary", job.get("salary_range")))
        salary_raw = ""
        if isinstance(salary_range, dict):
            salary_raw = salary_range.get("salaryHumanReadableText", "")
            if not salary_raw:
                sal_min = salary_range.get("min", salary_range.get("minimum"))
                sal_max = salary_range.get("max", salary_range.get("maximum"))
                salary_raw = f"${sal_min} - ${sal_max}" if sal_min else ""
        elif isinstance(salary_range, str):
            salary_raw = salary_range
        elif isinstance(salary_range, (int, float)):
            salary_raw = f"${salary_range}"

        tags = job.get("techStack", job.get("tags", job.get("skills", [])))
        if isinstance(tags, list):
            tags = [t if isinstance(t, str) else t.get("name", str(t)) for t in tags]
        else:
            tags = []

        levels = []
        if job.get("isEntryLevel"):
            levels.append("Entry")
        if job.get("isJunior"):
            levels.append("Junior")
        if job.get("isMidLevel"):
            levels.append("Mid")
        if job.get("isSenior"):
            levels.append("Senior")
        if job.get("isLead"):
            levels.append("Lead")
        experience = ", ".join(levels) if levels else job.get("experience_level", job.get("seniority", ""))
        if isinstance(experience, list):
            experience = ", ".join(experience)

        description = (
            job.get("twoLineJobDescriptionSummary", "")
            or job.get("jobDescriptionSummary", "")
            or job.get("description", "")
        )

        yield self.build_job_item(
            source_job_id=source_job_id,
            url=str(url),
            title=title,
            company_name=company_name,
            location=str(location),
            is_remote=job.get("locationType") == "remote" if "locationType" in job else True,
            salary_raw=salary_raw if salary_raw else None,
            description=description,
            job_type=job.get("employmentType", job.get("job_type", "full-time")),
            experience_level=str(experience) if experience else None,
            tags=tags,
        )
