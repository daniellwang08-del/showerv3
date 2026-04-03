"""
Extraction pipeline: fetch web page content → clean to plain text → cache for analysis.

The extraction engine does NOT produce structured job data.  It produces clean
plain text from the page, stores it in Redis cache, and the downstream analysis
engine (LLM) determines the structured content.

Pipeline order:
  1. Ashby API (native URL)
  2. HTTP fetch → Ashby embed / Greenhouse API / JSON-LD / Static HTML
  3. Browser render (Playwright)
  4. Pick best plain text from all successful attempts
  5. Cache in Redis for analysis worker
"""

from app.models.schemas import ExtractionMethod, ExtractionStatus
from app.storage.database import get_session
from app.storage.repository import JobExtractionRepository
from app.services.http_client import HTTPService
from app.services.extraction_cache import ExtractionCache, ExtractionContent
from app.services.extraction_merge import pick_best_text
from app.services.validator import validate_extracted_text
from app.extractors.api_detector import APIDetectorExtractor
from app.extractors.ashby_api_extractor import AshbyApiExtractor, parse_ashby_jid_from_url
from app.extractors.greenhouse_board_extractor import GreenhouseBoardExtractor
from app.extractors.html_extractor import HTMLExtractor
from app.extractors.browser_extractor import BrowserExtractor
from app.core.logging import bind_logging_context, get_logger

logger = get_logger(__name__)


class ExtractionService:
    def __init__(self):
        self.http_service = HTTPService()
        self.ashby_api_extractor = AshbyApiExtractor(self.http_service)
        self.api_extractor = APIDetectorExtractor()
        self.html_extractor = HTMLExtractor()
        self.browser_extractor = BrowserExtractor()
        self.greenhouse_board_extractor = GreenhouseBoardExtractor(self.http_service)
        self.cache = ExtractionCache()

    async def process_job(self, job_id: str, url: str) -> dict:
        bind_logging_context(extraction_id=job_id, target_url=url)
        logger.info("extraction_service_started", job_id=job_id, url=url)

        async with get_session() as session:
            repository = JobExtractionRepository(session)
            await repository.update_status(job_id, ExtractionStatus.PROCESSING)

        candidates: list[tuple[str, str]] = []
        last_error: str | None = None

        try:
            # 1. Try Ashby public API (native URL — no HTML needed)
            if await self.ashby_api_extractor.can_extract(url):
                logger.info("ashby_api_attempt", job_id=job_id)
                result = await self.ashby_api_extractor.extract(url)
                if result.success and result.raw_content:
                    candidates.append((result.raw_content, ExtractionMethod.API_VENDOR.value))
                elif result.error:
                    last_error = result.error
                    logger.warning("ashby_api_extract_failed", job_id=job_id, error=result.error)

            # 2. Fetch HTML
            html_content: str | None = None
            try:
                html_content, status_code, headers = await self.http_service.fetch(url)
            except Exception as e:
                last_error = str(e) or type(e).__name__
                logger.warning("http_fetch_failed_will_try_browser", job_id=job_id, error=last_error)

            if html_content is not None:
                # 3. Ashby embed (?ashby_jid=)
                if parse_ashby_jid_from_url(url):
                    emb = await self.ashby_api_extractor.extract_embedded(url, html_content)
                    if emb.success and emb.raw_content:
                        candidates.append((emb.raw_content, ExtractionMethod.API_VENDOR.value))
                    elif emb.error:
                        logger.debug("ashby_embedded_not_used", job_id=job_id, error=emb.error)

                # 4. Greenhouse board API
                if await self.greenhouse_board_extractor.can_extract(url, html_content):
                    gh = await self.greenhouse_board_extractor.extract(url, html_content)
                    if gh.success and gh.raw_content:
                        candidates.append((gh.raw_content, ExtractionMethod.API_VENDOR.value))
                    elif gh.error:
                        logger.debug("greenhouse_board_api_not_used", job_id=job_id, error=gh.error)

                # 5. JSON-LD
                if await self.api_extractor.can_extract(url, html_content):
                    ld_result = await self.api_extractor.extract(url, html_content)
                    if ld_result.success and ld_result.raw_content:
                        candidates.append((ld_result.raw_content, ExtractionMethod.API_JSON_LD.value))
                    elif ld_result.error:
                        last_error = ld_result.error

                # 6. Static HTML (full page text)
                html_result = await self.html_extractor.extract(url, html_content)
                if html_result.success and html_result.raw_content:
                    candidates.append((html_result.raw_content, ExtractionMethod.STATIC_HTML.value))
                elif html_result.error:
                    last_error = html_result.error

            # 7. Browser rendering — always try if available and no strong candidate yet
            best_so_far, _ = pick_best_text(candidates)
            needs_browser = len(best_so_far) < 500

            if needs_browser and await self.browser_extractor.can_extract(url):
                browser_result = await self.browser_extractor.extract(url)
                if browser_result.success and browser_result.raw_content:
                    candidates.append((browser_result.raw_content, ExtractionMethod.BROWSER_RENDER.value))

                    # Also try Greenhouse API on browser-rendered HTML
                    if await self.greenhouse_board_extractor.can_extract(url, browser_result.raw_content):
                        gh_br = await self.greenhouse_board_extractor.extract(url, browser_result.raw_content)
                        if gh_br.success and gh_br.raw_content:
                            candidates.append((gh_br.raw_content, ExtractionMethod.API_VENDOR.value))

                    # Try JSON-LD on rendered HTML
                    if await self.api_extractor.can_extract(url, browser_result.raw_content):
                        ld_br = await self.api_extractor.extract(url, browser_result.raw_content)
                        if ld_br.success and ld_br.raw_content:
                            candidates.append((ld_br.raw_content, ExtractionMethod.API_JSON_LD.value))
                elif browser_result.error:
                    last_error = browser_result.error
            elif needs_browser:
                logger.info(
                    "browser_skipped", url=url,
                    reason="Playwright browsers not installed - run 'playwright install'",
                )

            # 8. Pick best result and cache
            best_text, best_method = pick_best_text(candidates)

            if not best_text:
                final_message = "All extraction methods failed"
                if last_error:
                    final_message = f"{final_message}: {last_error}"
                return await self._mark_failed(job_id, final_message)

            validation = validate_extracted_text(best_text)
            if not validation.is_valid:
                return await self._mark_failed(job_id, f"Validation failed: {', '.join(validation.errors)}")

            return await self._cache_and_mark_extracted(job_id, url, best_text, best_method)

        except Exception as e:
            logger.error("extraction_service_failed", job_id=job_id, error=str(e))
            return await self._mark_failed(job_id, str(e))

    async def _cache_and_mark_extracted(
        self, job_id: str, url: str, plain_text: str, method: str,
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
)


def _is_site_unreachable_error(error: str) -> bool:
    """Heuristic: does the error string indicate the site itself is down or unreachable?"""
    lowered = error.lower()
    return any(p.lower() in lowered for p in _UNREACHABLE_PATTERNS)
