"""ML job metadata extraction via MiniLM candidate ranking.

Design (CPU, same model as vector match encodings):
  1. Prefer structured ATS API fields when present (JSON, not text search).
  2. Otherwise generate *generic* text spans (windows / sentences), no vendor
     chrome string matching for the final decision.
  3. Embed candidates + field prototypes with MiniLM; pick the span whose
     cosine to TITLE / COMPANY prototypes wins (and loses to NOISE).

This runs in the encoding worker (model already warm). Hydrate stays cheap
and only applies structured / labeled ATS fields.
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import parse_qs, urlparse

import numpy as np

from app.core.logging import get_logger
from app.services.job_field_utils import clean_optional_job_field

logger = get_logger(__name__)

_MIN_TITLE_COS = 0.34
_MIN_COMPANY_COS = 0.33
_MIN_MARGIN_VS_NOISE = 0.04
_MAX_CANDIDATES = 80
_MAX_SCAN_CHARS = 1400
_MAX_TITLE_LEN = 90
_MAX_COMPANY_LEN = 48

_TITLE_PROTOTYPES = [
    "The job title is Senior Software Engineer",
    "Role name: Staff Machine Learning Engineer",
    "Position: Full Stack Developer",
    "Hiring for a Product Manager",
    "We are looking for a Data Scientist",
]
_COMPANY_PROTOTYPES = [
    "The employer company is Upbound",
    "Company name: Acme Corporation",
    "This position is at Google",
    "Organization: Contoso Labs",
    "Join our team at Stripe",
]
_NOISE_PROTOTYPES = [
    "Create a Job Alert and apply with your resume",
    "First Name Last Name Email Phone required field",
    "Skip to main content search by keyword",
    "San Francisco California United States location only",
    "Please refresh the page or contact your administrator",
    "About the Company we build products and services",
    "Apply for this job and submit your application",
    "organizations build operate and scale systems",
    "team committed to delivering customer value",
]

_TITLE_NOISE_PREFIXES = (
    "job application for",
    "apply for",
    "create a job alert",
    "interested in building",
    "about the",
    "the role",
    "the page you",
    "job posting unavailable",
    "we are",
    "you will",
    "you are",
)
_COMPANY_NOISE_TOKENS = frozenset(
    {
        "the",
        "and",
        "or",
        "for",
        "with",
        "our",
        "your",
        "this",
        "that",
        "role",
        "team",
        "build",
        "building",
        "products",
        "services",
        "pipelines",
        "committed",
        "organizations",
        "organization",
        "operate",
        "about",
        "company",
        "apply",
        "developers",
        "support",
        "frontends",
        "integrationen",
        "mentor",
        "guide",
        "relevant",
        "technical",
        "attention",
        "detail",
        "looking",
        "expert",
        "knowledge",
        "together",
        "where",
        "site",
    }
)

_SPLIT_RE = re.compile(r"[\n\r|;•]+|(?<=[.!?])\s+")
# Role word fused to the next block's text (``EngineerSenior``, ``EngineerAI``):
# a sign the HTML lost its block boundaries, never a real title.
_GLUED_ROLE_RE = re.compile(
    r"(?:Engineer|Developer|Manager|Scientist|Analyst|Designer|Architect|"
    r"Consultant|Director|Lead|Specialist|Intern|Officer)[A-Z]"
)
_WORD_RE = re.compile(r"\S+")
_MULTI_SPACE = re.compile(r"\s+")

_proto_cache: dict[str, np.ndarray] | None = None


def _ensure_prototypes() -> dict[str, np.ndarray]:
    global _proto_cache
    if _proto_cache is not None:
        return _proto_cache
    from app.services.encoding_service import encode_texts

    _proto_cache = {
        "title": encode_texts(_TITLE_PROTOTYPES),
        "company": encode_texts(_COMPANY_PROTOTYPES),
        "noise": encode_texts(_NOISE_PROTOTYPES),
    }
    logger.info(
        "metadata_ml_prototypes_ready",
        title_n=len(_TITLE_PROTOTYPES),
        company_n=len(_COMPANY_PROTOTYPES),
    )
    return _proto_cache


def _norm(text: str) -> str:
    return _MULTI_SPACE.sub(" ", (text or "").strip())


def _board_slug_candidate(source_url: str | None) -> str | None:
    """Structured URL signal (board token), not page-text search."""
    if not source_url:
        return None
    try:
        parsed = urlparse(source_url)
        host = (parsed.hostname or "").lower()
        path = parsed.path or ""
        qs = parse_qs(parsed.query or "")
    except Exception:
        return None
    if "greenhouse.io" in host:
        if "for" in qs and qs["for"]:
            slug = qs["for"][0].strip()
            if slug and slug.lower() not in {"embed", "job_app"}:
                return _slug_to_display(slug)
        parts = [p for p in path.split("/") if p and p not in {"embed", "job_app", "jobs"}]
        if parts and parts[0].lower() not in {"embed"}:
            return _slug_to_display(parts[0])
    if "lever.co" in host:
        parts = [p for p in path.split("/") if p]
        if parts:
            return _slug_to_display(parts[0])
    if "ashbyhq.com" in host:
        parts = [p for p in path.split("/") if p]
        if parts:
            return _slug_to_display(parts[0])
    return None


def _slug_to_display(slug: str) -> str:
    text = slug.replace("-", " ").replace("_", " ").strip()
    parts = []
    for tok in text.split():
        if tok.isupper() and len(tok) <= 6:
            parts.append(tok)
        else:
            parts.append(tok[:1].upper() + tok[1:].lower() if tok else tok)
    return " ".join(parts)


def generate_span_candidates(plain_text: str | None) -> list[str]:
    """Generic span proposals, vendor-agnostic windows over the posting head."""
    if not plain_text:
        return []
    head = _norm(plain_text[:_MAX_SCAN_CHARS])
    if not head:
        return []

    seen: set[str] = set()
    out: list[str] = []

    def _add(raw: str) -> None:
        span = _norm(raw)
        if not span or len(span) < 2 or len(span) > 160:
            return
        key = span.lower()
        if key in seen:
            return
        # Drop pure form-chrome / tiny tokens.
        if key in {"new", "remote", "hybrid", "apply", "careers", "jobs"}:
            return
        seen.add(key)
        out.append(span)

    # Split on the raw head: ``_norm`` folds newlines, which are the strongest
    # field boundary in page text.
    chunks = [c for c in (_norm(c) for c in _SPLIT_RE.split(plain_text[:_MAX_SCAN_CHARS])) if c]
    for chunk in chunks:
        _add(chunk)

    # Sliding windows (3-12 tokens) over the start of the posting. Windows stay
    # inside one line / ``|`` segment so ``Engineer | Career`` never forms.
    segments: list[list[str]] = []
    budget = 90
    for chunk in chunks:
        if budget <= 0:
            break
        words = _WORD_RE.findall(chunk)[:budget]
        budget -= len(words)
        segments.append(words)
    for n in (3, 4, 5, 6, 7, 8, 10, 12):
        for words in segments:
            for i in range(0, max(0, len(words) - n + 1)):
                _add(" ".join(words[i : i + n]))
                if len(out) >= _MAX_CANDIDATES:
                    return out[:_MAX_CANDIDATES]

    # Capitalized multi-word runs (common for titles/companies in HTML text).
    for chunk in chunks:
        for m in re.finditer(
            r"\b([A-Z][A-Za-z0-9+.#/&'’-]*(?:\s+(?:&|and|[A-Z][A-Za-z0-9+.#/&'’-]*)){0,8})\b",
            chunk,
        ):
            _add(m.group(1))
            if len(out) >= _MAX_CANDIDATES:
                return out[:_MAX_CANDIDATES]

    return out[:_MAX_CANDIDATES]


def _max_proto_cos(vec: np.ndarray, proto: np.ndarray) -> float:
    return float(np.max(proto @ vec))


def _looks_like_title(span: str) -> bool:
    text = _norm(span)
    if not text or len(text) < 3 or len(text) > _MAX_TITLE_LEN:
        return False
    low = text.lower()
    if any(low.startswith(p) for p in _TITLE_NOISE_PREFIXES):
        return False
    if low.count(",") > 2:
        return False
    if _GLUED_ROLE_RE.search(text):
        return False
    # Prefer role-like phrases (Engineer/Manager/…) or short Title Case runs.
    role_hint = re.search(
        r"\b(engineer|developer|manager|scientist|analyst|designer|architect|"
        r"consultant|director|lead|specialist|intern|officer)\b",
        low,
    )
    words = text.split()
    if role_hint:
        return True
    if 2 <= len(words) <= 10 and sum(1 for w in words if w[:1].isupper()) >= max(2, len(words) // 2):
        return True
    return False


def _looks_like_company(span: str) -> bool:
    text = _norm(span)
    if not text or len(text) < 2 or len(text) > _MAX_COMPANY_LEN:
        return False
    if any(ch in text for ch in ",.;:!?/"):
        return False
    words = text.split()
    if len(words) > 5:
        return False
    low_words = [w.lower().strip(".,") for w in words]
    if any(w in _COMPANY_NOISE_TOKENS for w in low_words):
        return False
    # Reject sentence fragments starting with a lowercase word.
    if words[0][:1].islower():
        return False
    return True


def extract_title_company_ml(
    plain_text: str | None,
    *,
    source_url: str | None = None,
    existing_title: str | None = None,
    existing_company: str | None = None,
) -> dict[str, Any]:
    """Return ``{title, company, explain}`` using MiniLM span ranking."""
    from app.services.encoding_service import encode_texts

    existing_title_c = clean_optional_job_field(existing_title)
    existing_company_c = clean_optional_job_field(existing_company)
    need_title = existing_title_c is None
    need_company = existing_company_c is None

    explain: dict[str, Any] = {"source": "minilm_span_rank"}
    if not need_title and not need_company:
        return {
            "title": existing_title_c,
            "company": existing_company_c,
            "explain": {**explain, "skipped": "already_filled"},
        }

    candidates = generate_span_candidates(plain_text)
    board = _board_slug_candidate(source_url)
    if board:
        candidates = [board] + [c for c in candidates if c.lower() != board.lower()]

    if not candidates:
        return {
            "title": existing_title_c,
            "company": existing_company_c or board,
            "explain": {**explain, "reason": "no_candidates"},
        }

    prototypes = _ensure_prototypes()
    cand_vecs = encode_texts(candidates)

    title_scores = []
    company_scores = []
    for i, span in enumerate(candidates):
        v = cand_vecs[i]
        t = _max_proto_cos(v, prototypes["title"])
        c = _max_proto_cos(v, prototypes["company"])
        n = _max_proto_cos(v, prototypes["noise"])
        title_scores.append((t - n, t, n, i, span))
        company_scores.append((c - n, c, n, i, span))

    title_scores.sort(reverse=True)
    company_scores.sort(reverse=True)

    title_out = existing_title_c
    company_out = existing_company_c

    if need_title and title_scores:
        picked_title = None
        for margin, cos, noise, idx, span in title_scores[:12]:
            if cos < _MIN_TITLE_COS or margin < _MIN_MARGIN_VS_NOISE:
                continue
            if not _looks_like_title(span):
                continue
            picked_title = (margin, cos, noise, span)
            break
        if picked_title:
            margin, cos, noise, span = picked_title
            title_out = span
            explain["title_best"] = {
                "span": span,
                "cos": round(cos, 4),
                "noise": round(noise, 4),
                "margin": round(margin, 4),
            }
        elif title_scores:
            margin, cos, noise, idx, span = title_scores[0]
            explain["title_best"] = {
                "span": span,
                "cos": round(cos, 4),
                "rejected": True,
            }

    if need_company:
        # Prefer structured board slug from the URL over span ranking.
        if board:
            company_out = board
            explain["company_best"] = {"span": board, "source": "board_slug"}
        else:
            picked = None
            for margin, cos, noise, idx, span in company_scores[:12]:
                if title_out and span.lower() == title_out.lower():
                    continue
                if cos < _MIN_COMPANY_COS or margin < _MIN_MARGIN_VS_NOISE:
                    continue
                if not _looks_like_company(span):
                    continue
                picked = (margin, cos, noise, span)
                break
            if picked is not None:
                margin, cos, noise, span = picked
                company_out = span
                explain["company_best"] = {
                    "span": span,
                    "cos": round(cos, 4),
                    "noise": round(noise, 4),
                    "margin": round(margin, 4),
                }
            elif company_scores:
                margin, cos, noise, idx, span = company_scores[0]
                explain["company_best"] = {
                    "span": span,
                    "cos": round(cos, 4),
                    "rejected": True,
                }

    return {"title": title_out, "company": company_out, "explain": explain}
