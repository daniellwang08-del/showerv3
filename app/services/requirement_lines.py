"""Requirement lines of a posting, and how well a profile covers them (no LLM).

Each substantive posting line is tagged with the section heading it sits
under, embedded with the shared sentence encoder, and classified as a hard
requirement ("must"), a nice-to-have ("nice") or neither by a small
multinomial logistic model stored in ``match_models/req_lines.json``. Scoring
then measures, per requirement, the best-matching profile line.

The same functions build the training data offline and run at encode / score
time, so the scorer sees exactly the features it was fitted on.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

import numpy as np

from app.services.skill_lexicon import PREFERRED_HEADING_RE, REQUIRED_HEADING_RE

MODEL_DIR = Path(__file__).with_name("match_models")

_MAX_LINES = 80
_MIN_LINE_CHARS = 25
_MAX_LINE_CHARS = 400
_HEADING_MAX_CHARS = 80
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?;])\s+(?=[A-Z])")
_BULLET_STRIP = " \t-*\u2022\u25cf\u25aa"
_RESP_HEADING_RE = re.compile(
    r"responsibilit|what you.?ll do|the role|your impact|day to day|in this role|you will", re.I
)
_ABOUT_HEADING_RE = re.compile(
    r"about (us|the company|the team)|who we are|our mission|why join|benefits|perks", re.I
)
# Legal, benefits and application boilerplate says nothing about the work and
# would only dilute the posting's average similarity.
BOILERPLATE_RE = re.compile(
    r"equal opportunity|\beeo\b|without regard to|disabilit|veteran|accommodation|benefits|401\(?k|\bpto\b|"
    r"paid time off|health insurance|dental|vision insurance|parental leave|salary range|compensation|base pay|"
    r"pay range|cookie|privacy policy|e-verify|background check|apply now|apply for this|recruiting scam|phishing",
    re.I,
)
_YEARS_RE = re.compile(r"\b\d+\+?\s*(years|yrs)", re.I)
_SOFT_CUE_RE = re.compile(r"prefer|bonus|plus|nice to have|ideally", re.I)
_SKILL_CUE_RE = re.compile(r"experience|proficien|knowledge|degree|ability|familiar|expertise", re.I)

SECTIONS = ("none", "required", "preferred", "resp", "about")
COVERAGE_THRESHOLDS = (0.45, 0.55, 0.65)
# Lines below this requirement weight are not stored; they carry no weight in
# the coverage features and would only cost storage.
MIN_STORED_WEIGHT = 0.15
# A requirement is "met" for explanations when its best profile line clears this.
EVIDENCE_MIN_SIM = 0.55


def posting_lines(body: str | None) -> list[tuple[str, str]]:
    """(line, section) for every substantive line, headings consumed as section markers."""
    out: list[tuple[str, str]] = []
    section = "none"
    for raw in (body or "").splitlines():
        line = raw.strip(_BULLET_STRIP)
        if not line:
            continue
        parts = _SENTENCE_SPLIT_RE.split(line) if len(line) > 300 else [line]
        for part in parts:
            part = part.strip()
            if len(part) < _MIN_LINE_CHARS:
                continue
            part = part[:_MAX_LINE_CHARS]
            if len(part) < _HEADING_MAX_CHARS:
                if REQUIRED_HEADING_RE.search(part):
                    section = "required"
                    continue
                if PREFERRED_HEADING_RE.search(part):
                    section = "preferred"
                    continue
                if _RESP_HEADING_RE.search(part):
                    section = "resp"
                    continue
                if _ABOUT_HEADING_RE.search(part):
                    section = "about"
                    continue
            if BOILERPLATE_RE.search(part):
                continue
            out.append((part, section))
            if len(out) >= _MAX_LINES:
                return out
    return out


def line_cues(section: str, pos: int, n: int, line: str) -> list[float]:
    cues = [float(section == s) for s in SECTIONS]
    cues += [
        pos / max(n - 1, 1),
        min(len(line), 400) / 400,
        float(bool(_YEARS_RE.search(line))),
        float(bool(_SOFT_CUE_RE.search(line))),
        float(bool(_SKILL_CUE_RE.search(line))),
    ]
    return cues


def line_features(lines: list[tuple[str, str]], vecs: np.ndarray) -> np.ndarray:
    """Classifier input: line embedding followed by section / position cues."""
    n = len(lines)
    cues = np.array([line_cues(s, i, n, t) for i, (t, s) in enumerate(lines)], dtype=np.float32)
    return np.hstack([np.asarray(vecs, dtype=np.float32), cues])


@lru_cache(maxsize=1)
def _classifier() -> tuple[np.ndarray, np.ndarray, list[str]] | None:
    path = MODEL_DIR / "req_lines.json"
    if not path.exists():
        return None
    data = json.loads(path.read_text())
    return np.asarray(data["coef"], np.float32), np.asarray(data["intercept"], np.float32), list(data["classes"])


def classifier_available() -> bool:
    return _classifier() is not None


def classify_lines(lines: list[tuple[str, str]], vecs: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(p_must, p_nice) per line. Falls back to the section heading when no model is shipped."""
    n = len(lines)
    if n == 0:
        return np.zeros(0, np.float32), np.zeros(0, np.float32)
    clf = _classifier()
    if clf is None:
        must = np.array([float(s == "required") for _, s in lines], np.float32)
        nice = np.array([float(s == "preferred") for _, s in lines], np.float32)
        return must, nice
    coef, intercept, classes = clf
    logits = line_features(lines, vecs) @ coef.T + intercept
    logits -= logits.max(axis=1, keepdims=True)
    probs = np.exp(logits)
    probs /= probs.sum(axis=1, keepdims=True)
    return probs[:, classes.index("must")], probs[:, classes.index("nice")]


