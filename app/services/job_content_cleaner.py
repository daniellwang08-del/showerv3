"""
Production-grade extraction of **job posting plain text** from HTML.

Goals
-----
- Remove non-content resources (scripts, styles, media, forms metadata, etc.).
- Drop common page chrome (header, nav, footer, aside, dialogs) when parsing full documents.
- Prefer ATS / job-board regions when selectors match; otherwise fall back to Readability.
- Parse JSON-LD ``description`` fragments (often rich HTML) into readable plain text.
- Emit stable UTF-8 text safe for PostgreSQL (null bytes stripped).

This module is the single place for "what the candidate sees as the job" text. Downstream
LLM or validation should consume this output rather than raw markup.
"""

from __future__ import annotations

import re
from typing import Final

from lxml import html as lxml_html
from lxml_html_clean import Cleaner
from readability import Document

from app.core.logging import get_logger
from app.utils.text_sanitizer import sanitize_for_postgres_text

logger = get_logger(__name__)

# Hard cap prevents pathological pages from exhausting memory downstream.
_MAX_PLAIN_TEXT_CHARS: Final[int] = 1_000_000

# Prefer regions ATS products typically use for the JD body (order matters).
_JOB_BODY_SELECTORS: Final[tuple[str, ...]] = (
    "article.job-description",
    "div.job-description",
    "div.job-content",
    "div.job-details",
    "section.job-description",
    "main.job-posting",
    "div[data-automation='jobDescription']",
    "div[class*='jobDescription']",
    "div[class*='job-description']",
    "div[id*='jobDescription']",
    "div[id*='job-description']",
    "[itemprop='description']",
    "article",
    "main",
    ".content",
    "#content",
)

# Semantic elements often used for navigation / legal / unrelated to the posting body.
_CHROME_TAGS: Final[tuple[str, ...]] = (
    "header",
    "nav",
    "footer",
    "aside",
    "dialog",
    "menu",
    "template",
    "noscript",
)


def _html_cleaner() -> Cleaner:
    return Cleaner(
        scripts=True,
        javascript=True,
        comments=True,
        style=True,
        inline_style=True,
        links=False,
        meta=True,
        page_structure=False,
        processing_instructions=True,
        remove_unknown_tags=False,
        safe_attrs_only=False,
        forms=True,
    )


def _normalize_plain_text(text: str) -> str:
    if not text:
        return ""
    text = re.sub(r"[\r\n]+", "\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    lines = [ln.strip() for ln in text.split("\n")]
    lines = [ln for ln in lines if ln]
    return "\n".join(lines)


def _truncate(text: str) -> str:
    if len(text) <= _MAX_PLAIN_TEXT_CHARS:
        return text
    logger.warning(
        "job_content_truncated",
        original_chars=len(text),
        max_chars=_MAX_PLAIN_TEXT_CHARS,
    )
    return text[:_MAX_PLAIN_TEXT_CHARS]


def _sanitize_html_input(html: str | None) -> str:
    if not html:
        return ""
    cleaned = sanitize_for_postgres_text(html)
    return cleaned if cleaned else ""


def _remove_chrome_elements(tree) -> None:
    """Remove common non-job containers from a parsed tree (best-effort)."""
    for tag in _CHROME_TAGS:
        for el in tree.xpath(f".//{tag}"):
            parent = el.getparent()
            if parent is not None:
                parent.remove(el)


def _first_matching_body_text(tree) -> str | None:
    for selector in _JOB_BODY_SELECTORS:
        try:
            elements = tree.cssselect(selector)
            if not elements:
                continue
            text = elements[0].text_content()
            normalized = _normalize_plain_text(text)
            if len(normalized) >= 80:
                return normalized
        except Exception:
            continue
    return None


def _readability_plain_text(html: str) -> str:
    try:
        doc = Document(html)
        summary_html = doc.summary()
        sub = lxml_html.fromstring(summary_html)
        text = sub.text_content()
        return _normalize_plain_text(text)
    except Exception as e:
        logger.debug("readability_extraction_failed", error=str(e))
        return ""


def plain_text_from_document_html(html: str) -> str:
    """
    Full HTML document (e.g. HTTP fetch or browser ``page.content()``).

    Pipeline: sanitize → strip dangerous/noisy nodes → remove chrome →
    job-specific selectors → Readability → whole-tree text (last resort).
    """
    html = _sanitize_html_input(html)
    if not html:
        return ""

    try:
        tree = lxml_html.fromstring(html)
    except Exception:
        return _truncate(_normalize_plain_text(re.sub(r"<[^>]+>", " ", html)))

    try:
        tree = _html_cleaner().clean_html(tree)
    except Exception as e:
        logger.warning("html_cleaner_failed", error=str(e))

    _remove_chrome_elements(tree)

    body = _first_matching_body_text(tree)
    if body:
        return _truncate(body)

    readable = _readability_plain_text(html)
    if readable and len(readable) >= 80:
        return _truncate(readable)

    fallback = _normalize_plain_text(tree.text_content())
    return _truncate(fallback) if fallback else ""


_BR_TAGS_RE = re.compile(r"<br\s*/?>", re.IGNORECASE)


def plain_text_from_fragment_html(fragment: str) -> str:
    """
    HTML **fragment** (typical JSON-LD ``JobPosting.description``): may be a few tags or a full div.

    Does not assume a document ``<html>`` wrapper; wraps safely for parsing.
    """
    fragment = _sanitize_html_input(fragment)
    if not fragment:
        return ""

    if "<" not in fragment:
        return _truncate(_normalize_plain_text(fragment))

    # Preserve line breaks expressed as <br> before tree parsing.
    fragment = _BR_TAGS_RE.sub("\n", fragment)

    wrapped = f"<div class='__job_fragment_root__'>{fragment}</div>"
    try:
        tree = lxml_html.fromstring(wrapped)
    except Exception:
        return _truncate(_normalize_plain_text(re.sub(r"<[^>]+>", " ", fragment)))

    try:
        tree = _html_cleaner().clean_html(tree)
    except Exception:
        pass

    text = tree.text_content()
    return _truncate(_normalize_plain_text(text))


def clean_string_list_field(values: list[str] | None) -> list[str]:
    """Clean list fields that may contain inline HTML from schema.org."""
    if not values:
        return []
    out: list[str] = []
    for v in values:
        if not v:
            continue
        if isinstance(v, str) and "<" in v:
            t = plain_text_from_fragment_html(v)
        else:
            t = _normalize_plain_text(str(v))
        if t:
            out.append(t)
    return out
