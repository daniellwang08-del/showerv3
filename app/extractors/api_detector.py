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

# Nested schema.org objects carry their value under one of these keys. They must
# be read inline: recursing instead re-labels ``hiringOrganization.name`` through
# _LABEL_MAP as "Title", which hid the employer behind a bare "Company:" line.
_INLINE_VALUE_KEYS = ("name", "value", "text")


def _inline_value(obj: dict) -> str | None:
    for key in _INLINE_VALUE_KEYS:
        raw = obj.get(key)
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
    return None


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
            structured_data=self._structured_fields(json_ld_data) or None,
        )

    def _structured_fields(self, data: dict) -> dict[str, Any]:
        """Map schema.org JobPosting keys to the hydrator's structured fields.

        These are declared fields, so hydrate can fill title/company directly
        without falling back to MiniLM span ranking over the page text.
        """
        out: dict[str, Any] = {}

        for key in ("title", "name"):
            raw = data.get(key)
            if isinstance(raw, str) and raw.strip():
                out["title"] = raw.strip()
                break

        org = data.get("hiringOrganization")
        if isinstance(org, dict):
            name = _inline_value(org)
            if name:
                out["company"] = name
        elif isinstance(org, str) and org.strip():
            out["company"] = org.strip()

        location = self._location_text(data.get("jobLocation"))
        if location:
            out["location"] = location

        employment = data.get("employmentType")
        if isinstance(employment, list):
            employment = ", ".join(e for e in employment if isinstance(e, str))
        if isinstance(employment, str) and employment.strip():
            out["employment_type"] = employment.strip()

        if str(data.get("jobLocationType") or "").upper() == "TELECOMMUTE":
            out["workplace"] = "remote"

        return out

    def _location_text(self, node: Any) -> str | None:
        if isinstance(node, list):
            found = []
            for item in node:
                loc = self._location_text(item)
                if loc and loc not in found:
                    found.append(loc)
            return " / ".join(found) if found else None
        if isinstance(node, str):
            return node.strip() or None
        if not isinstance(node, dict):
            return None

        address = node.get("address")
        if isinstance(address, dict):
            parts = [
                address.get("addressLocality"),
                address.get("addressRegion"),
                address.get("addressCountry"),
            ]
            text = ", ".join(
                p.strip() for p in parts if isinstance(p, str) and p.strip()
            )
            if text:
                return text
        if isinstance(address, str) and address.strip():
            return address.strip()
        return _inline_value(node)

    def _find_json_ld(self, html_content: str) -> dict | None:
        try:
            tree = lxml_html.fromstring(html_content)
            scripts = tree.cssselect('script[type="application/ld+json"]')

            for script in scripts:
                try:
                    # strict=False: JobDiva (and other CMSs) emit raw newlines
                    # inside the description string, which strict JSON rejects.
                    data = json.loads(script.text_content(), strict=False)
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
                elif label and isinstance(value, dict) and _inline_value(value):
                    parts.append(f"{label}: {_inline_value(value)}")
                    rest = {
                        k: v for k, v in value.items() if k not in _INLINE_VALUE_KEYS
                    }
                    if rest:
                        self._walk(rest, parts, depth + 1)
                else:
                    if label and isinstance(value, (dict, list)):
                        parts.append(f"{label}:")
                    self._walk(value, parts, depth + 1)
