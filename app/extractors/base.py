from abc import ABC, abstractmethod
from app.models.schemas import ExtractionMethod
from dataclasses import dataclass
from typing import Any

# Statuses a vendor posting API returns once a posting is unpublished.
GONE_STATUSES = frozenset({404, 410})


@dataclass
class ExtractionResult:
    success: bool
    method: ExtractionMethod
    raw_content: str | None = None
    structured_data: dict[str, Any] | None = None
    error: str | None = None
    # Rendered DOM from the browser pass, for vendor detectors that need markup.
    html: str | None = None
    # The vendor's own API says the posting no longer exists.
    closed: bool = False


def http_status_of(exc: BaseException) -> int | None:
    """Status code carried by an ``HTTPService`` ``NetworkError``, if any."""
    details = getattr(exc, "details", None)
    status = details.get("status_code") if isinstance(details, dict) else None
    return status if isinstance(status, int) else None


class BaseExtractor(ABC):
    @property
    @abstractmethod
    def method(self) -> ExtractionMethod:
        pass

    @abstractmethod
    async def can_extract(self, url: str, html: str | None = None) -> bool:
        pass

    @abstractmethod
    async def extract(self, url: str, html: str | None = None) -> ExtractionResult:
        pass
