"""
Extract text content from JSON-LD ``JobPosting`` blocks embedded in HTML.

Rather than mapping individual schema.org fields to a structured dict, this
extractor pulls ALL text values from the JSON-LD object and returns them as
clean plain text.  The downstream LLM analysis determines the structured
job content from this text.
"""

import json
from typing import Any

from lxml import html as lxml_html
from app.extractors.base import BaseExtractor, ExtractionResult
from app.models.schemas import ExtractionMethod
from app.services.job_content_cleaner import plain_text_from_fragment_html
from app.core.logging import get_logger

logger = get_logger(__name__)

JSON_LD_TYPES = frozenset({"JobPosting", "JobPosting#JobPosting"})

_SKIP_KEYS = frozenset({
    "@context", "@type", "@id", "url", "sameAs", "image", "logo",
    "identifier", "directApply",
})

_LABEL_MAP: dict[str, str] = {
    "title": "Title",
    "name": "Title",
    "description": "Description",
    "hiringOrganization": "Company",
    "jobLocation": "Location",
    "addressLocality": "City",
    "addressRegion": "State/Region",
    "addressCountry": "Country",
    "employmentType": "Employment Type",
    "baseSalary": "Salary",
    "estimatedSalary": "Estimated Salary",
    "minValue": "Min",
    "maxValue": "Max",
    "currency": "Currency",
    "unitText": "Pay Period",
    "qualifications": "Qualifications",
    "skills": "Skills",
    "educationRequirements": "Education Requirements",
    "experienceRequirements": "Experience Requirements",
    "responsibilities": "Responsibilities",
    "jobBenefits": "Benefits",
    "datePosted": "Posted Date",
    "validThrough": "Application Deadline",
    "jobLocationType": "Location Type",
    "applicantLocationRequirements": "Location Requirements",
    "workHours": "Work Hours",
    "industry": "Industry",
    "occupationalCategory": "Category",
}


class APIDetectorExtractor(BaseExtractor):
    @property
    def method(self) -> ExtractionMethod:
        return ExtractionMethod.API_JSON_LD

    async def can_extract(self, url: str, html: str | None = None) -> bool:
        if not html:
            return False
        return self._find_json_ld(html) is not None

    async def extract(self, url: str, html: str | None = None) -> ExtractionResult:
        if not html:
            return ExtractionResult(
                success=False,
                method=self.method,
                error="No HTML content provided",
            )

        json_ld_data = self._find_json_ld(html)
        if not json_ld_data:
            return ExtractionResult(
                success=False,
                method=self.method,
                error="No JSON-LD job posting found",
            )

        plain_text = self._extract_all_text(json_ld_data)

        if not plain_text or len(plain_text) < 50:
            return ExtractionResult(
                success=False,
                method=self.method,
                error="Insufficient text content in JSON-LD",
            )

        logger.info("json_ld_extraction_success", url=url, content_length=len(plain_text))

        return ExtractionResult(
            success=True,
            method=self.method,
            raw_content=plain_text,
            structured_data=None,
        )

    def _find_json_ld(self, html_content: str) -> dict | None:
        try:
            tree = lxml_html.fromstring(html_content)
            scripts = tree.cssselect('script[type="application/ld+json"]')

            for script in scripts:
                try:
                    data = json.loads(script.text_content())
                    job_data = self._extract_job_posting(data)
                    if job_data:
                        return job_data
                except json.JSONDecodeError:
                    continue
        except Exception:
            pass
        return None

    def _extract_job_posting(self, data: dict | list) -> dict | None:
        if isinstance(data, list):
            for item in data:
                result = self._extract_job_posting(item)
                if result:
                    return result
            return None

        if isinstance(data, dict):
            schema_type = data.get("@type", "")
            if isinstance(schema_type, list):
                schema_type = schema_type[0] if schema_type else ""

            if schema_type in JSON_LD_TYPES or "JobPosting" in str(schema_type):
                return data

            if "@graph" in data:
                return self._extract_job_posting(data["@graph"])

            main = data.get("mainEntity")
            if isinstance(main, dict):
                result = self._extract_job_posting(main)
                if result:
                    return result

        return None

    def _extract_all_text(self, data: dict) -> str:
        """Recursively extract all text values from the JSON-LD, with readable labels."""
        parts: list[str] = []
        self._walk(data, parts, depth=0)
        return "\n".join(parts)

    def _walk(self, obj: Any, parts: list[str], depth: int) -> None:
        if depth > 10:
            return

        if isinstance(obj, str):
            text = obj.strip()
            if not text:
                return
            if "<" in text:
                text = plain_text_from_fragment_html(text)
            if text:
                parts.append(text)
            return

        if isinstance(obj, (int, float, bool)):
            parts.append(str(obj))
            return

        if isinstance(obj, list):
            for item in obj:
                self._walk(item, parts, depth + 1)
            return

        if isinstance(obj, dict):
            for key, value in obj.items():
                if key in _SKIP_KEYS:
                    continue
                if value is None:
                    continue

                label = _LABEL_MAP.get(key)
                if label and isinstance(value, str):
                    text = value.strip()
                    if "<" in text:
                        text = plain_text_from_fragment_html(text)
                    if text:
                        parts.append(f"{label}: {text}")
                elif label and isinstance(value, (int, float)):
                    parts.append(f"{label}: {value}")
                elif label and isinstance(value, list) and all(isinstance(v, str) for v in value):
                    items = [v.strip() for v in value if v.strip()]
                    if items:
                        parts.append(f"{label}: {', '.join(items)}")
                else:
                    if label and isinstance(value, (dict, list)):
                        parts.append(f"{label}:")
                    self._walk(value, parts, depth + 1)
