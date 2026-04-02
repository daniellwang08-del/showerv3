"""
Shared async OpenAI client for AI-powered features.
Avoids duplication across ai_parser, job_match_service, etc.
"""

from openai import AsyncOpenAI
from app.core.config import get_settings
from app.core.exceptions import AIParsingError
from app.core.logging import get_logger

logger = get_logger(__name__)

_client: AsyncOpenAI | None = None


def get_openai_client() -> AsyncOpenAI:
    """Get or create shared AsyncOpenAI client."""
    global _client
    if _client is None:
        settings = get_settings()
        if not settings.openai_api_key:
            raise AIParsingError("OpenAI API key not configured")
        _client = AsyncOpenAI(api_key=settings.openai_api_key, max_retries=0)
    return _client
