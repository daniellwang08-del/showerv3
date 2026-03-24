import json
import re
from lxml import html as lxml_html
from app.extractors.base import BaseExtractor, ExtractionResult
from app.models.schemas import ExtractionMethod
from app.services.url_manager import URLManager
from app.core.logging import get_logger

logger = get_logger(__name__)

JSON_LD_TYPES = frozenset({"JobPosting", "JobPosting#JobPosting"})


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
            logger.debug("api_detector_no_json_ld", url=url)
            return ExtractionResult(
                success=False,
                method=self.method,
                error="No JSON-LD job posting found",
            )

        structured = self._parse_json_ld(json_ld_data)
        if not structured:
            logger.debug("api_detector_parse_failed", url=url)
            return ExtractionResult(
                success=False,
                method=self.method,
                error="Failed to parse JSON-LD data",
            )

        logger.info("json_ld_extraction_success", url=url)

        return ExtractionResult(
            success=True,
            method=self.method,
            raw_content=json.dumps(json_ld_data),
            structured_data=structured,
            confidence=0.95,
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

        return None

    def _parse_json_ld(self, data: dict) -> dict | None:
        try:
            result = {
                "title": self._clean_text(data.get("title", "")),
                "description": self._clean_html(data.get("description", "")),
                "company": self._extract_company(data),
                "location": self._extract_location(data),
                "employment_type": self._normalize_employment_type(data.get("employmentType")),
                "salary_range": self._extract_salary(data),
                "posted_date": data.get("datePosted"),
                "application_deadline": data.get("validThrough"),
                "requirements": self._extract_requirements(data),
                "responsibilities": self._extract_responsibilities(data),
                "remote_policy": self._extract_remote_policy(data),
                "experience_level": data.get("experienceRequirements"),
                "industry": data.get("industry"),
                "raw_metadata": data,
            }
            return result
        except Exception:
            return None

    def _clean_text(self, text: str | None) -> str:
        if not text:
            return ""
        return re.sub(r"\s+", " ", str(text)).strip()

    def _clean_html(self, text: str | None) -> str:
        if not text:
            return ""
        text = re.sub(r"<[^>]+>", " ", str(text))
        return self._clean_text(text)

    def _extract_company(self, data: dict) -> str | None:
        hiring_org = data.get("hiringOrganization", {})
        if isinstance(hiring_org, dict):
            return hiring_org.get("name")
        return None

    def _extract_location(self, data: dict) -> str | None:
        location = data.get("jobLocation")
        if not location:
            return None

        if isinstance(location, list):
            location = location[0] if location else {}

        if isinstance(location, dict):
            address = location.get("address", {})
            if isinstance(address, dict):
                parts = []
                if address.get("addressLocality"):
                    parts.append(address["addressLocality"])
                if address.get("addressRegion"):
                    parts.append(address["addressRegion"])
                if address.get("addressCountry"):
                    country = address["addressCountry"]
                    if isinstance(country, dict):
                        country = country.get("name", "")
                    parts.append(country)
                return ", ".join(filter(None, parts))
        return None

    def _normalize_employment_type(self, emp_type: str | list | None) -> str | None:
        if not emp_type:
            return None
        if isinstance(emp_type, list):
            emp_type = emp_type[0] if emp_type else None
        if emp_type:
            return str(emp_type).replace("_", " ").title()
        return None

    def _extract_salary(self, data: dict) -> str | None:
        salary = data.get("baseSalary") or data.get("estimatedSalary")
        if not salary:
            return None

        if isinstance(salary, list):
            salary = salary[0] if salary else {}

        if isinstance(salary, dict):
            value = salary.get("value", {})
            currency = salary.get("currency", "USD")

            if isinstance(value, dict):
                min_val = value.get("minValue")
                max_val = value.get("maxValue")
                unit = value.get("unitText", "YEAR")
                if min_val and max_val:
                    return f"{currency} {min_val:,} - {max_val:,} per {unit.lower()}"
                elif min_val:
                    return f"{currency} {min_val:,}+ per {unit.lower()}"
            elif isinstance(value, (int, float)):
                return f"{currency} {value:,}"
        return None

    def _extract_requirements(self, data: dict) -> list[str]:
        quals = data.get("qualifications") or data.get("skills") or []
        if isinstance(quals, str):
            return [self._clean_text(quals)]
        if isinstance(quals, list):
            return [self._clean_text(q) for q in quals if q]
        return []

    def _extract_responsibilities(self, data: dict) -> list[str]:
        resp = data.get("responsibilities") or []
        if isinstance(resp, str):
            return [self._clean_text(resp)]
        if isinstance(resp, list):
            return [self._clean_text(r) for r in resp if r]
        return []

    def _extract_remote_policy(self, data: dict) -> str | None:
        job_location_type = data.get("jobLocationType")
        if job_location_type:
            if "TELECOMMUTE" in str(job_location_type).upper():
                return "Remote"
        return None
