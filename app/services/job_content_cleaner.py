"""
Convert HTML to clean plain text for downstream LLM analysis.

This module strips structural/rendering elements (tags, attributes, styles,
scripts) and returns the full visible text content of the page.  It does NOT
attempt to locate or rank specific job-description regions - the analysis
engine (LLM) determines which parts of the text constitute the job posting.

Public API
----------
- ``plain_text_from_document_html``  - full HTML document → plain text
- ``plain_text_from_fragment_html``  - HTML fragment (e.g. JSON-LD description) → plain text
"""

from __future__ import annotations

import re
from typing import Final

from lxml import html as lxml_html
from lxml_html_clean import Cleaner

from app.core.logging import get_logger
from app.utils.text_sanitizer import sanitize_for_postgres_text

logger = get_logger(__name__)

_MAX_PLAIN_TEXT_CHARS: Final[int] = 500_000

_REMOVE_TAGS: Final[frozenset[str]] = frozenset({
    "script", "style", "noscript", "svg", "template",
    "iframe", "object", "embed", "applet",
    "input", "select", "textarea", "button",
    "canvas", "video", "audio", "source", "track",
    "map", "area", "picture",
})

_BR_TAGS_RE = re.compile(r"<br\s*/?>", re.IGNORECASE)

# lxml ``text_content()`` concatenates text nodes verbatim, so minified markup
# (``<h1>Engineer</h1><p>About</p>``) fuses into ``EngineerAbout``. Breaking
# lines at block boundaries mirrors what a browser's ``innerText`` returns.
_BLOCK_TAGS: Final[frozenset[str]] = frozenset({
    "address", "article", "aside", "blockquote", "body", "caption", "dd",
    "details", "dialog", "div", "dl", "dt", "fieldset", "figcaption", "figure",
    "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup",
    "legend", "li", "main", "nav", "ol", "option", "p", "pre", "section",
    "summary", "table", "tbody", "tfoot", "thead", "title", "tr", "ul",
})
_VOID_BREAK_TAGS: Final[frozenset[str]] = frozenset({"br", "hr"})
_CELL_TAGS: Final[frozenset[str]] = frozenset({"td", "th"})


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
        forms=False,
    )


def _sanitize_html_input(html: str | None) -> str:
    if not html:
        return ""
    cleaned = sanitize_for_postgres_text(html)
    return cleaned if cleaned else ""


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
        "plain_text_truncated",
        original_chars=len(text),
        max_chars=_MAX_PLAIN_TEXT_CHARS,
    )
    return text[:_MAX_PLAIN_TEXT_CHARS]


def _mark_block_boundaries(tree) -> None:
    for el in tree.iter():
        if not isinstance(el.tag, str):
            continue
        tag = el.tag.lower()
        if tag in _BLOCK_TAGS:
            el.text = "\n" + (el.text or "")
            el.tail = "\n" + (el.tail or "")
        elif tag in _VOID_BREAK_TAGS:
            el.tail = "\n" + (el.tail or "")
        elif tag in _CELL_TAGS:
            el.tail = " " + (el.tail or "")


def _block_text(tree) -> str:
    _mark_block_boundaries(tree)
    return tree.text_content()


def _remove_non_content_elements(tree) -> None:
    for tag in _REMOVE_TAGS:
        for el in tree.xpath(f".//{tag}"):
            parent = el.getparent()
            if parent is not None:
                parent.remove(el)


def plain_text_from_document_html(html: str) -> str:
    """
    Full HTML document → clean plain text.

    Strips scripts, styles, form inputs, media, and other non-text elements.
    Preserves the full visible text content for downstream LLM analysis.
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

    _remove_non_content_elements(tree)

    try:
        text = _block_text(tree)
    except Exception:
        text = re.sub(r"<[^>]+>", " ", html)

    return _truncate(_normalize_plain_text(text))


def plain_text_from_fragment_html(fragment: str) -> str:
    """
    HTML fragment (e.g. JSON-LD ``description``, API ``content`` field) → plain text.

    Does not assume a full ``<html>`` wrapper; wraps safely for parsing.
    """
    fragment = _sanitize_html_input(fragment)
    if not fragment:
        return ""

    if "<" not in fragment:
        return _truncate(_normalize_plain_text(fragment))

    fragment = _BR_TAGS_RE.sub("\n", fragment)

    wrapped = f"<div class='__fragment_root__'>{fragment}</div>"
    try:
        tree = lxml_html.fromstring(wrapped)
    except Exception:
        return _truncate(_normalize_plain_text(re.sub(r"<[^>]+>", " ", fragment)))

    try:
        tree = _html_cleaner().clean_html(tree)
    except Exception:
        pass

    text = _block_text(tree)
    return _truncate(_normalize_plain_text(text))
