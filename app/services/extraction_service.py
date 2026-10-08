"""
Extraction pipeline: fetch web page content → clean to plain text → cache for analysis.

The extraction engine does NOT produce structured job data.  It produces clean
plain text from the page, stores it in Redis cache, and the downstream analysis
engine (LLM) determines the structured content.

Pipeline order:
  0. Apply / login / one-click URLs are mapped to the posting page
     (job_url_canonical.description_url)
  1. Vendor APIs by URL (Ashby / Lever / Workable / Workday / WTTJ /
     SmartRecruiters / Greenhouse) - no HTML required
  2. HTTP fetch (httpx, auto-falls-back to curl_cffi Chrome impersonation
     on 401/403 to bypass Lever/Workday/careers anti-bot)
     - SKIPPED for known job-aggregator domains (adzuna.com, etc.) that block
       all programmatic HTTP; browser render is tried directly instead.
     - SKIPPED when a strong vendor-API candidate already exists (>=500 chars)
  3. Ashby embed (?ashby_jid) / Greenhouse boards API / Lever embed / JSON-LD /
     Static HTML
  4. Browser render (Playwright) when on-page candidates are still thin
  5. Re-run vendor extractors on browser-rendered HTML for embedded ATSs
  Every candidate is classified as it arrives (posting_validity.classify_page):
  bot walls, error shells, closed notices, login walls, application forms,
  unrendered templates and careers indexes are set aside, so they neither
  win the pick nor stop the browser pass from running.
  6. Score candidates by JD keyword density (extraction_merge.pick_best_text)
  7. Cache in Redis for the analysis worker, or fail with the page's reason
     (closed, removed, blocked, not a description) so the job is hidden
"""

from urllib.parse import urlparse

from app.models.schemas import ExtractionMethod, ExtractionStatus
from app.storage.database import get_session
from app.storage.repository import JobExtractionRepository, JobRepository
from app.services.http_client import HTTPService
from app.services.extraction_cache import ExtractionCache, ExtractionContent
from app.services.extraction_merge import pick_best_text
from app.services.validator import validate_extracted_text
from app.extractors.api_detector import APIDetectorExtractor
from app.extractors.ashby_api_extractor import AshbyApiExtractor, parse_ashby_jid_from_url
from app.extractors.embedded_job_data_extractor import EmbeddedJobDataExtractor
from app.extractors.greenhouse_board_extractor import (
    GreenhouseBoardExtractor,
    greenhouse_board_tokens_from_url,
    parse_greenhouse_job_id_from_url,
)
from app.extractors.lever_api_extractor import LeverApiExtractor, is_lever_job_url
from app.extractors.smartrecruiters_api_extractor import (
    SmartRecruitersApiExtractor,
    is_smartrecruiters_job_url,
)
from app.services.job_url_canonical import description_url
from app.services.posting_validity import PageIssue, classify_page, has_description_body
from app.extractors.workable_api_extractor import (
    WorkableApiExtractor,
    is_workable_job_url,
    parse_workable_shortcode_from_url,
)
from app.extractors.workday_extractor import WorkdayExtractor, is_workday_job_url
from app.extractors.wttj_algolia_extractor import WttjAlgoliaExtractor, is_wttj_job_url
from app.extractors.html_extractor import HTMLExtractor
from app.extractors.browser_extractor import BrowserExtractor
from app.core.logging import bind_logging_context, get_logger

logger = get_logger(__name__)

# Job-aggregator domains that block all programmatic HTTP access (Cloudflare,
# custom bot detection, etc.).  For these, the HTTP fetch steps are skipped
# entirely and the browser extractor is tried directly - saving several
# wasted round-trips and producing a clearer failure message when even
# Playwright can't get through.
#
# This is a defence-in-depth measure.  The Adzuna spider now resolves the
# real employer URL at scrape time, so most Adzuna jobs won't reach here with
# an adzuna.com URL.  The set covers the fallback case (redirect failed at
# scrape time, Adzuna URL stored as-is).
_AGGREGATOR_DOMAINS: frozenset[str] = frozenset({
    "adzuna.com",
    "www.adzuna.com",
    "ziprecruiter.com",
    "www.ziprecruiter.com",
    "indeed.com",
    "www.indeed.com",
    "glassdoor.com",
    "www.glassdoor.com",
})