def stored_requirements(
    lines: list[tuple[str, str]], vecs: np.ndarray, p_must: np.ndarray, p_nice: np.ndarray
) -> tuple[list[dict], np.ndarray | None]:
    """JobEncoding.req_lines payload and the matching vector matrix."""
    keep = [i for i in range(len(lines)) if p_must[i] + p_nice[i] >= MIN_STORED_WEIGHT]
    payload = [
        {"t": lines[i][0], "m": round(float(p_must[i]), 4), "n": round(float(p_nice[i]), 4)}
        for i in keep
    ]
    mat = np.asarray(vecs, np.float32)[keep] if keep else None
    return payload, mat


# ── Compact cross-encoder inputs ───────────────────────────────────────────

JOB_CE_CHARS = 2200
PROFILE_CE_CHARS = 2200


def job_ce_text(title: str | None, lines: list[tuple[str, str]], p_must: np.ndarray, p_nice: np.ndarray) -> str:
    """Title, then hard requirements, nice-to-haves and the rest, most informative first."""
    must = [lines[i][0] for i in range(len(lines)) if p_must[i] >= 0.5]
    nice = [lines[i][0] for i in range(len(lines)) if p_must[i] < 0.5 and p_nice[i] >= 0.5]
    rest = [lines[i][0] for i in range(len(lines)) if p_must[i] < 0.5 and p_nice[i] < 0.5]
    parts = [f"Job title: {(title or '').strip() or 'unknown'}"]
    if must:
        parts.append("Requirements: " + " | ".join(must))
    if nice:
        parts.append("Nice to have: " + " | ".join(nice))
    if rest:
        parts.append("About the role: " + " | ".join(rest))
    return "\n".join(parts)[:JOB_CE_CHARS]


def profile_ce_text(
    *,
    prefs_text: str | None,
    profile_title: str | None,
    profile_summary: str | None,
    years_experience: float | None,
    work_experience: list | None,
    education: list | None,
    technical_skills,
) -> str:
    """Preferences, headline, then roles newest first; truncation drops the oldest detail."""
    parts = [f"Candidate preferences: {(prefs_text or '').strip() or 'none'}"]
    head = (profile_title or "").strip()
    if years_experience:
        head = f"{head} ({years_experience:g} years)" if head else f"{years_experience:g} years of experience"
    if head:
        parts.append(f"Headline: {head}")
    if technical_skills:
        if isinstance(technical_skills, str):
            skills = technical_skills
        else:
            skills = "; ".join(
                f"{s.get('category', '')}: {s.get('skills', '')}" if isinstance(s, dict) else str(s)
                for s in technical_skills
            )
        parts.append(f"Skills: {skills[:500]}")
    for idx, entry in enumerate(work_experience or []):
        if not isinstance(entry, dict):
            continue
        role = ", ".join(
            str(entry.get(k) or "").strip()
            for k in ("job_title", "company_name", "industry")
            if str(entry.get(k) or "").strip()
        )
        period = " - ".join(
            str(entry.get(k) or "").strip() for k in ("period_start", "period_end") if str(entry.get(k) or "").strip()
        )
        detail = [str(entry.get(k) or "").strip() for k in ("project_intro", "description")]
        detail += [str(c).strip() for c in entry.get("contributions") or []]
        detail = [d for d in detail if d][: 4 if idx < 2 else 1]
        parts.append(f"Role: {role}" + (f" ({period})" if period else "") + (": " + " | ".join(detail) if detail else ""))
    for entry in education or []:
        if isinstance(entry, dict):
            edu = ", ".join(
                str(entry.get(k) or "").strip()
                for k in ("degree", "field_of_study", "school", "institution")
                if str(entry.get(k) or "").strip()
            )
            if edu:
                parts.append(f"Education: {edu}")
    if (profile_summary or "").strip():
        parts.append(f"Summary: {str(profile_summary).strip()[:600]}")
    return "\n".join(parts)[:PROFILE_CE_CHARS]


