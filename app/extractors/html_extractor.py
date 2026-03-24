import re
from lxml import html as lxml_html
from lxml_html_clean import Cleaner
from readability import Document
from app.extractors.base import BaseExtractor, ExtractionResult
from app.models.schemas import ExtractionMethod
from app.core.logging import get_logger

logger = get_logger(__name__)

CONTENT_SELECTORS = [
    "article.job-description",
    "div.job-description",
    "div.job-content",
    "div.job-details",
    "section.job-description",
    "main.job-posting",
    "div[data-automation='jobDescription']",
    "div[class*='jobDescription']",
    "div[class*='job-description']",
    "div[id*='jobDescription']",
    "div[id*='job-description']",
    "article",
    "main",
    ".content",
    "#content",
]

TITLE_SELECTORS = [
    "h1.job-title",
    "h1[class*='title']",
    "h1[data-automation='job-title']",
    ".job-title h1",
    "h1",
]

COMPANY_SELECTORS = [
    "[data-automation='company']",
    ".company-name",
    "[class*='company']",
    "[class*='employer']",
]

LOCATION_SELECTORS = [
    "[data-automation='location']",
    ".job-location",
    "[class*='location']",
    "address",
]


class HTMLExtractor(BaseExtractor):
    def __init__(self):
        self._cleaner = Cleaner(
            scripts=True,
            javascript=True,
            comments=True,
            style=True,
            inline_style=True,
            links=False,
            meta=True,
            page_structure=False,
            processing_instructions=True,
            remove_unknown_tags=False,
            safe_attrs_only=False,
            forms=True,
        )

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
            tree = lxml_html.fromstring(html)
            cleaned_html = self._cleaner.clean_html(tree)

            title = self._extract_text(cleaned_html, TITLE_SELECTORS)
            company = self._extract_text(cleaned_html, COMPANY_SELECTORS)
            location = self._extract_text(cleaned_html, LOCATION_SELECTORS)
            content = self._extract_content(cleaned_html)

            if not content or len(content) < 50:
                content = self._extract_with_readability(html)

            if not title or not content or len(content) < 50:
                return ExtractionResult(
                    success=False,
                    method=self.method,
                    error="Could not extract meaningful content",
                )

            structured_data = {
                "title": title or "",
                "company": company,
                "location": location,
                "description": content,
                "raw_html": html,
            }

            confidence = self._calculate_confidence(structured_data)

            logger.info(
                "html_extraction_success",
                url=url,
                title_found=bool(title),
                content_length=len(content) if content else 0,
            )

            return ExtractionResult(
                success=True,
                method=self.method,
                raw_content=html,
                structured_data=structured_data,
                confidence=confidence,
            )

        except Exception as e:
            logger.error("html_extraction_failed", url=url, error=str(e))
            return ExtractionResult(
                success=False,
                method=self.method,
                error=str(e),
            )

    def _extract_text(self, tree, selectors: list[str]) -> str | None:
        for selector in selectors:
            try:
                elements = tree.cssselect(selector)
                if elements:
                    text = elements[0].text_content()
                    cleaned = self._clean_text(text)
                    if cleaned:
                        return cleaned
            except Exception:
                continue
        return None

    def _extract_content(self, tree) -> str | None:
        for selector in CONTENT_SELECTORS:
            try:
                elements = tree.cssselect(selector)
                if elements:
                    text = elements[0].text_content()
                    cleaned = self._clean_text(text)
                    if cleaned and len(cleaned) > 100:
                        return cleaned
            except Exception:
                continue
        return None

    def _extract_with_readability(self, html: str) -> str:
        try:
            doc = Document(html)
            summary = doc.summary()
            text = lxml_html.fromstring(summary).text_content()
            return self._clean_text(text)
        except Exception:
            return ""

    def _clean_text(self, text: str | None) -> str:
        if not text:
            return ""
        text = re.sub(r"[\r\n]+", "\n", text)
        text = re.sub(r"[ \t]+", " ", text)
        lines = [line.strip() for line in text.split("\n")]
        lines = [line for line in lines if line]
        return "\n".join(lines)

    def _calculate_confidence(self, data: dict) -> float:
        score = 0.0
        if data.get("title"):
            score += 0.3
        if data.get("description") and len(data["description"]) > 200:
            score += 0.4
        if data.get("company"):
            score += 0.15
        if data.get("location"):
            score += 0.15
        return min(score, 0.85)
