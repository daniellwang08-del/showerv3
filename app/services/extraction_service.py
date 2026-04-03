from datetime import datetime
from app.models.schemas import ExtractionMethod, ExtractionStatus, JobDescriptionSchema
from app.utils.text_sanitizer import sanitize_for_postgres_text
from app.storage.database import get_session
from app.storage.repository import JobExtractionRepository, ValidJobRepository
from app.services.http_client import HTTPService
from app.services.validator import validate_job_data
from app.extractors.api_detector import APIDetectorExtractor
from app.extractors.ashby_api_extractor import AshbyApiExtractor, parse_ashby_jid_from_url
from app.extractors.greenhouse_board_extractor import GreenhouseBoardExtractor
from app.extractors.html_extractor import HTMLExtractor
from app.extractors.browser_extractor import BrowserExtractor
from app.core.logging import bind_logging_context, get_logger
from app.services.extraction_merge import (
    description_len,
    is_rich_description,
    merge_structured_job_data,
    skip_early_static_html_exit,
)

logger = get_logger(__name__)

class ExtractionService:
    def __init__(self):
        self.http_service = HTTPService()
        self.ashby_api_extractor = AshbyApiExtractor(self.http_service)
        self.api_extractor = APIDetectorExtractor()
        self.html_extractor = HTMLExtractor()
        self.browser_extractor = BrowserExtractor()
        self.greenhouse_board_extractor = GreenhouseBoardExtractor(self.http_service)

    async def process_job(self, job_id: str, url: str) -> dict:
        bind_logging_context(extraction_id=job_id, target_url=url)
        logger.info("extraction_service_started", job_id=job_id, url=url)

        async with get_session() as session:
            repository = JobExtractionRepository(session)
            await repository.update_status(job_id, ExtractionStatus.PROCESSING)

        last_error: str | None = None
        try:
            # 1. Try Ashby public API first (no HTML fetch - direct API call)
            if await self.ashby_api_extractor.can_extract(url):
                logger.info("ashby_api_attempt", job_id=job_id, url=url)
                result = await self.ashby_api_extractor.extract(url)
                if result.success and result.structured_data:
                    return await self._finalize_extraction(
                        job_id,
                        result.structured_data,
                        result.method,
                        result.confidence,
                        result.raw_content or "",
                    )
                if result.error:
                    last_error = result.error
                    logger.warning("ashby_api_extract_failed", job_id=job_id, url=url, error=result.error)

            # 2. Fetch HTML for other extractors
            html_content: str | None = None
            try:
                html_content, status_code, headers = await self.http_service.fetch(url)
            except Exception as e:
                last_error = str(e)
                logger.warning("http_fetch_failed_will_try_browser", job_id=job_id, url=url, error=str(e))

            pending: dict | None = None
            pending_raw_html: str = html_content or ""

            if html_content is not None:
                # 3. Ashby embed on company domains (?ashby_jid=)
                if parse_ashby_jid_from_url(url):
                    emb = await self.ashby_api_extractor.extract_embedded(url, html_content)
                    if emb.success and emb.structured_data:
                        return await self._finalize_extraction(
                            job_id,
                            emb.structured_data,
                            emb.method,
                            emb.confidence,
                            emb.raw_content or html_content,
                        )
                    if emb.error:
                        logger.debug("ashby_embedded_not_used", job_id=job_id, error=emb.error)

                # 3b. Greenhouse board API
                gh_done = await self._greenhouse_board_api_finalize_if_ok(
                    job_id, url, html_content, html_content
                )
                if gh_done:
                    return gh_done

                # 4. JSON-LD
                if await self.api_extractor.can_extract(url, html_content):
                    result = await self.api_extractor.extract(url, html_content)
                    if result.success and result.structured_data:
                        if is_rich_description(result.structured_data) and not skip_early_static_html_exit(url):
                            return await self._finalize_extraction(
                                job_id,
                                result.structured_data,
                                result.method,
                                result.confidence,
                                html_content,
                            )
                        pending = dict(result.structured_data)
                        pending_raw_html = html_content
                    if result.error:
                        last_error = result.error

                # 5. Static HTML — merge with JSON-LD
                html_result = await self.html_extractor.extract(url, html_content)
                if html_result.success and html_result.structured_data:
                    merged = merge_structured_job_data(pending, html_result.structured_data)
                    if merged is None:
                        merged = html_result.structured_data
                    pending = merged
                    pending_raw_html = html_content
                    if is_rich_description(pending) and not skip_early_static_html_exit(url):
                        saved = await self._try_save(
                            job_id, pending, ExtractionMethod.STATIC_HTML, pending_raw_html,
                        )
                        if saved:
                            return saved
                elif html_result.error:
                    last_error = html_result.error

            # 6. Browser rendering
            if await self.browser_extractor.can_extract(url):
                browser_result = await self.browser_extractor.extract(url)
                if browser_result.error:
                    last_error = browser_result.error
                elif browser_result.success and browser_result.raw_content:
                    gh_browser = await self._greenhouse_board_api_finalize_if_ok(
                        job_id, url, browser_result.raw_content, browser_result.raw_content,
                    )
                    if gh_browser:
                        return gh_browser
                    merged_br = merge_structured_job_data(pending, browser_result.structured_data)
                    if merged_br is None:
                        merged_br = browser_result.structured_data
                    try:
                        ld_from_render = await self.api_extractor.extract(url, browser_result.raw_content)
                        if ld_from_render.success and ld_from_render.structured_data:
                            merged_br = merge_structured_job_data(merged_br, ld_from_render.structured_data)
                    except Exception as e:
                        logger.debug("browser_json_ld_enrich_skipped", job_id=job_id, error=str(e))
                    if merged_br is not None:
                        pending = merged_br
                    saved = await self._try_save(
                        job_id, merged_br, ExtractionMethod.BROWSER_RENDER, browser_result.raw_content,
                    )
                    if saved:
                        return saved
            else:
                logger.info(
                    "browser_skipped", url=url,
                    reason="Playwright browsers not installed - run 'playwright install'",
                )

            # 7. Last resort: save whatever we accumulated
            if pending and description_len(pending) >= 50:
                saved = await self._try_save(
                    job_id, pending, ExtractionMethod.STATIC_HTML, pending_raw_html,
                )
                if saved:
                    return saved

            final_message = "All extraction methods failed"
            if last_error:
                final_message = f"{final_message}: {last_error}"
            return await self._save_failed(job_id, final_message)

        except Exception as e:
            logger.error("extraction_service_failed", job_id=job_id, error=str(e))
            return await self._save_failed(job_id, str(e))

    async def _greenhouse_board_api_finalize_if_ok(
        self, job_id: str, url: str, html: str | None, raw_fallback: str,
    ) -> dict | None:
        if not html:
            return None
        if not await self.greenhouse_board_extractor.can_extract(url, html):
            return None
        gh = await self.greenhouse_board_extractor.extract(url, html)
        if gh.success and gh.structured_data:
            return await self._finalize_extraction(
                job_id, gh.structured_data, gh.method, gh.confidence or 0.97, gh.raw_content or raw_fallback,
            )
        if gh.error:
            logger.debug("greenhouse_board_api_not_used", job_id=job_id, error=gh.error)
        return None

    async def _try_save(
        self, job_id: str, structured: dict | None, method: ExtractionMethod, raw_html: str,
    ) -> dict | None:
        if not structured:
            return None
        return await self._finalize_extraction(job_id, structured, method, 0.8, raw_html)

    def _parse_posted_date(self, value) -> datetime | None:
        if isinstance(value, datetime):
            if value.tzinfo is not None:
                return value.replace(tzinfo=None)
            return value
        if not value or not isinstance(value, str):
            return None
        for fmt in ("%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%d"):
            try:
                parsed = datetime.strptime(value, fmt)
                if parsed.tzinfo is not None:
                    parsed = parsed.replace(tzinfo=None)
                return parsed
            except (ValueError, TypeError):
                continue
        return None

    async def _finalize_extraction(
        self, job_id: str, structured_data: dict, method: ExtractionMethod,
        confidence: float, raw_html: str,
    ) -> dict:
        logger.info(
            "finalize_extraction_started", job_id=job_id, method=method.value,
            has_title=bool(structured_data.get("title")),
            has_description="description" in structured_data,
        )

        job_data = JobDescriptionSchema(
            title=structured_data.get("title") or "Unknown Position",
            company=structured_data.get("company"),
            location=structured_data.get("location"),
            employment_type=structured_data.get("employment_type"),
            salary_range=structured_data.get("salary_range"),
            description=structured_data.get("description", ""),
            responsibilities=structured_data.get("responsibilities", []),
            requirements=structured_data.get("requirements", []),
            benefits=structured_data.get("benefits", []),
            posted_date=self._parse_posted_date(structured_data.get("posted_date")),
            remote_policy=structured_data.get("remote_policy"),
            experience_level=structured_data.get("experience_level"),
            industry=structured_data.get("industry"),
            raw_metadata=structured_data.get("raw_metadata", {}),
        )

        validation = validate_job_data(job_data, confidence)

        if validation.is_valid:
            return await self._save_result(job_id, job_data, method, validation.adjusted_confidence, raw_html)
        else:
            logger.warning(
                "finalize_extraction_validation_failed", job_id=job_id,
                errors=validation.errors, warnings=validation.warnings,
            )
            return await self._save_failed(job_id, f"Validation failed: {', '.join(validation.errors)}")

    async def _save_result(
        self, job_id: str, job_data: JobDescriptionSchema, method: ExtractionMethod,
        confidence: float, raw_html: str,
    ) -> dict:
        raw_html = sanitize_for_postgres_text(raw_html)
        async with get_session() as session:
            repository = JobExtractionRepository(session)
            await repository.update_extraction_result(job_id, job_data, method, confidence, raw_html)
            valid_repo = ValidJobRepository(session)
            valid_job = await valid_repo.get_by_extraction_id(job_id)
            await valid_repo.mark_scraped_by_extraction_id(job_id)
            await session.flush()

            if valid_job:
                await valid_repo.update_from_structured_extraction(valid_job.id, job_data)
            await session.commit()

        logger.info("extraction_completed", job_id=job_id, method=method.value, confidence=confidence)

        return {
            "job_id": job_id,
            "status": "completed",
            "method": method.value,
            "confidence": confidence,
        }

    async def _save_failed(self, job_id: str, error: str) -> dict:
        async with get_session() as session:
            repository = JobExtractionRepository(session)
            await repository.update_status(job_id, ExtractionStatus.FAILED, error)

        logger.error("extraction_failed_final", job_id=job_id, error=error)

        return {"job_id": job_id, "status": "failed", "error": error}