def _is_aggregator_domain(url: str) -> bool:
    """Return True if *url* belongs to a known job-aggregator that blocks HTTP."""
    try:
        host = urlparse(url).netloc.lower()
        return any(
            host == d or host.endswith("." + d)
            for d in _AGGREGATOR_DOMAINS
        )
    except Exception:
        return False


def _is_adzuna_tracking_url(url: str) -> bool:
    """Detect Adzuna session-bound click-tracking URLs.

    These have the form ``/land/ad/<id>?se=<token>&v=<hmac>`` and are only
    valid for a short window after the spider runs.  When the token expires
    Adzuna stalls / hangs the TCP connection instead of returning a quick
    4xx, causing Playwright to burn its full 30-second timeout.
    """
    return "adzuna.com/land/ad/" in url and "se=" in url


def _fill_structured_gaps(best: dict | None, embedded: dict | None) -> dict | None:
    """Keep the page's embedded ATS fields even when another candidate's text won."""
    if not embedded:
        return best
    if not best:
        return dict(embedded)
    merged = dict(best)
    for key, value in embedded.items():
        if value and not merged.get(key):
            merged[key] = value
    return merged


class ExtractionService:
    def __init__(self):
        self.http_service = HTTPService()
        self.ashby_api_extractor = AshbyApiExtractor(self.http_service)
        self.lever_api_extractor = LeverApiExtractor(self.http_service)
        self.workable_api_extractor = WorkableApiExtractor(self.http_service)
        self.workday_extractor = WorkdayExtractor(self.http_service)
        self.smartrecruiters_api_extractor = SmartRecruitersApiExtractor(self.http_service)
        self.api_extractor = APIDetectorExtractor()
        self.embedded_job_extractor = EmbeddedJobDataExtractor()
        self.html_extractor = HTMLExtractor()
        self.browser_extractor = BrowserExtractor()
        self.greenhouse_board_extractor = GreenhouseBoardExtractor(self.http_service)
        self.wttj_algolia_extractor = WttjAlgoliaExtractor(self.http_service)
        self.cache = ExtractionCache()

    async def process_job(self, job_id: str, url: str) -> dict:
        bind_logging_context(extraction_id=job_id, target_url=url)
        logger.info("extraction_service_started", job_id=job_id, url=url)

        async with get_session() as session:
            repository = JobExtractionRepository(session)
            await repository.update_status(job_id, ExtractionStatus.PROCESSING)

        # ── Pre-step: resolve Adzuna session tracking URLs ──────────────────
        # Jobs scraped before the spider fix was deployed (or when the spider
        # fallback fires) may have ``/land/ad/?se=<token>`` stored as their URL.
        # These tokens expire quickly.  When expired, Adzuna *stalls* the TCP
        # connection instead of returning a quick 4xx, so Playwright burns its
        # full 30-second timeout before failing.
        #
        # Strategy:
        #   1. Try to follow the redirect with curl_cffi (~10s timeout).
        #      If the token is still valid we get the real employer URL and
        #      can run the full extraction pipeline against it.
        #   2. If the redirect is blocked / times out, fail fast immediately
        #      with a clear message - no point hanging in Playwright.
        if _is_adzuna_tracking_url(url):
            resolved = await self.http_service.resolve_redirect(url, timeout=10.0)
            if resolved and "adzuna.com" not in resolved:
                logger.info(
                    "adzuna_tracking_url_resolved",
                    job_id=job_id,
                    original_url=url,
                    resolved_url=resolved,
                )
                url = resolved  # Continue with the real employer URL
            else:
                # Token is stale - fail fast rather than letting Playwright
                # hang for 30+ seconds on a connection that will never load.
                logger.warning(
                    "adzuna_tracking_url_expired",
                    job_id=job_id,
                    url=url,
                    resolved=resolved,
                )
                return await self._mark_failed(
                    job_id,
                    "Adzuna session token has expired. Re-run the spider to "
                    "refresh job URLs, then rerun extraction.",
                )
        # ────────────────────────────────────────────────────────────────────

        fetch_url = description_url(url)
        if fetch_url != url:
            logger.info("extraction_description_url", job_id=job_id, original_url=url, fetch_url=fetch_url)
            url = fetch_url

        candidates: list[tuple[str, str, dict | None]] = []
        rejected: list[PageIssue] = []
        vendor_gone: str | None = None
        last_error: str | None = None
        embedded_structured: dict | None = None

        def add_candidate(item: tuple[str, str, dict | None]) -> None:
            text, method, _structured = item
            issue = classify_page(text)
            if issue:
                rejected.append(issue)
                logger.info(
                    "extraction_candidate_rejected",
                    job_id=job_id,
                    method=method,
                    reason=issue.reason,
                    evidence=issue.evidence,
                    content_length=len(text or ""),
                )
                return
            candidates.append(item)

        def note_vendor(vendor: str, result) -> None:
            nonlocal vendor_gone, last_error
            if result.error:
                last_error = result.error
                logger.warning(f"{vendor}_extract_failed", job_id=job_id, error=result.error, closed=result.closed)
            if result.closed and not vendor_gone:
                vendor_gone = vendor

        async def _collect_embedded(page_html: str | None) -> None:
            nonlocal embedded_structured
            if embedded_structured or not await self.embedded_job_extractor.can_extract(url, page_html):
                return
            emb_job = await self.embedded_job_extractor.extract(url, page_html)
            if emb_job.structured_data:
                embedded_structured = emb_job.structured_data
            if emb_job.success and emb_job.raw_content:
                add_candidate((emb_job.raw_content, ExtractionMethod.API_VENDOR.value, emb_job.structured_data))

        try:
            # 1a. Ashby public API (native URL - no HTML needed)
            # 1a-1f. Vendor APIs addressed by the URL itself (no HTML needed):
            # Ashby, Lever, Workable, Workday cxs, WTTJ Algolia (bypasses AWS
            # WAF), SmartRecruiters (bypasses its bot wall), and Greenhouse
            # boards when the token and job id are both in the URL.
            native_vendors = (
                ("ashby_api", await self.ashby_api_extractor.can_extract(url), self.ashby_api_extractor),
                ("lever_api", is_lever_job_url(url), self.lever_api_extractor),
                ("workable_api", is_workable_job_url(url), self.workable_api_extractor),
                ("workday", is_workday_job_url(url), self.workday_extractor),
                ("wttj_algolia", is_wttj_job_url(url), self.wttj_algolia_extractor),
                ("smartrecruiters_api", is_smartrecruiters_job_url(url), self.smartrecruiters_api_extractor),
                (
                    "greenhouse_api",
                    bool(parse_greenhouse_job_id_from_url(url) and greenhouse_board_tokens_from_url(url)),
                    self.greenhouse_board_extractor,
                ),
            )
            for vendor, applies, extractor in native_vendors:
                if not applies:
                    continue
                logger.info(f"{vendor}_attempt", job_id=job_id)
                result = await extractor.extract(url)
                if result.success and result.raw_content:
                    add_candidate((result.raw_content, ExtractionMethod.API_VENDOR.value, result.structured_data))
                else:
                    note_vendor(vendor, result)

            # Strong vendor hit, skip HTTP + browser (avoids repeating slow failures).
            early_best, early_method, early_structured = pick_best_text(candidates)
            if len(early_best) >= 500:
                logger.info(
                    "extraction_early_vendor_success",
                    job_id=job_id,
                    method=early_method,
                    content_length=len(early_best),
                )
                return await self._cache_and_mark_extracted(
                    job_id, url, early_best, early_method,
                    structured_data=early_structured,
                )

            # 2. Fetch HTML (httpx → curl_cffi auto-fallback on 401/403)
            # Skip when WTTJ Algolia already produced a strong candidate, or for
            # known aggregator domains whose Cloudflare protection blocks HTTP.
            html_content: str | None = None
            skip_http = _is_aggregator_domain(url) or is_wttj_job_url(url)
            if skip_http:
                if _is_aggregator_domain(url):
                    logger.info(
                        "http_fetch_skipped_aggregator_domain",
                        job_id=job_id,
                        url=url,
                        reason="Known aggregator domain blocks HTTP; attempting browser only",
                    )
                    last_error = "Aggregator domain - HTTP fetch skipped"
                elif is_wttj_job_url(url):
                    logger.info(
                        "http_fetch_skipped_wttj",
                        job_id=job_id,
                        url=url,
                        reason="WTTJ uses AWS WAF; using Algolia API + browser fallback",
                    )
            else:
                try:
                    html_content, status_code, headers = await self.http_service.fetch(url)
                except Exception as e:
                    last_error = str(e) or type(e).__name__
                    logger.warning("http_fetch_failed_will_try_browser", job_id=job_id, error=last_error)

            if html_content is not None:
                # 2b. ATS job record embedded in the page (Rippling __NEXT_DATA__, UKG)
                await _collect_embedded(html_content)

                # 3. Ashby embed (?ashby_jid=)
                if parse_ashby_jid_from_url(url):
                    emb = await self.ashby_api_extractor.extract_embedded(url, html_content)
                    if emb.success and emb.raw_content:
                        add_candidate((emb.raw_content, ExtractionMethod.API_VENDOR.value, emb.structured_data))
                    elif emb.error:
                        logger.debug("ashby_embedded_not_used", job_id=job_id, error=emb.error)

                # 4. Greenhouse board API
                if await self.greenhouse_board_extractor.can_extract(url, html_content):
                    gh = await self.greenhouse_board_extractor.extract(url, html_content)
                    if gh.success and gh.raw_content:
                        add_candidate((gh.raw_content, ExtractionMethod.API_VENDOR.value, gh.structured_data))
                    elif gh.error:
                        logger.debug("greenhouse_board_api_not_used", job_id=job_id, error=gh.error)

                # 4b. Lever embedded (careers page embeds a Lever posting)
                if not is_lever_job_url(url):
                    if await self.lever_api_extractor.can_extract(url, html_content):
                        lev_emb = await self.lever_api_extractor.extract(url, html_content)
                        if lev_emb.success and lev_emb.raw_content:
                            add_candidate((lev_emb.raw_content, ExtractionMethod.API_VENDOR.value, lev_emb.structured_data))
                        elif lev_emb.error:
                            logger.debug("lever_embedded_not_used", job_id=job_id, error=lev_emb.error)

                # 4c. Workable embedded (careers page embeds a Workable widget)
                if not is_workable_job_url(url) and parse_workable_shortcode_from_url(url):
                    if await self.workable_api_extractor.can_extract(url, html_content):
                        wk_emb = await self.workable_api_extractor.extract(url, html_content)
                        if wk_emb.success and wk_emb.raw_content:
                            add_candidate((wk_emb.raw_content, ExtractionMethod.API_VENDOR.value, wk_emb.structured_data))
                        elif wk_emb.error:
                            logger.debug("workable_embedded_not_used", job_id=job_id, error=wk_emb.error)

                # 5. JSON-LD
                if await self.api_extractor.can_extract(url, html_content):
                    ld_result = await self.api_extractor.extract(url, html_content)
                    if ld_result.success and ld_result.raw_content:
                        add_candidate((ld_result.raw_content, ExtractionMethod.API_JSON_LD.value, ld_result.structured_data))
                    elif ld_result.error:
                        last_error = ld_result.error

                # 6. Static HTML (full page text)
                html_result = await self.html_extractor.extract(url, html_content)
                if html_result.success and html_result.raw_content:
                    add_candidate((html_result.raw_content, ExtractionMethod.STATIC_HTML.value, html_result.structured_data))
                elif html_result.error:
                    last_error = html_result.error

            # 7. Browser rendering - try if available and no strong candidate yet
            best_so_far, _best_method, _best_structured = pick_best_text(candidates)
            needs_browser = len(best_so_far) < 500 and not (
                is_wttj_job_url(url) and len(best_so_far) >= 300
            )

            if needs_browser and await self.browser_extractor.can_extract(url):
                browser_result = await self.browser_extractor.extract(url)
                if browser_result.success and browser_result.raw_content:
                    add_candidate((browser_result.raw_content, ExtractionMethod.BROWSER_RENDER.value, browser_result.structured_data))

                    # Re-run vendor extractors on browser-rendered HTML - many
                    # SPAs only reveal Greenhouse/Lever/Ashby tokens after JS runs.
                    rendered_html = browser_result.html or browser_result.raw_content

                    await _collect_embedded(rendered_html)

                    if await self.greenhouse_board_extractor.can_extract(url, rendered_html):
                        gh_br = await self.greenhouse_board_extractor.extract(url, rendered_html)
                        if gh_br.success and gh_br.raw_content:
                            add_candidate((gh_br.raw_content, ExtractionMethod.API_VENDOR.value, gh_br.structured_data))

                    if not is_lever_job_url(url):
                        if await self.lever_api_extractor.can_extract(url, rendered_html):
                            lev_br = await self.lever_api_extractor.extract(url, rendered_html)
                            if lev_br.success and lev_br.raw_content:
                                add_candidate((lev_br.raw_content, ExtractionMethod.API_VENDOR.value, lev_br.structured_data))

                    if parse_ashby_jid_from_url(url):
                        ash_br = await self.ashby_api_extractor.extract_embedded(url, rendered_html)
                        if ash_br.success and ash_br.raw_content:
                            add_candidate((ash_br.raw_content, ExtractionMethod.API_VENDOR.value, ash_br.structured_data))

                    if not is_workable_job_url(url) and parse_workable_shortcode_from_url(url):
                        if await self.workable_api_extractor.can_extract(url, rendered_html):
                            wk_br = await self.workable_api_extractor.extract(url, rendered_html)
                            if wk_br.success and wk_br.raw_content:
                                add_candidate((wk_br.raw_content, ExtractionMethod.API_VENDOR.value, wk_br.structured_data))

                    if await self.api_extractor.can_extract(url, rendered_html):
                        ld_br = await self.api_extractor.extract(url, rendered_html)
                        if ld_br.success and ld_br.raw_content:
                            add_candidate((ld_br.raw_content, ExtractionMethod.API_JSON_LD.value, ld_br.structured_data))
                elif browser_result.error:
                    last_error = browser_result.error
            elif needs_browser:
                logger.info(
                    "browser_skipped", url=url,
                    reason="Playwright browsers not installed - run 'playwright install'",
                )

            # 8. Pick best result and cache
            best_text, best_method, best_structured = pick_best_text(candidates)
            best_structured = _fill_structured_gaps(best_structured, embedded_structured)

            issue = _primary_issue(rejected)
            if best_text and not _gone_overrides(best_text, candidates, issue, vendor_gone):
                return await self._cache_and_mark_extracted(
                    job_id, url, best_text, best_method, structured_data=best_structured,
                )
            if best_text:
                logger.info(
                    "extraction_gone_overrides_candidate",
                    job_id=job_id,
                    method=best_method,
                    content_length=len(best_text),
                    page_issue=issue.reason if issue else None,
                    vendor_gone=vendor_gone,
                )

            if not vendor_gone and (issue is None or issue.reason in _FALLBACK_REASONS):
                fallback = await self._try_scraped_description_fallback(job_id, url)
                if fallback and validate_extracted_text(fallback[0]).is_valid:
                    fallback_text, fallback_method = fallback
                    logger.info(
                        "extraction_scraped_description_fallback",
                        job_id=job_id,
                        content_length=len(fallback_text),
                        page_issue=issue.reason if issue else None,
                    )
                    return await self._cache_and_mark_extracted(
                        job_id, url, fallback_text, fallback_method,
                        structured_data=embedded_structured,
                    )
            return await self._mark_failed(job_id, _failure_message(issue, vendor_gone, last_error))

        except Exception as e:
            logger.error("extraction_service_failed", job_id=job_id, error=str(e))
            return await self._mark_failed(job_id, str(e))

    async def _try_scraped_description_fallback(
        self, job_id: str, url: str,
    ) -> tuple[str, str] | None:
        """Use scraper-stored description when live page fetch is WAF-blocked."""
        async with get_session() as session:
            valid_repo = JobRepository(session)
            valid_job = await valid_repo.get_by_extraction_id(job_id)
            if not valid_job:
                return None

            description = (valid_job.description or "").strip()
            if len(description) < MIN_SCRAPED_FALLBACK_LENGTH:
                return None

            meta = valid_job.raw_metadata or {}
            if not meta.get("promoted_from_scraper"):
                return None

            title = (valid_job.title or "").strip()
            company = (valid_job.company or "").strip()
            location = (valid_job.location or "").strip()

            parts = []
            if title:
                parts.append(f"Title: {title}")
            if company:
                parts.append(f"Company: {company}")
            if location:
                parts.append(f"Location: {location}")
            parts.append("")
            parts.append(description)

            plain_text = "\n".join(parts).strip()
            if len(plain_text) < MIN_SCRAPED_FALLBACK_LENGTH:
                return None

            source = meta.get("scraped_source") or "scraper"
            logger.info(
                "scraped_description_fallback_available",
                job_id=job_id,
                scraped_source=source,
                content_length=len(plain_text),
            )
            return plain_text, ExtractionMethod.STATIC_HTML.value

    async def _cache_and_mark_extracted(
        self, job_id: str, url: str, plain_text: str, method: str,
        structured_data: dict | None = None,
    ) -> dict:
        content = ExtractionContent.create(
            plain_text=plain_text,
            source_url=url,
            extraction_method=method,
        )
        await self.cache.store(job_id, content)

        method_enum = ExtractionMethod(method) if method != "none" else ExtractionMethod.STATIC_HTML
        async with get_session() as session:
            repository = JobExtractionRepository(session)
            await repository.update_status(job_id, ExtractionStatus.EXTRACTED)
            await repository.update_extraction_method(job_id, method_enum)
            # Persist the original plain text permanently so any user can run
            # analysis later without re-fetching the job posting.
            await repository.save_raw_plain_text(job_id, plain_text)

        try:
            from app.services.job_metadata_hydrator import hydrate_job_metadata
            from app.storage.repository import JobRepository
            async with get_session() as session:
                job = await JobRepository(session).get_by_extraction_id(job_id)
                job_pk = job.id if job else None
            if job_pk:
                await hydrate_job_metadata(
                    job_id=job_pk,
                    extraction_id=job_id,
                    plain_text=plain_text,
                    source_url=url,
                    structured_data=structured_data,
                    mark_completed=False,
                )
        except Exception as hydrate_err:
            logger.warning(
                "extraction_metadata_hydrate_failed",
                job_id=job_id,
                error=str(hydrate_err),
            )

        logger.info(
            "extraction_completed_cached",
            job_id=job_id,
            method=method,
            content_length=len(plain_text),
        )

        return {
            "job_id": job_id,
            "status": "extracted",
            "method": method,
            "content_length": len(plain_text),
        }

    async def _mark_failed(self, job_id: str, error: str) -> dict:
        async with get_session() as session:
            repository = JobExtractionRepository(session)
            await repository.update_status(job_id, ExtractionStatus.FAILED, error)

        unreachable = _is_site_unreachable_error(error)
        logger.error("extraction_failed_final", job_id=job_id, error=error, site_unreachable=unreachable)
        return {
            "job_id": job_id,
            "status": "failed",
            "error": error,
            "site_unreachable": unreachable,
        }


