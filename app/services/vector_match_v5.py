"""Scorer v5: learned dimension models on top of the v4 vector features.

The v4 scorer (``vector_match_service``) still decides the gates and computes
its role, title, skill, seniority and line-similarity features. v5 adds how
well the profile covers each requirement line (``requirement_lines``) and
replaces the six hand-fitted linear models with gradient-boosted trees fitted
to reference judgements from a stronger LLM on several thousand pairs, plus a
tree model that flags pages that are not real job postings.

When a cross-encoder score for the pair is supplied (``cross_encoder``), the
dimension scores are a fixed blend of both models. No LLM is called, ever.

Trees ship as flat numpy arrays (``match_models/scorer_v5.npz``) and are
evaluated with vectorised numpy, so scoring needs neither scikit-learn nor a
GPU and takes well under a millisecond per pair.
"""

from __future__ import annotations

import json
import math
from functools import lru_cache

import numpy as np

from app.core.logging import get_logger
from app.models.database import JobEncoding, UserEncoding
from app.prompts.job_match_phase_a_prompt import MATCH_DIMENSION_WEIGHTS
from app.services.encoding_service import bytes_to_matrix
from app.services.requirement_lines import (
    FEATURE_NAMES as REQ_FEATURE_NAMES,
    MODEL_DIR,
    requirement_evidence,
    requirement_features,
)

logger = get_logger(__name__)

SCORER_VERSION = "minilm-v5-requirements"
DIMENSIONS = tuple(MATCH_DIMENSION_WEIGHTS)
FAMILIES = (
    "software", "sales", "marketing", "other", "data", "product", "solutions", "customer", "finance",
    "eng_management", "design", "security", "operations", "legal", "people", "tech_support", "program", "hardware",
)
_NO_PREFERENCES_SCORE = 50.0


def _num(value) -> float:
    return float("nan") if value is None else float(value)


def pair_vector(explain: dict, req_feats: dict[str, float], v4_dims: dict, base_feature_names: list[str]) -> np.ndarray:
    """Model input for one non-gated pair; the column order is fixed by the artifact."""
    f = explain.get("features") or {}
    roles = explain.get("roles") or {}
    sig = explain.get("signals") or {}
    sk = explain.get("skills") or {}
    cos = explain.get("cosines") or {}
    x = [float(f.get(k) or 0.0) for k in base_feature_names]
    jl, ul = roles.get("job_level"), roles.get("user_level")
    yr, ye = sig.get("years_required"), sig.get("years_experience")
    jsc, usc = sk.get("job_skill_count") or 0, sk.get("user_skill_count") or 0
    matched, missing = len(sk.get("matched") or []), len(sk.get("missing_required") or [])
    job_family = roles.get("job_family")
    user_family = (roles.get("user_families") or ["other"])[0]
    x += [
        _num(jl), _num(ul), (jl - ul) if jl is not None and ul is not None else float("nan"),
        _num(yr), _num(ye), (ye - yr) if yr is not None and ye is not None else float("nan"),
        float(bool(sig.get("degree_required"))), float(bool(sig.get("has_degree"))),
        float(bool(sig.get("has_preferences"))),
        float(jsc), float(usc), float(matched), float(missing), matched / max(jsc, 1),
        _num(cos.get("prefs_to_content")), float(job_family == user_family),
    ]
    x += [float(job_family == fam) for fam in FAMILIES]
    x += [float(user_family == fam) for fam in FAMILIES]
    x += [float(v4_dims[d]) for d in DIMENSIONS]
    x += [req_feats.get(k, float("nan")) for k in REQ_FEATURE_NAMES]
    return np.asarray(x, dtype=np.float64)


def vector_names(base_feature_names: list[str]) -> list[str]:
    return (
        list(base_feature_names)
        + ["job_level", "user_level", "level_diff", "years_req", "years_exp", "years_gap", "deg_req", "has_deg",
           "has_prefs", "job_skills", "user_skills", "matched", "missing", "matched_ratio", "prefs_cos", "same_family"]
        + [f"job_fam_{f}" for f in FAMILIES]
        + [f"user_fam_{f}" for f in FAMILIES]
        + [f"v4_{d}" for d in DIMENSIONS]
        + list(REQ_FEATURE_NAMES)
    )


class TreeEnsemble:
    """Sum of regression trees stored as flat node arrays (scikit-learn HistGradientBoosting layout)."""

    def __init__(self, prefix: str, data) -> None:
        self.feature = data[f"{prefix}_feature"].astype(np.int64)
        self.threshold = data[f"{prefix}_threshold"].astype(np.float64)
        self.left = data[f"{prefix}_left"].astype(np.int64)
        self.right = data[f"{prefix}_right"].astype(np.int64)
        self.missing_left = data[f"{prefix}_missing_left"].astype(bool)
        self.is_leaf = data[f"{prefix}_is_leaf"].astype(bool)
        self.value = data[f"{prefix}_value"].astype(np.float64)
        self.roots = data[f"{prefix}_roots"].astype(np.int64)
        self.baseline = float(data[f"{prefix}_baseline"])
        self.max_depth = int(data[f"{prefix}_max_depth"])

    def raw(self, X: np.ndarray) -> np.ndarray:
        X = np.atleast_2d(X)
        idx = np.broadcast_to(self.roots, (X.shape[0], self.roots.size)).copy()
        rows = np.arange(X.shape[0])[:, None]
        for _ in range(self.max_depth + 1):
            leaf = self.is_leaf[idx]
            if leaf.all():
                break
            v = X[rows, self.feature[idx]]
            go_left = np.where(np.isnan(v), self.missing_left[idx], v <= self.threshold[idx])
            idx = np.where(leaf, idx, np.where(go_left, self.left[idx], self.right[idx]))
        return self.baseline + self.value[idx].sum(axis=1)


