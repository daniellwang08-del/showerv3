from abc import ABC, abstractmethod
from app.models.schemas import ExtractionMethod
from dataclasses import dataclass
from typing import Any


@dataclass
class ExtractionResult:
    success: bool
    method: ExtractionMethod
    raw_content: str | None = None
    structured_data: dict[str, Any] | None = None
    confidence: float = 0.0
    error: str | None = None


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


class ExtractorPipeline:
    def __init__(self, extractors: list[BaseExtractor]):
        self._extractors = extractors

    async def extract(self, url: str, html: str | None = None) -> ExtractionResult:
        for extractor in self._extractors:
            if await extractor.can_extract(url, html):
                result = await extractor.extract(url, html)
                if result.success:
                    return result
        return ExtractionResult(
            success=False,
            method=ExtractionMethod.STATIC_HTML,
            error="All extraction methods failed",
        )