_UNREACHABLE_PATTERNS = (
    "timeout",
    "timed out",
    "TimeoutError",
    "ReadTimeout",
    "ConnectTimeout",
    "TimeoutException",
    "connect_error",
    "Name or service not known",
    "No address associated",
    "nodename nor servname",
    "getaddrinfo failed",
    "Connection refused",
    "Network is unreachable",
    "No route to host",
    "Connection reset",
    "SSL: CERTIFICATE_VERIFY_FAILED",
    "HTTP error 502",
    "HTTP error 503",
    "HTTP error 504",
    "HTTP error 521",
    "HTTP error 522",
    "HTTP error 523",
    "HTTP error 524",
    "bot protection",
    "aws waf",
    "waf challenge",
)

MIN_SCRAPED_FALLBACK_LENGTH = 100

# Most specific first: a closed notice explains a page better than the bot
# wall another fetch path hit.
_ISSUE_PRIORITY = (
    "closed", "not_found", "careers_index", "login_wall", "blocked",
    "error_page", "apply_form", "unrendered", "too_thin",
)
_GONE_REASONS = frozenset({"closed", "not_found"})
# The page itself was unreadable, so the scraper's stored description is the
# best copy left. Closed, removed and index pages mean the job is gone.
_FALLBACK_REASONS = frozenset({"blocked", "login_wall", "error_page", "apply_form", "unrendered", "too_thin"})

