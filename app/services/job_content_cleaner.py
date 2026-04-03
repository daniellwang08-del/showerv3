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
    # Workable, Greenhouse-style: data-ui on section without class "job-description"
    "[data-ui='job-description']",
    "[data-ui='job-requirements']",
    "[data-ui='job-benefits']",
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

# Phrases common in standalone EEO / OFCCP / legal blocks (often mis-selected as "article").
_BOILERPLATE_PHRASES: Final[tuple[str, ...]] = (
    "equal opportunity employer",
    "equal employment opportunity",
    "does not discriminate",
    "discrimination in any form",
    "race, color, religion",
    "national origin",
    "genetic information",
    "gender identity",
    "sexual orientation",
    "protected veteran",
    "reasonable accommodation",
    "disability status",
    "eeo is the law",
    "ofccp",
    "affirmative action",
    "applicants will receive consideration",
)

# CMP / cookie-banner copy (Workable, OneTrust, etc.) — not a job description.
_CMP_COOKIE_MARKERS: Final[tuple[str, ...]] = (
    "this website uses cookies",
    "this website stores cookies",
    "cookies are used to collect information",
    "improve and customize your browsing experience",
    "accept all cookies",
    "manage your cookie settings",
    "cookies policy",
    "cookie settings",
    "personalise ads",
    "personalize ads",
    "analyse traffic",
    "analyze traffic",
    "decline all optional cookies",
)

# Section-like headers that suggest a real JD (light boost when length is comparable).
_JOB_SECTION_HINTS: Final[tuple[str, ...]] = (
    "responsibilities",
    "requirements",
    "qualifications",
    "what you'll do",
    "what you will do",
    "about the role",
    "about this role",
    "minimum qualifications",
    "preferred qualifications",
)

