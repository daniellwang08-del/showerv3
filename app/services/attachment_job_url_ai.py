"""
Use OpenAI to extract job-related URLs from plain text (from attachments).
"""

from __future__ import annotations

import asyncio
import json
import re
from app.core.config import get_settings
from app.core.exceptions import AIParsingError
from app.core.logging import get_logger
from app.core.openai_client import get_openai_client_for_user
from app.services.url_manager import URLManager

try:
    from langfuse import observe
except ImportError:
    from functools import wraps
    def observe(**_kw):  # noqa: E303
        def _decorator(fn):
            @wraps(fn)
            async def _wrapper(*a, **k):
                return await fn(*a, **k)
            return _wrapper
        return _decorator

logger = get_logger(__name__)

# Stay under typical context limits; chunk long documents.
_CHUNK_CHARS = 48_000

SYSTEM_PROMPT = """You extract job posting and careers URLs from document text.

Return ONLY valid JSON: {"urls": ["https://...", ...]}

Rules:
- Include http and https URLs that point to job listings, job search results, careers pages, or application flows.
- Include common ATS/board patterns (e.g. greenhouse.io, lever.co, smartrecruiters, Workday, LinkedIn job links).
- Do not invent URLs; every string must appear in the text or be an obvious normalization of a URL in the text.
- Omit mailto:, javascript:, and data: URLs.
- Deduplicate URLs in the array (same URL once).
- If there are no suitable URLs, return {"urls": []}.
"""


def _parse_urls_payload(raw: str) -> list[str]:
    raw = raw.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("Expected JSON object")
    urls = data.get("urls")
    if urls is None:
        return []
    if not isinstance(urls, list):
        raise ValueError("urls must be an array")
    out: list[str] = []
    for u in urls:
        if isinstance(u, str) and u.strip():
            out.append(u.strip())
    return out


def _validate_and_normalize_url(url: str) -> str | None:
    ok, _err = URLManager.validate_url(url)
    if not ok:
        return None
    return url.strip()


@observe(name="extract_job_urls_from_text")
async def extract_job_urls_from_text_combined(text: str, *, user_id: str | None = None) -> list[str]:
    """
    Run OpenAI on one or more chunks in parallel (bounded), merge and dedupe by normalized URL.
    """
    text = text.strip()
    if not text:
        return []

    settings = get_settings()
    client = await get_openai_client_for_user(user_id)

    chunks: list[str] = []
    if len(text) <= _CHUNK_CHARS:
        chunks = [text]
    else:
        for i in range(0, len(text), _CHUNK_CHARS):
            chunks.append(text[i : i + _CHUNK_CHARS])

    sem = asyncio.Semaphore(max(1, settings.openai_attachment_max_concurrent))

    async def _extract_chunk(idx: int, chunk: str) -> list[str]:
        user_msg = (
            f"Document part {idx + 1} of {len(chunks)}.\n\nExtract job-related URLs as specified.\n\n{chunk}"
        )
        async with sem:
            try:
                resp = await client.chat.completions.create(
                    model=settings.openai_model,
                    messages=[
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "user", "content": user_msg},
                    ],
                    response_format={"type": "json_object"},
                    temperature=0.1,
                )
            except Exception as e:
                logger.exception("attachment_url_ai_openai_failed", part=idx + 1)
                raise AIParsingError(f"OpenAI request failed: {e}") from e

        choice = resp.choices[0].message.content
        if not choice:
            return []
        try:
            return _parse_urls_payload(choice)
        except (json.JSONDecodeError, ValueError) as e:
            logger.warning("attachment_url_ai_bad_json", part=idx + 1, error=str(e))
            return []

    chunk_results = await asyncio.gather(
        *(_extract_chunk(idx, chunk) for idx, chunk in enumerate(chunks))
    )

    seen: set[str] = set()
    ordered: list[str] = []
    for raw_urls in chunk_results:
        for u in raw_urls:
            norm = _validate_and_normalize_url(u)
            if not norm or norm in seen:
                continue
            seen.add(norm)
            ordered.append(norm)

    return ordered
