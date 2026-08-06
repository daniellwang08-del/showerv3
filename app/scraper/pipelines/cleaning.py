import re
import logging
from typing import Optional

from app.scraper.items import JobItem

logger = logging.getLogger(__name__)

# Postgres INTEGER max; salary_*_cents columns are Integer today.
_PG_INT_MAX = 2_147_483_647

_CURRENCY_CODES = (
    "USD|EUR|GBP|CAD|AUD|SEK|NOK|DKK|CHF|INR|NZD|SGD|HKD|MXN|BRL|ZAR|JPY|KRW|PLN"
)
_CURRENCY_SYMBOLS = r"\$|€|£|¥"
_CURRENCY_PREFIX = rf"(?:(?:{_CURRENCY_CODES})|{_CURRENCY_SYMBOLS})\s*"

# Capture per-amount "k"/"K" suffix instead of scanning the whole raw string
# (which falsely matched the letter k inside currency codes like SEK).
SALARY_PATTERN = re.compile(
    rf"(?:{_CURRENCY_PREFIX})?"
    r"([\d,]+(?:\.\d+)?)\s*(k)?"
    rf"(?:\s*(?:[-\u2013\u2014]|to)\s*(?:{_CURRENCY_PREFIX})?"
    r"([\d,]+(?:\.\d+)?)\s*(k)?)?"
    r"(?:\s*(?:per|/|a)?\s*(year|yr|month|mo|hour|hr|week|wk|annual|annually))?",
    re.IGNORECASE,
)

_CURRENCY_CODE_PATTERN = re.compile(rf"\b({_CURRENCY_CODES})\b", re.IGNORECASE)
_SYMBOL_TO_CURRENCY = {
    "$": "USD",
    "€": "EUR",
    "£": "GBP",
    "¥": "JPY",
}


class CleaningPipeline:
    """Normalize salary, location, and text fields."""

    def __init__(self, crawler):
        self.crawler = crawler

    @classmethod
    def from_crawler(cls, crawler):
        return cls(crawler)

    def process_item(self, item: JobItem) -> JobItem:
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
        raw = item.salary_raw or ""
        match = SALARY_PATTERN.search(raw)
        if not match:
            return

        low_str, low_k, high_str, high_k, period_str = match.groups()

        low = float(low_str.replace(",", ""))
        if low_k:
            low *= 1000

        high: Optional[float] = None
        if high_str:
            high = float(high_str.replace(",", ""))
            if high_k:
                high *= 1000

        min_cents = self._to_cents(low, raw, "min")
        max_cents = self._to_cents(high, raw, "max") if high is not None else None
        if min_cents is None:
            return

        item.salary_min_cents = min_cents
        item.salary_max_cents = max_cents

        currency = self._detect_currency(raw)
        if currency:
            item.salary_currency = currency

        if period_str:
            item.salary_period = period_str.strip()

    @staticmethod
    def _to_cents(amount: float, raw: str, which: str) -> Optional[int]:
        cents = int(round(amount * 100))
        if cents < 0 or cents > _PG_INT_MAX:
            logger.warning(
                "Ignoring out-of-range salary_%s_cents=%s for salary_raw=%r",
                which,
                cents,
                raw,
            )
            return None
        return cents

    @staticmethod
    def _detect_currency(raw: str) -> Optional[str]:
        code = _CURRENCY_CODE_PATTERN.search(raw)
        if code:
            return code.group(1).upper()
        for symbol, currency in _SYMBOL_TO_CURRENCY.items():
            if symbol in raw:
                return currency
        return None
