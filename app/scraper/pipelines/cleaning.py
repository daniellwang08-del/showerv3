import re
import logging
from typing import Optional

from app.scraper.items import JobItem

logger = logging.getLogger(__name__)

SALARY_PATTERN = re.compile(
    r"\$?\s*([\d,]+(?:\.\d+)?)\s*(?:k)?\s*"
    r"(?:[-\u2013\u2014to]+\s*\$?\s*([\d,]+(?:\.\d+)?)\s*(?:k)?)?"
    r"(?:\s*(?:per|/|a)?\s*(year|yr|month|mo|hour|hr|week|wk|annual|annually))?",
    re.IGNORECASE,
)


class CleaningPipeline:
    """Normalize salary, location, and text fields."""

    def process_item(self, item: JobItem, spider) -> JobItem:
        if item.description:
            item.description = self._clean_html(item.description)

        if item.location:
            item.is_remote = item.is_remote or self._detect_remote(item.location)
            item.location = item.location.strip()

        if item.title:
            item.is_remote = item.is_remote or self._detect_remote(item.title)

        if item.salary_raw and item.salary_min_cents is None:
            self._parse_salary(item)

        return item

    def _clean_html(self, text: str) -> str:
        text = re.sub(r"<[^>]+>", " ", text)
        text = re.sub(r"\s+", " ", text)
        return text.strip()

    def _detect_remote(self, text: str) -> bool:
        lower = text.lower()
        return any(kw in lower for kw in ["remote", "work from home", "wfh", "anywhere"])

    def _parse_salary(self, item: JobItem):
        match = SALARY_PATTERN.search(item.salary_raw)
        if not match:
            return

        low_str = match.group(1).replace(",", "")
        high_str = match.group(2)
        period_str = match.group(3)

        low = float(low_str)
        if "k" in item.salary_raw.lower():
            low *= 1000

        high: Optional[float] = None
        if high_str:
            high = float(high_str.replace(",", ""))
            if "k" in item.salary_raw.lower():
                high *= 1000

        item.salary_min_cents = int(low * 100)
        item.salary_max_cents = int(high * 100) if high else None

        if period_str:
            item.salary_period = period_str.strip()
