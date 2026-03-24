from typing import Any


class ScraperException(Exception):
    def __init__(self, message: str, details: dict[str, Any] | None = None):
        self.message = message
        self.details = details or {}
        super().__init__(self.message)


class ValidationError(ScraperException):
    pass


class ExtractionError(ScraperException):
    pass


class NetworkError(ScraperException):
    pass


class BrowserError(ScraperException):
    pass


class AIParsingError(ScraperException):
    pass


class StorageError(ScraperException):
    pass


class RateLimitError(ScraperException):
    pass


class DuplicateURLError(ScraperException):
    pass