# ATS **application** UIs (Greenhouse job_app iframe, etc.) — not a posting body; heavy penalty in rank.
_APPLICATION_FORM_MARKERS: Final[tuple[str, ...]] = (
    "apply for this job",
    "voluntary self-identification",
    "public burden statement",
    "omb control number",
    "form cc-305",
    "disability status",
    "veteran status",
    "are you hispanic",
    "government reporting purposes, we ask candidates",
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


def _selector_candidate_texts(tree) -> list[str]:
    """Collect normalized text from every matching element (not only the first)."""
    out: list[str] = []
    for selector in _JOB_BODY_SELECTORS:
        try:
            for el in tree.cssselect(selector):
                try:
                    t = _normalize_plain_text(el.text_content())
                    if len(t) >= 40:
                        out.append(t)
                except Exception:
                    continue
        except Exception:
            continue
    return out


def _serialize_tree_for_readability(tree) -> str:
    """
    Serialize the cleaned, chrome-stripped tree so Readability sees the same DOM as selectors.

    Using the original full HTML for Document() lets footer/nav win internal scoring even when
    those nodes were removed from our lxml tree.
    """
    try:
        return lxml_html.tostring(tree, encoding="unicode", method="html")
    except Exception as e:
        logger.debug("tree_serialize_for_readability_failed", error=str(e))
        return ""


def _boilerplate_phrase_hits(text: str) -> int:
    if not text:
        return 0
    lower = text.lower()
    return sum(1 for phrase in _BOILERPLATE_PHRASES if phrase in lower)


def _job_section_hint_hits(text: str) -> int:
    if not text:
        return 0
    lower = text.lower()
    return sum(1 for hint in _JOB_SECTION_HINTS if hint in lower)


def _application_form_marker_hits(text: str) -> int:
    if not text:
        return 0
    lower = text.lower()
    return sum(1 for phrase in _APPLICATION_FORM_MARKERS if phrase in lower)


def _cmp_cookie_marker_hits(text: str) -> int:
    if not text:
        return 0
    lower = text.lower()
    return sum(1 for phrase in _CMP_COOKIE_MARKERS if phrase in lower)


def _is_dominated_by_cmp_cookie_notice(text: str) -> bool:
    """True when extracted text is mostly a cookie/CMP banner (no real JD)."""
    if not text or len(text) > 4500:
        return False
    if _job_section_hint_hits(text) > 0:
        return False
    return _cmp_cookie_marker_hits(text) >= 3


def _candidate_rank_score(text: str) -> float:
    """
    Higher is better. Favors substantial, job-like text over long legal/EEO-only blobs.

    Readability and generic regions can merge JD + legal into one long string; raw length
    then beats a shorter ``.job-description``. We penalize **counts of distinct** tracked
    legal phrases sublinearly in ``n`` via ``n / (1 + k * bp)`` so a real posting with one
    EEO footer still scores well, while an EEO-heavy or merged blob does not.
    """
    n = len(text)
    if n == 0:
        return 0.0

    bp = _boilerplate_phrase_hits(text)
    hints = _job_section_hint_hits(text)
    lines = text.count("\n") + 1

    # k tuned so short real JDs beat long merged/compliance-only text in unit tests & prod.
    base = n / (1.0 + 5.0 * float(bp))

    if lines >= 14:
        base *= 1.1
    elif lines >= 6:
        base *= 1.04

    if hints:
        base *= 1.0 + min(0.18, 0.035 * float(hints))

    cmp_hits = _cmp_cookie_marker_hits(text)
    if cmp_hits >= 2 and not hints:
        base *= 0.04 + min(0.06, 0.02 * float(cmp_hits))

    return base


def _best_body_plain_text(tree, html_for_readability: str) -> str:
    """
    Pick the best plausible job body among selector hits, Readability, and full-tree fallback.

    Readability must use ``html_for_readability`` from the same chrome-stripped tree as
    ``tree``. Ranking uses length plus anti-boilerplate and light JD-structure hints.

    Whole-tree ``text_content()`` is only used when no region is long enough: including it
    whenever selectors match would concatenate multiple regions (e.g. JD + legal) and beat
    the real posting in ``max(...)``.
    """
    candidates: list[str] = _selector_candidate_texts(tree)

    readable = _readability_plain_text(html_for_readability)
    if readable:
        candidates.append(readable)

    substantial = [c for c in candidates if len(c) >= 80]
    if not substantial:
        try:
            fallback = _normalize_plain_text(tree.text_content())
            if fallback:
                candidates.append(fallback)
        except Exception:
            pass

    if not candidates:
        return ""

    good = [c for c in candidates if len(c) >= 80]
    pool = good if good else candidates
    best = max(pool, key=_candidate_rank_score)
    return best


def _readability_plain_text(html: str) -> str:
    if not html or not html.strip():
        return ""
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
    job-specific selectors → Readability (on **the same** chrome-stripped HTML) →
    whole-tree text (last resort). Best candidate is chosen by rank score, not raw length.
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

    html_for_readability = _serialize_tree_for_readability(tree)
    body = _best_body_plain_text(tree, html_for_readability)
    if body and _is_dominated_by_cmp_cookie_notice(body):
        logger.warning(
            "plain_text_cookie_cmp_only_skipped",
            chars=len(body),
        )
        return ""
    if body:
        return _truncate(body)

    return ""


def rank_document_html_for_extraction(html: str) -> float:
    """
    Scalar score for comparing HTML sources (main document vs child frame / iframe).

    Reuses the production plain-text pipeline (including CMP rejection), then the same
    anti-boilerplate ranking as in-page candidate selection — so a long shell with legal
    chrome does not beat a shorter ATS iframe with a real JD.

    Strongly down-weights Greenhouse **application** pages (EEO/survey copy): those can be
    longer than the parent careers shell but are not job descriptions.
    """
    text = plain_text_from_document_html(html)
    if not text:
        return 0.0
    base = _candidate_rank_score(text)
    af = _application_form_marker_hits(text)
    if af >= 3:
        base *= 1.0 / (1.0 + 0.55 * float(af - 2))
    return base


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
