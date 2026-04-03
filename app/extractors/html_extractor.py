from app.extractors.base import BaseExtractor, ExtractionResult
from app.models.schemas import ExtractionMethod
from app.services.job_content_cleaner import plain_text_from_document_html
from app.core.logging import get_logger

logger = get_logger(__name__)

MIN_CONTENT_LENGTH = 50


class HTMLExtractor(BaseExtractor):
    """Extract full page plain text from static HTML."""

    @property
    def method(self) -> ExtractionMethod:
        return ExtractionMethod.STATIC_HTML

    async def can_extract(self, url: str, html: str | None = None) -> bool:
        return html is not None and len(html) > 100

    async def extract(self, url: str, html: str | None = None) -> ExtractionResult:
        if not html:
            return ExtractionResult(
                success=False,
                method=self.method,
                error="No HTML content",
            )

        try:
            content = plain_text_from_document_html(html)

            if not content or len(content) < MIN_CONTENT_LENGTH:
                return ExtractionResult(
                    success=False,
                    method=self.method,
                    error="Insufficient text content extracted from HTML",
                )

            logger.info(
                "html_extraction_success",
                url=url,
                content_length=len(content),
            )

            return ExtractionResult(
                success=True,
                method=self.method,
                raw_content=content,
                structured_data=None,
            )

        except Exception as e:
            logger.error("html_extraction_failed", url=url, error=str(e))
            return ExtractionResult(
                success=False,
                method=self.method,
                error=str(e),
            )
