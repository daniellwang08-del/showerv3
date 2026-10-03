"""Deterministic bold emphasis for JD technology keywords in tailored resume text."""

from __future__ import annotations

import re
from typing import Iterable


# Soft / process jargon that must never be treated as tech keywords to bold.
_SOFT_STOP = frozenset(
    {
        "agile",
        "scrum",
        "kanban",
        "leadership",
        "communication",
        "teamwork",
        "collaboration",
        "collaborative",
        "problem-solving",
        "problemsolving",
        "ownership",
        "mentorship",
        "mentoring",
        "stakeholder",
        "stakeholders",
        "cross-functional",
        "crossfunctional",
        "best",
        "practices",
        "experience",
        "responsible",
        "team",
        "project",
        "projects",
        "work",
        "working",
        "ability",
        "strong",
        "excellent",
        "good",
        "preferred",
        "required",
        "requirements",
        "responsibilities",
        "including",
        "using",
        "years",
        "year",
    }
)


def is_tech_like_keyword(term: str) -> bool:
    """True if *term* looks like a technology / stack token worth emphasizing."""
    t = (term or "").strip()
    if len(t) < 2:
        return False
    key = t.lower()
    if key in _SOFT_STOP:
        return False
    # Multi-word requirement fragments (e.g. "payment ledger"), keep if not all soft.
    if " " in t:
        tokens = [p.strip(".,;:") for p in t.split() if p.strip(".,;:")]
        if not tokens or len(t) > 48 or len(tokens) > 6:
            return False
        if all(p.lower() in _SOFT_STOP for p in tokens):
            return False
        return True
    # Allow known short tech tokens.
    if key in {"go", "c", "r", "c++", "c#", "js", "ts", "sql", "aws", "gcp", "ci", "cd"}:
        return True
    if len(t) < 3:
        return False
    # Digits / punctuation often mark real tech (k8s, node.js, c++, .net).
    if any(ch.isdigit() or ch in ".+#/-" for ch in t):
        return True
    # CamelCase or ALLCAPS acronyms.
    if t.isupper() and 2 <= len(t) <= 8:
        return True
    if re.search(r"[a-z][A-Z]", t):
        return True
    # Common tech-ish suffixes / patterns.
    if re.search(
        r"(sql|db|api|sdk|cli|ops|cloud|stack|script|lang|kube|docker|redis|kafka|grpc)$",
        key,
    ):
        return True
    # Default: multi-char alphabetic tokens that are not soft stopwords.
    return bool(re.fullmatch(r"[A-Za-z][A-Za-z0-9.+#/-]{2,}", t))


def _already_bolded(text: str, start: int, end: int) -> bool:
    """Return True if the span is already inside a ``**...**`` pair."""
    before = text[:start]
    # Odd count of ``**`` before this span means we are inside an open bold region.
    return before.count("**") % 2 == 1


def emphasize_keywords_in_text(text: str, keywords: Iterable[str]) -> str:
    """Wrap whole-word occurrences of *keywords* in ``**...**`` when not already bold.

    Longer keywords are applied first to prefer multi-word phrases.
    """
    if not text or not keywords:
        return text or ""
    # Preserve order by length desc, unique case-insensitive.
    seen: set[str] = set()
    ordered: list[str] = []
    for raw in keywords:
        term = str(raw or "").strip()
        if not term or not is_tech_like_keyword(term):
            continue
        key = term.lower()
        if key in seen:
            continue
        seen.add(key)
        ordered.append(term)
    ordered.sort(key=len, reverse=True)

    out = text
    for term in ordered:
        # Escape regex metacharacters; allow flexible internal whitespace for multi-word.
        parts = [re.escape(p) for p in term.split() if p]
        if not parts:
            continue
        if len(parts) == 1:
            pattern = re.compile(rf"(?<![\w*])({parts[0]})(?![\w*])", re.IGNORECASE)
        else:
            pattern = re.compile(
                rf"(?<![\w*])({'[ \\t]+'.join(parts)})(?![\w*])",
                re.IGNORECASE,
            )

        pieces: list[str] = []
        last = 0
        for m in pattern.finditer(out):
            start, end = m.start(1), m.end(1)
            pieces.append(out[last:start])
            if _already_bolded(out, start, end):
                pieces.append(m.group(1))
            elif (
                start >= 2
                and end + 2 <= len(out)
                and out[start - 2 : start] == "**"
                and out[end : end + 2] == "**"
            ):
                pieces.append(m.group(1))
            else:
                pieces.append(f"**{m.group(1)}**")
            last = end
        pieces.append(out[last:])
        out = "".join(pieces)
    return out


def apply_keyword_emphasis_to_resume(
    resume: dict | None,
    keywords: Iterable[str],
) -> dict | None:
    """Return a copy of *resume* with JD tech keywords bolded in narrative fields."""
    if not resume or not isinstance(resume, dict):
        return resume
    terms = [str(k).strip() for k in keywords if str(k or "").strip()]
    if not terms:
        return resume

    out = dict(resume)
    if isinstance(out.get("profile_summary"), str):
        out["profile_summary"] = emphasize_keywords_in_text(out["profile_summary"], terms)

    skills_out: list[dict] = []
    for item in out.get("technical_skills") or []:
        if not isinstance(item, dict):
            continue
        row = dict(item)
        if isinstance(row.get("skills"), str):
            row["skills"] = emphasize_keywords_in_text(row["skills"], terms)
        skills_out.append(row)
    if skills_out or out.get("technical_skills") is not None:
        out["technical_skills"] = skills_out

    exp_out: list[dict] = []
    for entry in out.get("work_experience") or []:
        if not isinstance(entry, dict):
            continue
        row = dict(entry)
        if isinstance(row.get("project_description"), str):
            row["project_description"] = emphasize_keywords_in_text(
                row["project_description"], terms
            )
        if isinstance(row.get("used_skills"), str):
            row["used_skills"] = emphasize_keywords_in_text(row["used_skills"], terms)
        bullets = []
        for b in row.get("bullets") or []:
            if isinstance(b, str) and b.strip():
                bullets.append(emphasize_keywords_in_text(b, terms))
        row["bullets"] = bullets
        exp_out.append(row)
    if exp_out or out.get("work_experience") is not None:
        out["work_experience"] = exp_out
    return out
