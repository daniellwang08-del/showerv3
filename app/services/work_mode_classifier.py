"""Fast work-mode classification for vector-engine jobs.

Priority (accuracy first, then speed):
  1. Explicit ATS enums / scraper flags (instant, highest precision)
  2. High-precision keyword rules on title / location / workplace labels / body
  3. MiniLM prototype cosine against remote / hybrid / onsite exemplars
     (same model as job encoding — microseconds after warm load)

Greenhouse has no workplaceType field (unlike Lever/Ashby), so steps 2–3 are
the only reliable path for those boards. Prototype matching runs inside the
encoding worker so analysis/API processes never load torch.
"""

from __future__ import annotations

import re
from typing import Any

import numpy as np

from app.core.logging import get_logger
from app.services.job_field_utils import normalize_work_mode_display

logger = get_logger(__name__)

WorkMode = str  # "remote" | "hybrid" | "onsite"

# Require a clear winner so ambiguous JDs stay unset rather than wrong.
_VECTOR_MIN_COS = 0.38
_VECTOR_MIN_MARGIN = 0.04

_PROTOTYPE_TEXTS: dict[str, list[str]] = {
    "remote": [
        "This is a fully remote position. Work from home from anywhere.",
        "Remote-first role. Distributed team. No office attendance required.",
        "100% remote work. Candidates may work from anywhere in the country.",
        "Work from home. Telecommute. Remote location worldwide.",
    ],
    "hybrid": [
        "Hybrid role mixing remote days and required in-office days.",
        "Flexible hybrid schedule: some days at the office, some remote.",
        "Hybrid workplace: partially remote with regular office presence.",
    ],
    "onsite": [
        "This is an on-site role requiring daily presence at the office.",
        "In-office position at our headquarters. Not a remote role.",
        "Must work on-site. In-person attendance required every workday.",
    ],
}

_BODY_SIGNAL_RE = re.compile(
    r"(?i)(?:^|\n).{0,120}(?:"
    r"remote|hybrid|on-?\s*site|onsite|in-?\s*office|work[\s-]*from[\s-]*home|"
    r"\bwfh\b|telecommut|distributed team|office presence|come into the office"
    r").{0,160}(?:\n|$)"
)

_TITLE_MODE_RE = re.compile(
    r"(?i)(?:"
    # "Engineer | REMOTE", "Engineer - Hybrid", trailing marker
    r"[|/\-–—]\s*(?P<a>remote|hybrid|on-?\s*site|onsite|in-?\s*office|wfh|work[\s-]*from[\s-]*home)\s*$"
    # "(Remote)", "(Hybrid)"
    r"|\((?P<b>remote|hybrid|on-?\s*site|onsite|in-?\s*office|wfh)\)"
    # Entire title is just the mode keyword
    r"|^(?P<c>remote|hybrid|on-?\s*site|onsite|in-?\s*office|wfh)\s*$"
    r")"
)

_prototype_matrix: np.ndarray | None = None
_prototype_labels: list[str] = []


def _ensure_prototypes() -> tuple[np.ndarray, list[str]]:
    """Lazy-encode prototypes once per process (encoding worker)."""
    global _prototype_matrix, _prototype_labels
    if _prototype_matrix is not None:
        return _prototype_matrix, _prototype_labels

    from app.services.encoding_service import encode_texts

    labels: list[str] = []
    texts: list[str] = []
    for mode, samples in _PROTOTYPE_TEXTS.items():
        for sample in samples:
            labels.append(mode)
            texts.append(sample)
    matrix = encode_texts(texts)
    _prototype_matrix = np.asarray(matrix, dtype=np.float32)
    _prototype_labels = labels
    logger.info("work_mode_prototypes_ready", n=len(labels))
    return _prototype_matrix, _prototype_labels


def build_work_mode_signal_text(
    *,
    title: str | None = None,
    location: str | None = None,
    workplace: str | None = None,
    plain_text: str | None = None,
) -> str:
    """Compact text for embedding — prefer mode-bearing snippets over full JD."""
    parts: list[str] = []
    for value in (title, location, workplace):
        cleaned = (value or "").strip()
        if cleaned:
            parts.append(cleaned)

    body = (plain_text or "").strip()
    if body:
        hits = _BODY_SIGNAL_RE.findall(body)
        if hits:
            # Keep the strongest mode-bearing lines only.
            parts.extend(h.strip() for h in hits[:8] if h.strip())
        else:
            # Fall back to a short head of the posting (mode often appears early).
            parts.append(body[:900])

    return "\n".join(parts).strip()


