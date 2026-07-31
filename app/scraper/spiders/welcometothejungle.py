"""Welcome to the Jungle spider -- Tier 1 (Algolia + REST).

Listing uses WTTJ's public Algolia search index (same key embedded in their
frontend).  Default mode mirrors
https://www.welcometothejungle.com/en/pages/jobs-remote-us
(``remote:fulltime`` + ``offices.country_code:US``).

Algolia caps pagination at 1000 hits, so remote-US sync walks published_at
timestamp windows (confirmed: 7d windows stay under the cap; ~180d lookback
covers the full remote-US index).

Original ATS / apply destinations are NOT in Algolia hits.  They come from
the public REST job detail endpoint as ``apply_url``, stored in
``origin_url`` so ``scrape_promoter`` promotes the real posting URL.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from html import unescape
from typing import Any, Iterator

import scrapy

from app.scraper.spiders.base import BaseJobSpider

ALGOLIA_APP_ID = "CSEKHVMS53"
ALGOLIA_API_KEY = "4bd8f6215d0cc52b26430765769e65a0"
ALGOLIA_INDEX_EN = "wttj_jobs_production_en"
ALGOLIA_URL = f"https://{ALGOLIA_APP_ID.lower()}-dsn.algolia.net/1/indexes/{ALGOLIA_INDEX_EN}/query"

WTTJ_API_BASE = "https://api.welcometothejungle.com/api/v1"
REMOTE_US_FACET_FILTERS = [["remote:fulltime"], ["offices.country_code:US"]]

# Confirmed live: page*hitsPerPage >= 1000 returns empty hits for this index.
ALGOLIA_PAGINATION_LIMIT = 1000
# Confirmed live: 180d lookback reaches 100% of remote-US nbHits (~3379).
DEFAULT_REMOTE_US_LOOKBACK_DAYS = 180
# Confirmed live: 7d remote-US window ≈ 458 hits; 30d ≈ 2014 (over cap).
DEFAULT_WINDOW_SECONDS = 7 * 86400

_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(value: str | None) -> str:
    if not value:
        return ""
    text = _TAG_RE.sub(" ", unescape(value))
    return re.sub(r"\s+", " ", text).strip()


def _skill_names(skills: Any) -> list[str]:
    """Normalize REST ``skills`` blobs to English (or first available) names."""
    if not isinstance(skills, list):
        return []
    names: list[str] = []
    for skill in skills:
        if isinstance(skill, str) and skill.strip():
            names.append(skill.strip())
            continue
        if not isinstance(skill, dict):
            continue
        name = skill.get("name")
        if isinstance(name, str) and name.strip():
            names.append(name.strip())
        elif isinstance(name, dict):
            label = name.get("en") or next(
                (v for v in name.values() if isinstance(v, str) and v.strip()),
                None,
            )
            if label:
                names.append(str(label).strip())
    return names


def _unix_ts(dt: datetime | None) -> int | None:
    if dt is None:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return int(dt.replace(tzinfo=timezone.utc).timestamp())


class WelcomeToTheJungleSpider(BaseJobSpider):
    name = "welcometothejungle"
    source_name = "welcometothejungle"
    base_url = "https://www.welcometothejungle.com"
    allowed_domains = ["welcometothejungle.com", "algolia.net"]

    custom_settings = {
        "DOWNLOAD_DELAY": 0.35,
        "CONCURRENT_REQUESTS_PER_DOMAIN": 4,
        "DOWNLOAD_HANDLERS": {
            "http": "scrapy.core.downloader.handlers.http.HTTPDownloadHandler",
            "https": "scrapy.core.downloader.handlers.http.HTTPDownloadHandler",
        },
    }

    HITS_PER_PAGE = 50

    DEFAULT_SEARCH_TERMS = [
        "software engineer",
        "data engineer",
        "backend developer",
        "frontend developer",
        "full stack developer",
        "devops engineer",
        "machine learning",
        "product manager",
        "data scientist",
        "mobile developer",
    ]

    def __init__(
        self,
        mode: str = "remote_us",
        enrich_apply: str = "true",
        lookback_days: str | int | None = None,
        *args,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        self.mode = (mode or "remote_us").strip().lower()
        if self.mode not in ("remote_us", "keywords"):
            self.mode = "remote_us"
        self.enrich_apply = str(enrich_apply).lower() in ("1", "true", "yes", "")
        if lookback_days is None or str(lookback_days).strip() == "":
            self.lookback_days = DEFAULT_REMOTE_US_LOOKBACK_DAYS
        else:
            self.lookback_days = max(1, int(lookback_days))
        # Remote-US windows need the full Algolia page budget (50*20=1000).
        if self.mode == "remote_us":
            self.max_pages = ALGOLIA_PAGINATION_LIMIT // self.HITS_PER_PAGE

    async def start(self):
        if self.mode == "remote_us":
            for request in self._start_remote_us_windows():
                yield request
            return

        terms = [self.query] if self.query else self.DEFAULT_SEARCH_TERMS
        numeric_filters: list[str] = []
        if self.posted_since is not None or self.posted_until is not None:
            numeric_filters = self._numeric_filters_for_bounds(
                _unix_ts(self.posted_since) if self.posted_since else None,
                (_unix_ts(self.posted_until) + 1) if self.posted_until else None,
            )
        for term in terms:
            for request in self._make_algolia_request(
                query=term,
                page=0,
                facet_filters=None,
                numeric_filters=numeric_filters,
            ):
                yield request

    def _bound_end_ts(self) -> int:
        if self.posted_until is not None:
            return _unix_ts(self.posted_until) or int(datetime.now(timezone.utc).timestamp())
        return int(datetime.now(timezone.utc).timestamp()) + 1

    def _bound_start_ts(self) -> int:
        if self.posted_since is not None:
            return _unix_ts(self.posted_since) or 0
        end = self._bound_end_ts()
        return end - self.lookback_days * 86400

    def _start_remote_us_windows(self) -> Iterator[scrapy.Request]:
        """Yield Algolia requests covering remote-US via time windows.

        Windows are generated newest→oldest. Oversized windows are split in
        ``parse_listing`` after Algolia reports nbHits.
        """
        end_ts = self._bound_end_ts()
        start_floor = self._bound_start_ts()
        window = DEFAULT_WINDOW_SECONDS
        cursor_end = end_ts
        while cursor_end > start_floor:
            cursor_start = max(start_floor, cursor_end - window)
            yield from self._make_algolia_request(
                query="",
                page=0,
                facet_filters=REMOTE_US_FACET_FILTERS,
                numeric_filters=self._numeric_filters_for_bounds(cursor_start, cursor_end),
                meta_extra={
                    "window_start": cursor_start,
                    "window_end": cursor_end,
                },
            )
            cursor_end = cursor_start

    @staticmethod
    def _numeric_filters_for_bounds(start_ts: int | None, end_ts: int | None) -> list[str]:
        filters: list[str] = []
        if start_ts is not None:
            filters.append(f"published_at_timestamp>={int(start_ts)}")
        if end_ts is not None:
            filters.append(f"published_at_timestamp<{int(end_ts)}")
        return filters

    def _algolia_headers(self) -> dict[str, str]:
        return {
            "x-algolia-application-id": ALGOLIA_APP_ID,
            "x-algolia-api-key": ALGOLIA_API_KEY,
            "Content-Type": "application/json",
            "Referer": "https://www.welcometothejungle.com/",
            "Origin": "https://www.welcometothejungle.com",
        }

    def _make_algolia_request(
        self,
        *,
        query: str,
        page: int = 0,
        facet_filters: list[list[str]] | None = None,
        numeric_filters: list[str] | None = None,
        meta_extra: dict | None = None,
    ):
        body: dict[str, Any] = {
            "query": query,
            "hitsPerPage": self.HITS_PER_PAGE,
            "page": page,
        }
        if facet_filters:
            body["facetFilters"] = facet_filters
        if numeric_filters:
            body["numericFilters"] = numeric_filters

        meta = {
            "search_query": query,
            "page": page,
            "facet_filters": facet_filters,
            "numeric_filters": numeric_filters or [],
            "playwright": False,
        }
        if meta_extra:
            meta.update(meta_extra)

        yield scrapy.Request(
            ALGOLIA_URL,
            method="POST",
            body=json.dumps(body),
            headers=self._algolia_headers(),
            callback=self.parse_listing,
            meta=meta,
            dont_filter=True,
        )

    def parse_listing(self, response):
        try:
            data = json.loads(response.text)
        except json.JSONDecodeError:
            self.logger.error("Failed to parse Algolia response from %s", response.url)
            return

        hits = data.get("hits") or []
        nb_hits = int(data.get("nbHits") or 0)
        nb_pages = int(data.get("nbPages") or 0)
        current_page = int(data.get("page") or 0)
        query = response.meta.get("search_query", "")
        facet_filters = response.meta.get("facet_filters")
        numeric_filters = list(response.meta.get("numeric_filters") or [])
        window_start = response.meta.get("window_start")
        window_end = response.meta.get("window_end")

        self.logger.info(
            "WTTJ Algolia: mode=%s query=%r page=%d/%d nbHits=%d hits=%d window=%s..%s",
            self.mode,
            query,
            current_page + 1,
            nb_pages,
            nb_hits,
            len(hits),
            window_start,
            window_end,
        )

        # Split oversized windows (only on first page of a remote-US window).
        if (
            self.mode == "remote_us"
            and current_page == 0
            and window_start is not None
            and window_end is not None
            and nb_hits > ALGOLIA_PAGINATION_LIMIT
            and int(window_end) - int(window_start) > 1
        ):
            mid = (int(window_start) + int(window_end)) // 2
            self.logger.info(
                "WTTJ Algolia window oversized (nbHits=%d > %d); splitting %s..%s at %s",
                nb_hits,
                ALGOLIA_PAGINATION_LIMIT,
                window_start,
                window_end,
                mid,
            )
            for part_start, part_end in (
                (int(window_start), mid),
                (mid, int(window_end)),
            ):
                if part_end <= part_start:
                    continue
                yield from self._make_algolia_request(
                    query="",
                    page=0,
                    facet_filters=REMOTE_US_FACET_FILTERS,
                    numeric_filters=self._numeric_filters_for_bounds(part_start, part_end),
                    meta_extra={
                        "window_start": part_start,
                        "window_end": part_end,
                    },
                )
            return

        posted_dates: list[datetime | None] = []
        for hit in hits:
            posted_dates.append(self._hit_posted_at(hit))
            if self.enrich_apply:
                req = self._make_enrich_request(hit)
                if req is not None:
                    yield req
                else:
                    item = self._parse_hit(hit)
                    if item:
                        yield item
            else:
                item = self._parse_hit(hit)
                if item:
                    yield item

        if self._page_too_old(posted_dates):
            self.logger.info(
                "WTTJ stopping pagination for query=%r window=%s..%s: page older than posted_since",
                query,
                window_start,
                window_end,
            )
            return

        reachable_pages = min(nb_pages, self.max_pages)
        # Hard ceiling: never request past Algolia's 1000-hit window.
        max_reachable_page = ALGOLIA_PAGINATION_LIMIT // self.HITS_PER_PAGE  # exclusive index
        if current_page + 1 < reachable_pages and current_page + 1 < max_reachable_page:
            yield from self._make_algolia_request(
                query=query,
                page=current_page + 1,
                facet_filters=facet_filters,
                numeric_filters=numeric_filters,
                meta_extra={
                    "window_start": window_start,
                    "window_end": window_end,
                },
            )

    def _make_enrich_request(self, hit: dict) -> scrapy.Request | None:
        org = hit.get("organization") if isinstance(hit.get("organization"), dict) else {}
        org_slug = (org.get("slug") or "").strip()
        job_slug = (hit.get("slug") or "").strip()
        if not org_slug or not job_slug:
            return None

        url = f"{WTTJ_API_BASE}/organizations/{org_slug}/jobs/{job_slug}"
        return scrapy.Request(
            url,
            callback=self.parse_job_detail,
            errback=self._enrich_errback,
            headers={
                "Accept": "application/json",
                "Referer": "https://www.welcometothejungle.com/",
                "Origin": "https://www.welcometothejungle.com",
            },
            meta={
                "playwright": False,
                "algolia_hit": hit,
                "org_slug": org_slug,
                "job_slug": job_slug,
            },
            dont_filter=True,
        )

    def _enrich_errback(self, failure):
        hit = failure.request.meta.get("algolia_hit") or {}
        self.logger.warning(
            "WTTJ REST enrich failed for %s/%s: %s — yielding Algolia-only item",
            failure.request.meta.get("org_slug"),
            failure.request.meta.get("job_slug"),
            failure.value,
        )
        item = self._parse_hit(hit)
        if item:
            yield item

    def parse_job_detail(self, response):
        """Merge REST ``apply_url`` / richer fields onto the Algolia hit."""
        hit = response.meta.get("algolia_hit") or {}
        try:
            payload = json.loads(response.text)
        except json.JSONDecodeError:
            self.logger.warning("WTTJ REST non-JSON for %s", response.url)
            item = self._parse_hit(hit)
            if item:
                yield item
            return

        job = payload.get("job") if isinstance(payload, dict) else None
        if not isinstance(job, dict):
            item = self._parse_hit(hit)
            if item:
                yield item
            return

        item = self._parse_hit(hit, rest_job=job)
        if item:
            yield item

    def parse_job(self, response):
        """Unused — listing + REST enrich produce items."""
        return

    @staticmethod
    def _hit_posted_at(hit: dict) -> datetime | None:
        published = hit.get("published_at") or ""
        if not published:
            return None
        try:
            return datetime.fromisoformat(str(published).replace("Z", "+00:00"))
        except (ValueError, TypeError):
            return None

    def _listing_url(self, org_slug: str, job_slug: str, source_job_id: str) -> str:
        if org_slug and job_slug:
            return f"{self.base_url}/en/companies/{org_slug}/jobs/{job_slug}"
        return f"{self.base_url}/en/jobs/{source_job_id}"

    def _parse_hit(self, hit: dict, rest_job: dict | None = None) -> dict | None:
        title = (hit.get("name") or (rest_job or {}).get("name") or "").strip()
        if not title:
            return None

        org = hit.get("organization") if isinstance(hit.get("organization"), dict) else {}
        company_name = org.get("name", "") or ""
        org_slug = (org.get("slug") or "").strip()
        job_slug = (hit.get("slug") or (rest_job or {}).get("slug") or "").strip()
        source_job_id = str(
            hit.get("reference")
            or hit.get("objectID")
            or (rest_job or {}).get("reference")
            or job_slug
        )

        listing_url = self._listing_url(org_slug, job_slug, source_job_id)

        apply_url = None
        if isinstance(rest_job, dict):
            raw_apply = rest_job.get("apply_url")
            if isinstance(raw_apply, str):
                raw_apply = raw_apply.strip()
                if raw_apply.startswith(("http://", "https://")):
                    apply_url = raw_apply

        offices = hit.get("offices") or []
        location = ""
        if isinstance(offices, list) and offices:
            first = offices[0]
            if isinstance(first, dict):
                city = first.get("city") or ""
                country = first.get("country_code") or first.get("country") or ""
                location = f"{city}, {country}" if city and country else (city or country)

        remote_level = hit.get("remote") or (rest_job or {}).get("remote") or ""
        is_remote = remote_level in ("fulltime", "partial")

        def _text(val: Any) -> str:
            if not val:
                return ""
            if isinstance(val, list):
                return "\n".join(str(v) for v in val if v)
            return str(val)

        desc_parts = [
            _text(hit.get("summary")),
            _text(hit.get("profile")),
            _text(hit.get("key_missions")),
        ]
        description = "\n\n".join(p for p in desc_parts if p)

        if rest_job:
            rest_desc = _strip_html(rest_job.get("description"))
            rest_profile = _strip_html(rest_job.get("profile"))
            rest_missions = _text(rest_job.get("key_missions"))
            richer = "\n\n".join(p for p in (rest_desc, rest_profile, rest_missions) if p)
            if len(richer) > len(description):
                description = richer

        sal_min = hit.get("salary_yearly_minimum") or hit.get("salary_minimum")
        sal_max = hit.get("salary_yearly_maximum") or hit.get("salary_maximum")
        if rest_job:
            sal_min = sal_min or rest_job.get("salary_min") or rest_job.get("salary_yearly_minimum")
            sal_max = sal_max or rest_job.get("salary_max") or rest_job.get("salary_yearly_maximum")
        sal_currency = hit.get("salary_currency") or (rest_job or {}).get("salary_currency") or "EUR"
        sal_period = hit.get("salary_period") or (rest_job or {}).get("salary_period") or "yearly"

        salary_raw = None
        if sal_min:
            salary_raw = f"{sal_min}"
            if sal_max:
                salary_raw += f" - {sal_max}"
            salary_raw += f" {sal_currency}/{sal_period}"

        posted_at = self._hit_posted_at(hit)
        if posted_at is None and rest_job and rest_job.get("published_at"):
            try:
                posted_at = datetime.fromisoformat(
                    str(rest_job["published_at"]).replace("Z", "+00:00")
                )
            except (ValueError, TypeError):
                pass

        contract = hit.get("contract_type") or (rest_job or {}).get("contract_type") or ""
        experience = (
            hit.get("experience_level_minimum")
            or hit.get("experience_level")
            or (rest_job or {}).get("experience_level")
            or ""
        )

        tags: list[str] = []
        if rest_job:
            tags = _skill_names(rest_job.get("skills"))
        if not tags and isinstance(hit.get("skills"), list):
            raw_skills = hit.get("skills") or []
            if raw_skills and isinstance(raw_skills[0], dict):
                tags = _skill_names(raw_skills)
            else:
                tags = [t for t in raw_skills if isinstance(t, str) and t.strip()]

        # Promoter contract: origin_url = real ATS/apply URL; url = aggregator listing.
        return self.build_job_item(
            source_job_id=source_job_id,
            url=listing_url,
            origin_url=apply_url,
            title=title,
            company_name=company_name,
            location=location,
            is_remote=is_remote,
            salary_raw=salary_raw,
            salary_min_cents=int(float(sal_min) * 100) if sal_min else None,
            salary_max_cents=int(float(sal_max) * 100) if sal_max else None,
            salary_currency=sal_currency,
            salary_period=sal_period,
            description=description,
            job_type=str(contract).lower() if contract else None,
            experience_level=str(experience) if experience else None,
            tags=tags,
            posted_at=posted_at,
        )