# ── Pair features and evidence ─────────────────────────────────────────────

FEATURE_NAMES = (
    [f"rq_{k}_{s}" for k in ("must", "nice", "req") for s in ("n", "mean", *[f"cov{int(t * 100)}" for t in COVERAGE_THRESHOLDS])]
    + ["rq_must_min", "rq_must_p25", "rq_lines", "rq_years_lines"]
)


def requirement_features(
    req_lines: list[dict] | None, req_mat: np.ndarray | None, profile_mat: np.ndarray | None
) -> tuple[dict[str, float], np.ndarray | None]:
    """(rq_* features, best profile similarity per stored requirement)."""
    nan = float("nan")
    feats = {name: nan for name in FEATURE_NAMES}
    reqs = req_lines or []
    feats["rq_lines"] = float(len(reqs))
    if not reqs or req_mat is None or profile_mat is None or len(req_mat) != len(reqs) or not len(profile_mat):
        return feats, None
    best = (req_mat.astype(np.float32) @ profile_mat.astype(np.float32).T).max(axis=1)
    pm = np.array([r["m"] for r in reqs], np.float32)
    pn = np.array([r["n"] for r in reqs], np.float32)
    for name, w in (("must", pm), ("nice", pn), ("req", pm + pn)):
        sw = float(w.sum())
        feats[f"rq_{name}_n"] = sw
        if sw > 0.3:
            feats[f"rq_{name}_mean"] = float((w * best).sum() / sw)
            for th in COVERAGE_THRESHOLDS:
                feats[f"rq_{name}_cov{int(th * 100)}"] = float((w * (best >= th)).sum() / sw)
    hard = pm > 0.5
    if hard.any():
        feats["rq_must_min"] = float(best[hard].min())
        feats["rq_must_p25"] = float(np.percentile(best[hard], 25))
    feats["rq_years_lines"] = float(sum(1 for r, h in zip(reqs, hard) if h and _YEARS_RE.search(r["t"])))
    return feats, best


def requirement_evidence(
    req_lines: list[dict] | None,
    best: np.ndarray | None,
    req_mat: np.ndarray | None,
    profile_mat: np.ndarray | None,
    profile_texts: list[str] | None,
    *,
    limit: int = 4,
) -> dict:
    """Hard requirements the profile covers (with the line that covers it) and the ones it misses."""
    if not req_lines or best is None:
        return {"met": [], "unmet": [], "must_total": 0, "must_met": 0}
    order = [i for i in np.argsort(-np.array([r["m"] for r in req_lines])) if req_lines[i]["m"] >= 0.5]
    met, unmet = [], []
    sims = None
    if profile_texts and req_mat is not None and profile_mat is not None and len(profile_texts) == len(profile_mat):
        sims = req_mat.astype(np.float32) @ profile_mat.astype(np.float32).T
    must_met = 0
    for i in order:
        text = req_lines[i]["t"]
        if best[i] >= EVIDENCE_MIN_SIM:
            must_met += 1
            if len(met) < limit:
                item = {"requirement": text, "similarity": round(float(best[i]), 3)}
                if sims is not None:
                    item["evidence"] = profile_texts[int(sims[i].argmax())]
                met.append(item)
        elif len(unmet) < limit:
            unmet.append({"requirement": text, "similarity": round(float(best[i]), 3)})
    return {"met": met, "unmet": unmet, "must_total": len(order), "must_met": must_met}