def classify_work_mode_rules(
    *,
    title: str | None = None,
    location: str | None = None,
    workplace: str | None = None,
    remote_policy: str | None = None,
    plain_text: str | None = None,
    is_remote: bool = False,
) -> WorkMode | None:
    """Deterministic high-precision rules (no model load)."""
    for value in (workplace, remote_policy, location):
        mode = normalize_work_mode_display(value)
        if mode:
            return mode

    if title:
        # Prefer delimited markers ("| REMOTE", "(Hybrid)") over substring matches
        # so titles like "Remote Support Engineer" are not forced to remote.
        m = _TITLE_MODE_RE.search(title)
        if m:
            token = m.group("a") or m.group("b") or m.group("c")
            mode = normalize_work_mode_display(token)
            if mode:
                return mode
        # Exact title is a mode keyword only (not "Remote Support Engineer").
        if re.fullmatch(
            r"(?i)\s*(remote|hybrid|on-?\s*site|onsite|in-?\s*office|wfh)\s*",
            title.strip(),
        ):
            mode = normalize_work_mode_display(title)
            if mode:
                return mode

    if plain_text:
        # Prefer explicit workplace / remote labeled lines if present.
        for line in plain_text.splitlines()[:80]:
            lower = line.lower().strip()
            if lower.startswith(("workplace", "workplace type", "remote:", "work mode")):
                mode = normalize_work_mode_display(line.split(":", 1)[-1])
                if mode:
                    return mode

        # Body keyword scan on mode-bearing lines only.
        for hit in _BODY_SIGNAL_RE.findall(plain_text)[:12]:
            mode = normalize_work_mode_display(hit)
            if mode:
                return mode

    if is_remote:
        return "remote"
    return None


def classify_work_mode_vector(signal_text: str) -> tuple[WorkMode | None, dict[str, Any]]:
    """MiniLM prototype cosine. Returns (mode, explain)."""
    text = (signal_text or "").strip()
    if len(text) < 8:
        return None, {"reason": "signal_too_short"}

    from app.services.encoding_service import encode_texts

    prototypes, labels = _ensure_prototypes()
    query = encode_texts([text[:2000]])[0]
    sims = prototypes @ query  # L2-normalized → cosine
    best_idx = int(np.argmax(sims))
    best_cos = float(sims[best_idx])
    best_mode = labels[best_idx]

    # Margin vs best competing *other* class.
    other = [float(sims[i]) for i, lab in enumerate(labels) if lab != best_mode]
    second = max(other) if other else -1.0
    margin = best_cos - second

    explain = {
        "best_mode": best_mode,
        "best_cos": round(best_cos, 4),
        "margin": round(margin, 4),
        "per_class_max": {
            mode: round(float(max(sims[i] for i, lab in enumerate(labels) if lab == mode)), 4)
            for mode in ("remote", "hybrid", "onsite")
        },
    }
    if best_cos < _VECTOR_MIN_COS or margin < _VECTOR_MIN_MARGIN:
        explain["reason"] = "below_threshold"
        return None, explain
    return best_mode, explain


def classify_work_mode(
    *,
    title: str | None = None,
    location: str | None = None,
    workplace: str | None = None,
    remote_policy: str | None = None,
    plain_text: str | None = None,
    is_remote: bool = False,
    use_vector: bool = False,
) -> tuple[WorkMode | None, dict[str, Any]]:
    """Full classifier. ``use_vector=True`` only from encoding processes."""
    rules = classify_work_mode_rules(
        title=title,
        location=location,
        workplace=workplace,
        remote_policy=remote_policy,
        plain_text=plain_text,
        is_remote=is_remote,
    )
    if rules:
        return rules, {"source": "rules", "mode": rules}

    if not use_vector:
        return None, {"source": "rules", "mode": None}

    signal = build_work_mode_signal_text(
        title=title,
        location=location,
        workplace=workplace or remote_policy,
        plain_text=plain_text,
    )
    mode, explain = classify_work_mode_vector(signal)
    explain["source"] = "vector"
    explain["signal_chars"] = len(signal)
    return mode, explain