class ForestBank:
    """All ensembles merged into one node table, walked in a single pass per pair."""

    def __init__(self, models: dict[str, TreeEnsemble]) -> None:
        self.names = list(models)
        parts = {k: [] for k in ("feature", "threshold", "left", "right", "missing_left", "is_leaf", "value", "roots")}
        starts, offset, depth = [], 0, 0
        n_trees = 0
        self.baselines = np.array([m.baseline for m in models.values()])
        for m in models.values():
            parts["feature"].append(m.feature)
            parts["threshold"].append(m.threshold)
            internal = ~m.is_leaf
            parts["left"].append(np.where(internal, m.left + offset, 0))
            parts["right"].append(np.where(internal, m.right + offset, 0))
            parts["missing_left"].append(m.missing_left)
            parts["is_leaf"].append(m.is_leaf)
            parts["value"].append(m.value)
            parts["roots"].append(m.roots + offset)
            starts.append(n_trees)
            n_trees += m.roots.size
            offset += m.feature.size
            depth = max(depth, m.max_depth)
        for key, arrays in parts.items():
            setattr(self, key, np.concatenate(arrays))
        self.starts = np.array(starts)
        self.max_depth = depth

    def raw(self, x: np.ndarray) -> dict[str, float]:
        idx = self.roots.copy()
        for _ in range(self.max_depth + 1):
            leaf = self.is_leaf[idx]
            if leaf.all():
                break
            v = x[self.feature[idx]]
            go_left = np.where(np.isnan(v), self.missing_left[idx], v <= self.threshold[idx])
            idx = np.where(leaf, idx, np.where(go_left, self.left[idx], self.right[idx]))
        sums = np.add.reduceat(self.value[idx], self.starts) + self.baselines
        return dict(zip(self.names, sums.tolist()))


@lru_cache(maxsize=1)
def _artifact() -> dict | None:
    path = MODEL_DIR / "scorer_v5.npz"
    meta_path = MODEL_DIR / "scorer_v5.json"
    if not path.exists() or not meta_path.exists():
        return None
    meta = json.loads(meta_path.read_text())
    with np.load(path) as data:
        models = {name: TreeEnsemble(name, data) for name in [*DIMENSIONS, "posting"]}
    return {"meta": meta, "models": models, "bank": ForestBank(models)}


def scorer_available() -> bool:
    return _artifact() is not None


def blend_weight() -> float:
    """Share of the tree models in the tree / cross-encoder blend."""
    art = _artifact()
    return float(art["meta"].get("blend_tree_weight", 1.0)) if art else 1.0


def cascade_threshold() -> float:
    """Pairs the trees score below this overall skip the cross-encoder."""
    art = _artifact()
    return float(art["meta"].get("cascade_min_overall", 0.0)) if art else 0.0


def _overall(dims: dict[str, float]) -> float:
    return sum(dims[d] * MATCH_DIMENSION_WEIGHTS[d] for d in DIMENSIONS) / sum(MATCH_DIMENSION_WEIGHTS.values())


def tree_scores(job_enc: JobEncoding, user_enc: UserEncoding, v4: dict) -> dict | None:
    """Tree-model dimension scores, posting probability and requirement evidence for a non-gated pair."""
    art = _artifact()
    if art is None:
        return None
    explain = v4["explain"]
    dim = len(np.frombuffer(job_enc.content_vec, dtype=np.float32)) if job_enc.content_vec else 0
    req_lines = getattr(job_enc, "req_lines", None) or []
    req_mat = bytes_to_matrix(getattr(job_enc, "req_vecs", None), dim)
    profile_mat = bytes_to_matrix(user_enc.chunk_vecs, dim)
    req_feats, best = requirement_features(req_lines, req_mat, profile_mat)
    names = art["meta"]["base_features"]
    x = pair_vector(explain, req_feats, v4["dimension_scores"], names)
    raw = art["bank"].raw(x)
    dims = {d: float(np.clip(raw[d], 0.0, 100.0)) for d in DIMENSIONS}
    has_prefs = bool((explain.get("signals") or {}).get("has_preferences"))
    if not has_prefs:
        dims["user_preferences"] = _NO_PREFERENCES_SCORE
    posting_logit = float(raw["posting"])
    evidence = requirement_evidence(
        req_lines, best, req_mat, profile_mat, getattr(user_enc, "chunk_texts", None)
    )
    return {
        "dims": dims,
        "posting_prob": 1.0 / (1.0 + math.exp(-posting_logit)),
        "has_prefs": has_prefs,
        "overall": _overall(dims),
        "req_features": req_feats,
        "evidence": evidence,
    }


def blend(trees: dict, ce: dict | None) -> tuple[dict[str, float], float]:
    """(dimension scores, posting probability) after the optional cross-encoder blend."""
    if ce is None:
        return trees["dims"], trees["posting_prob"]
    w = blend_weight()
    dims = {d: w * trees["dims"][d] + (1.0 - w) * ce["dims"][d] for d in DIMENSIONS}
    if not trees["has_prefs"]:
        dims["user_preferences"] = _NO_PREFERENCES_SCORE
    return dims, w * trees["posting_prob"] + (1.0 - w) * ce["posting_prob"]
