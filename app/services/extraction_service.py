from datetime import datetime
from app.models.schemas import ExtractionMethod, ExtractionStatus, JobDescriptionSchema
from app.utils.text_sanitizer import sanitize_for_postgres_text
from app.storage.database import get_session
from app.storage.repository import JobExtractionRepository, ValidJobRepository
from app.services.http_client import HTTPService
from app.services.ai_parser import get_ai_parser
from app.services.validator import validate_job_data
from app.extractors.api_detector import APIDetectorExtractor
from app.extractors.ashby_api_extractor import AshbyApiExtractor
from app.extractors.html_extractor import HTMLExtractor
from app.extractors.browser_extractor import BrowserExtractor
from app.core.logging import bind_logging_context, get_logger
from app.core.exceptions import AIParsingError

logger = get_logger(__name__)

class ExtractionService:
    def __init__(self):
        self.http_service = HTTPService()
        self.ashby_api_extractor = AshbyApiExtractor(self.http_service)
        self.api_extractor = APIDetectorExtractor()
        self.html_extractor = HTMLExtractor()
        self.browser_extractor = BrowserExtractor()

    async def process_job(self, job_id: str, url: str) -> dict:
        """
        Process a job extraction request through the full pipeline.
        Returns a dictionary with the result status and metadata.
        """
        bind_logging_context(extraction_id=job_id, target_url=url)
        logger.info("extraction_service_started", job_id=job_id, url=url)

        # Update status to PROCESSING
        async with get_session() as session:
            repository = JobExtractionRepository(session)
            await repository.update_status(job_id, ExtractionStatus.PROCESSING)

        last_error: str | None = None
        try:
            # 1. Try Ashby public API first (no HTML fetch - direct API call)
            if await self.ashby_api_extractor.can_extract(url):
                logger.info("ashby_api_attempt", job_id=job_id, url=url)
                result = await self.ashby_api_extractor.extract(url)
                logger.info(
                    "ashby_api_result",
                    job_id=job_id,
                    success=result.success,
                    has_data=result.structured_data is not None,
                    confidence=result.confidence,
                    error=result.error,
                )
                if result.success and result.structured_data:
                    raw_content = result.raw_content or ""
                    return await self._finalize_extraction(
                        job_id,
                        result.structured_data,
                        result.method,
                        result.confidence,
                        raw_content,
                    )
                if result.error:
                    last_error = result.error
                    logger.warning("ashby_api_extract_failed", job_id=job_id, url=url, error=result.error)

            # 2. Fetch HTML for other extractors
            html_content, status_code, headers = await self.http_service.fetch(url)

            # 3. Try JSON-LD Extraction (schema.org JobPosting in <script type="application/ld+json">)
            if await self.api_extractor.can_extract(url, html_content):
                result = await self.api_extractor.extract(url, html_content)
                if result.success and result.structured_data:
                    return await self._finalize_extraction(
                        job_id,
                        result.structured_data,
                        result.method,
                        result.confidence,
                        html_content
                    )
                if result.error:
                    last_error = result.error

            # 4. Try HTML Extraction (readability + lxml)
            result = await self.html_extractor.extract(url, html_content)
            if result.success and result.structured_data:
                ai_parser = get_ai_parser()
                description = result.structured_data.get("description", html_content)
                try:
                    job_data, confidence = await ai_parser.parse(description)
                    self._merge_job_data(job_data, result.structured_data)
                    validation = validate_job_data(job_data, confidence)
                    if validation.is_valid:
                        return await self._save_result(
                            job_id,
                            job_data,
                            ExtractionMethod.STATIC_HTML,
                            validation.adjusted_confidence,
                            html_content
                        )
                    last_error = f"Validation failed: {', '.join(validation.errors)}"
                except AIParsingError as e:
                    last_error = f"AI parsing failed: {e}"
            elif result.error:
                last_error = result.error

            # 5. Try Browser Extraction (only if Playwright available)
            if await self.browser_extractor.can_extract(url):
                browser_result = await self.browser_extractor.extract(url)
                if browser_result.success and browser_result.raw_content:
                    ai_parser = get_ai_parser()

                    if browser_result.structured_data:
                        # Use extracted structured data from rendered HTML when available.
                        description = browser_result.structured_data.get("description", browser_result.raw_content)
                        try:
                            job_data, confidence = await ai_parser.parse(description)
                            self._merge_job_data(job_data, browser_result.structured_data)
                        except AIParsingError as e:
                            last_error = f"AI parsing failed: {e}"
                    else:
                        try:
                            job_data, confidence = await ai_parser.parse(browser_result.raw_content)
                        except AIParsingError as e:
                            last_error = f"AI parsing failed: {e}"

                    validation = validate_job_data(job_data, confidence)
                    if validation.is_valid:
                        return await self._save_result(
                            job_id,
                            job_data,
                            ExtractionMethod.BROWSER_RENDER,
                            validation.adjusted_confidence,
                            browser_result.raw_content
                        )

                    last_error = f"Validation failed: {', '.join(validation.errors)}"
                if browser_result.error:
                    last_error = browser_result.error
            else:
                logger.info(
                    "browser_skipped",
                    url=url,
                    reason="Playwright browsers not installed - run 'playwright install'",
                )

            final_message = "All extraction methods failed"
            if last_error:
                final_message = f"{final_message}: {last_error}"
            return await self._save_failed(job_id, final_message)

        except Exception as e:
            logger.error("extraction_service_failed", job_id=job_id, error=str(e))
            return await self._save_failed(job_id, str(e))

    def _merge_job_data(self, job_data: JobDescriptionSchema, structured_data: dict):
        """Merge structured data into job_data if fields are missing."""
        if not job_data.title and structured_data.get("title"):
            job_data.title = structured_data["title"]
        if not job_data.company and structured_data.get("company"):
            job_data.company = structured_data["company"]
        if not job_data.location and structured_data.get("location"):
            job_data.location = structured_data["location"]

    def _parse_posted_date(self, value) -> datetime | None:
        """Best-effort parse of a date string into a datetime object."""
        if isinstance(value, datetime):
            # Convert timezone-aware to naive (assuming UTC)
            if value.tzinfo is not None:
                return value.replace(tzinfo=None)
            return value
        if not value or not isinstance(value, str):
            return None
        for fmt in ("%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%d"):
            try:
                parsed = datetime.strptime(value, fmt)
                # If parsed with timezone, make it naive
                if parsed.tzinfo is not None:
                    parsed = parsed.replace(tzinfo=None)
                return parsed
            except (ValueError, TypeError):
                continue
        return None

    async def _finalize_extraction(
        self,
        job_id: str,
        structured_data: dict,
        method: ExtractionMethod,
        confidence: float,
        raw_html: str,
    ) -> dict:
        logger.info(
            "finalize_extraction_started",
            job_id=job_id,
            method=method.value,
            has_title=bool(structured_data.get("title")),
            has_description="description" in structured_data,
        )

        if "description" in structured_data and structured_data.get("title"):
            job_data = JobDescriptionSchema(
                title=structured_data.get("title", ""),
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
        else:
            ai_parser = get_ai_parser()
            job_data, confidence = await ai_parser.parse(str(structured_data))

        validation = validate_job_data(job_data, confidence)

        if validation.is_valid:
            return await self._save_result(job_id, job_data, method, validation.adjusted_confidence, raw_html)
        else:
            logger.warning(
                "finalize_extraction_validation_failed",
                job_id=job_id,
                errors=validation.errors,
                warnings=validation.warnings,
            )
            return await self._save_failed(job_id, f"Validation failed: {', '.join(validation.errors)}")

    async def _save_result(
        self,
        job_id: str,
        job_data: JobDescriptionSchema,
        method: ExtractionMethod,
        confidence: float,
        raw_html: str,
    ) -> dict:
        raw_html = sanitize_for_postgres_text(raw_html)
        async with get_session() as session:
            repository = JobExtractionRepository(session)
            await repository.update_extraction_result(
                job_id,
                job_data,
                method,
                confidence,
                raw_html,
            )
            valid_repo = ValidJobRepository(session)
            valid_job = await valid_repo.get_by_extraction_id(job_id)
            await valid_repo.mark_scraped_by_extraction_id(job_id)
            await session.flush()

            if valid_job:
                # Sync valid_jobs mirror fields immediately with structured extraction
                # so policy checks and list APIs use the latest company/title metadata.
                await valid_repo.update_from_structured_extraction(valid_job.id, job_data)
            await session.commit()

        logger.info(
            "extraction_completed",
            job_id=job_id,
            method=method.value,
            confidence=confidence,
        )

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
            await repository.increment_retry(job_id)

        logger.error(
            "extraction_failed_final",
            job_id=job_id,
            error=error,
        )

        return {"job_id": job_id, "status": "failed", "error": error}