_VENDOR_NAMES = {
    "ashby_api": "Ashby",
    "lever_api": "Lever",
    "greenhouse_api": "Greenhouse",
    "smartrecruiters_api": "SmartRecruiters",
}


def _gone_overrides(
    best_text: str,
    candidates: list[tuple[str, str, dict | None]],
    issue: PageIssue | None,
    vendor_gone: str | None,
) -> bool:
    """Whether a "closed" or "removed" signal outranks the best usable text.

    The site saying so on its own page wins over every other page text
    (Phenom serves "has been filled" while its browser render shows only
    navigation and similar jobs); only a live vendor API record outranks it.
    A vendor API 404 alone wins only over text without a description body,
    since the page may still show a posting the API does not list.
    """
    if issue is not None and issue.reason in _GONE_REASONS and not issue.weak:
        return not any(method == ExtractionMethod.API_VENDOR.value for _, method, _ in candidates)
    return bool(vendor_gone) and not has_description_body(best_text)


def _primary_issue(rejected: list[PageIssue]) -> PageIssue | None:
    if not rejected:
        return None
    rank = {reason: i for i, reason in enumerate(_ISSUE_PRIORITY)}
    return min(rejected, key=lambda issue: rank.get(issue.reason, len(rank)))


def _failure_message(issue: PageIssue | None, vendor_gone: str | None, last_error: str | None) -> str:
    """The reason shown in Hidden jobs when no candidate is a usable description."""
    if issue and issue.reason in _GONE_REASONS:
        label = "Posting closed" if issue.reason == "closed" else "Posting removed"
        return f"{label}: {issue.description} ('{issue.evidence}')"
    if vendor_gone:
        vendor = _VENDOR_NAMES.get(vendor_gone, vendor_gone)
        return f"Posting removed: {vendor} no longer publishes this posting"
    if issue and issue.reason == "blocked":
        return f"Blocked by bot protection: {issue.description} ('{issue.evidence}')"
    if issue:
        return f"Not a job description: {issue.description} ('{issue.evidence}')"
    message = "All extraction methods failed"
    return f"{message}: {last_error}" if last_error else message


def _is_site_unreachable_error(error: str) -> bool:
    """Heuristic: does the error string indicate the site itself is down or unreachable?"""
    lowered = error.lower()
    return any(p.lower() in lowered for p in _UNREACHABLE_PATTERNS)
