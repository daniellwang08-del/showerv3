"""Unit tests for the non-LLM vector match engine building blocks.

No DB or embedding model required: encodings are constructed in memory and
scoring is pure math.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.models.database import JobEncoding, UserEncoding
from app.prompts.job_match_phase_a_prompt import MATCH_DIMENSION_WEIGHTS
from app.services.encoding_service import (
    _years_from_experience,
    bytes_to_vec,
    extract_degree_required,
    extract_years_required,
    vec_to_b64,
    vec_to_bytes,
)
from app.services.security_clearance_detector import requires_security_clearance
from app.services.skill_lexicon import (
    extract_skills,
    extract_skills_with_importance,
    skill_category,
)
from app.services.vector_match_service import (
    _cos_to_score,
    _recommendation,
    _score_skills,
    encoding_fingerprint,
    score_pair,
)

# ── Security clearance gate ─────────────────────────────────────────────────


@pytest.mark.parametrize(
    "text,expected",
    [
        ("Must hold an active TS/SCI clearance with polygraph", True),
        ("Active Secret clearance required at time of hire", True),
        ("Candidates must be eligible to obtain a Top Secret clearance", True),
        ("Ability to obtain and maintain a DoD clearance", True),
        ("No security clearance required for this position", False),
        ("A security clearance is not required", False),
        ("We build monitoring tools for security teams", False),
        ("Standard background check applies", False),
        ("", False),
    ],
)
def test_clearance_detector(text: str, expected: bool):
    required, phrase = requires_security_clearance(text)
    assert required is expected
    if expected:
        assert phrase


# ── Skill lexicon ───────────────────────────────────────────────────────────


def test_extract_skills_aliases_and_normalization():
    text = (
        "Stack: Python 3, React.js, PostgreSQL, k8s, CI/CD, AWS (EC2/S3). "
        "Golang and Node JS are a plus. We practice TDD."
    )
    skills = extract_skills(text)
    assert {"python", "react", "postgresql", "kubernetes", "ci/cd", "aws",
            "ec2", "s3", "go", "node.js", "unit testing"} <= skills


def test_ambiguous_words_do_not_match_bare():
    # "go" as a verb and bare "r" must not produce skills.
    skills = extract_skills("We go fast and value R&D speed.")
    assert "go" not in skills
    assert "r" not in skills


def test_extract_skills_with_importance_sections():
    text = (
        "About the role\n"
        "You will build services.\n"
        "Requirements:\n"
        "- 5+ years Python\n"
        "- Kubernetes in production\n"
        "Nice to have:\n"
        "- Terraform\n"
    )
    ranked = extract_skills_with_importance(text)
    assert ranked["python"] == "required"
    assert ranked["kubernetes"] == "required"
    assert ranked["terraform"] == "preferred"


def test_skill_category_lookup():
    assert skill_category("python") == "language"
    assert skill_category("kubernetes") == "devops"
    assert skill_category("not-a-skill") == "other"


# ── Deterministic JD signals ────────────────────────────────────────────────


def test_extract_years_required():
    assert extract_years_required("Minimum of 7 years of software experience") == 7
    assert extract_years_required("3+ yrs experience with Java") == 3
    assert (
        extract_years_required("5+ years of backend experience; 8+ years engineering experience")
        == 8
    )
    assert extract_years_required("We were founded 20 years ago") is None
    assert extract_years_required(None) is None


def test_extract_degree_required():
    assert extract_degree_required("Bachelor's degree in Computer Science required") is True
    assert extract_degree_required("BS in CS or equivalent experience") is False
    assert extract_degree_required("Great snacks and coffee") is None


def test_years_from_experience_merges_overlaps():
    entries = [
        {"period_start": "Jan 2020", "period_end": "Present"},
        {"period_start": "2018", "period_end": "2021"},  # overlaps the above
        {"period_start": "2010", "period_end": "2012"},
    ]
    years = _years_from_experience(entries)
    assert years is not None
    # 2018..now merged with 2020..now, plus 2010-2012 = ~(now-2018) + 2
    assert years >= 8


# ── Vector serialization round-trip ─────────────────────────────────────────


def test_vec_bytes_roundtrip():
    vec = np.random.default_rng(42).random(384).astype(np.float32)
    assert np.allclose(bytes_to_vec(vec_to_bytes(vec)), vec)
    from app.services.encoding_service import b64_to_vec

    assert np.allclose(b64_to_vec(vec_to_b64(vec)), vec)


# ── Scoring primitives ──────────────────────────────────────────────────────


def test_cos_to_score_monotonic():
    points = ((0.1, 10), (0.4, 50), (0.7, 90))
    scores = [_cos_to_score(c, points) for c in (-0.2, 0.1, 0.25, 0.4, 0.55, 0.7, 0.9)]
    assert scores == sorted(scores)
    assert scores[0] == 10
    assert scores[-1] == 90
    assert _cos_to_score(None, points) == 50


def test_recommendation_thresholds_match_phase_a():
    assert _recommendation(85) == "strong_match"
    assert _recommendation(80) == "strong_match"
    assert _recommendation(70) == "good_match"
    assert _recommendation(55) == "moderate_match"
    assert _recommendation(40) == "weak_match"
    assert _recommendation(10) == "poor_match"


def test_build_prefs_proxy_always_nonempty():
    from app.services.encoding_service import build_prefs_proxy_text

    text = build_prefs_proxy_text(
        explicit_prefs=None,
        guidance=None,
        work_experience=[{"job_title": "Staff Engineer", "company_name": "Acme"}],
        country_preferences=["US", "CA"],
    )
    assert "US" in text and "Staff Engineer" in text
    assert "remote" in text.lower()


def test_score_skills_required_vs_preferred():
    job_skills = {"python": "required", "kubernetes": "required", "terraform": "preferred"}
    full_match, matched, missing = _score_skills(
        job_skills, {"python": 1.0, "kubernetes": 1.0, "terraform": 1.0}
    )
    assert full_match == 100
    assert set(matched) == {"python", "kubernetes", "terraform"}
    assert missing == []

    partial, matched, missing = _score_skills(job_skills, {"python": 1.0})
    assert 0 < partial < full_match
    assert "kubernetes" in missing  # required and absent
    assert "terraform" not in missing  # preferred is never a "missing required"


def test_score_skills_same_category_partial_credit():
    # User knows MySQL but not PostgreSQL: same 'database' category → partial credit.
    with_neighbor, _, missing_with = _score_skills(
        {"postgresql": "required"}, {"mysql": 1.0}
    )
    without, _, missing_without = _score_skills({"postgresql": "required"}, {"figma-like": 1.0})
    assert with_neighbor > without
    # Score credit for the adjacent skill, but it is still reported as a gap.
    assert "postgresql" in missing_with
    assert "postgresql" in missing_without


def test_score_skills_empty_job_skills_neutral():
    score, matched, missing = _score_skills({}, {"python": 1.0})
    assert score == 50 and matched == [] and missing == []


# ── Full pair scoring ───────────────────────────────────────────────────────


def _unit(vec: np.ndarray) -> np.ndarray:
    return (vec / np.linalg.norm(vec)).astype(np.float32)


def _make_pair(
    *,
    clearance: bool = False,
    job_skills: dict | None = None,
    user_skills: dict | None = None,
    similar: bool = True,
    years_required: int | None = None,
    years_experience: float | None = None,
    degree_required: bool | None = None,
    has_degree: bool | None = True,
) -> tuple[JobEncoding, UserEncoding]:
    rng = np.random.default_rng(7)
    base = _unit(rng.random(384))
    if similar:
        user_vec = _unit(base + 0.05 * rng.random(384))
    else:
        other = _unit(rng.random(384) - 0.5)
        # Orthogonalize against base for a near-zero cosine.
        user_vec = _unit(other - np.dot(other, base) * base)

    job = JobEncoding(
        job_id="job-1",
        model_version="test-model",
        title_vec=vec_to_bytes(base),
        content_vec=vec_to_bytes(base),
        skills=job_skills if job_skills is not None else {"python": "required"},
        years_required=years_required,
        degree_required=degree_required,
        requires_security_clearance=clearance,
    )
    user = UserEncoding(
        user_id="user-1",
        model_version="test-model",
        experience_vec=vec_to_bytes(user_vec),
        prefs_vec=None,
        title_vecs=[{"title": "Software Engineer", "vec": vec_to_b64(user_vec)}],
        skills=user_skills if user_skills is not None else {"python": 1.0},
        years_experience=years_experience,
        has_degree=has_degree,
    )
    return job, user


def test_score_pair_shape_matches_phase_a_contract():
    job, user = _make_pair()
    result = score_pair(job, user)
    assert set(result) == {
        "overall_score",
        "dimension_scores",
        "summary",
        "strengths",
        "gaps",
        "recommendation",
        "requires_security_clearance",
        # Provenance, so the score can be re-derived and drift is detectable.
        "scorer_version",
        "model_version",
        "inputs_fingerprint",
    }
    assert set(result["dimension_scores"]) == set(MATCH_DIMENSION_WEIGHTS)
    assert 0 <= result["overall_score"] <= 100
    assert all(0 <= v <= 100 for v in result["dimension_scores"].values())
    assert result["recommendation"] in (
        "strong_match", "good_match", "moderate_match", "weak_match", "poor_match"
    )
    # Overall must be the weighted recompute of dimensions (Phase A parity).
    expected = round(
        sum(
            result["dimension_scores"][k] * w
            for k, w in MATCH_DIMENSION_WEIGHTS.items()
        )
    )
    assert result["overall_score"] == expected


def test_fingerprint_is_stable_for_unchanged_encodings():
    job, user = _make_pair()
    assert encoding_fingerprint(job, user) == encoding_fingerprint(job, user)
    assert score_pair(job, user)["inputs_fingerprint"] == encoding_fingerprint(job, user)


@pytest.mark.parametrize(
    "mutate",
    [
        pytest.param(
            lambda job, user: setattr(job, "title_vec", vec_to_bytes(_unit(np.arange(384.0)))),
            id="job_title_vec",
        ),
        pytest.param(
            lambda job, user: setattr(job, "skills", {"rust": "required"}),
            id="job_skills",
        ),
        pytest.param(
            lambda job, user: setattr(job, "years_required", 9),
            id="job_years",
        ),
        pytest.param(
            lambda job, user: setattr(user, "skills", {"python": 0.2}),
            id="user_skills",
        ),
        pytest.param(
            lambda job, user: setattr(user, "has_degree", False),
            id="user_degree",
        ),
    ],
)
def test_fingerprint_changes_when_any_scored_input_changes(mutate):
    """Drift must be visible: any input the scorer reads moves the fingerprint.

    This is what lets a later re-score tell "the encodings changed" apart from
    "the scorer changed".
    """
    job, user = _make_pair()
    before = encoding_fingerprint(job, user)
    mutate(job, user)
    assert encoding_fingerprint(job, user) != before


def test_clearance_gated_result_still_carries_provenance():
    job, user = _make_pair(clearance=True)
    result = score_pair(job, user)
    assert result["overall_score"] == 0
    assert result["scorer_version"]
    assert result["inputs_fingerprint"]


def test_score_pair_explain_includes_cosines_and_contributions():
    job, user = _make_pair(similar=True, years_required=5, years_experience=6.0)
    result = score_pair(job, user, explain=True)
    explain = result["explain"]
    assert "cosines" in explain
    assert explain["cosines"]["experience_to_content"] is not None
    assert explain["skills"]["matched"] == ["python"]
    contrib = explain["dimension_contributions"]
    assert set(contrib) == set(MATCH_DIMENSION_WEIGHTS)
    assert abs(
        sum(c["weighted"] for c in contrib.values()) - result["overall_score"]
    ) < 1.0
    assert explain["signals"]["years_required"] == 5
    assert explain["signals"]["years_experience"] == 6.0
    assert "calibration" in explain


def test_score_pair_clearance_zeroes_everything():
    job, user = _make_pair(clearance=True)
    result = score_pair(job, user)
    assert result["overall_score"] == 0
    assert result["requires_security_clearance"] is True
    assert result["recommendation"] == "poor_match"
    assert result["summary"] == "Requires security clearance - not scored"
    assert all(v == 0 for v in result["dimension_scores"].values())


def test_score_pair_similar_beats_dissimilar():
    job_hi, user_hi = _make_pair(similar=True)
    job_lo, user_lo = _make_pair(similar=False, user_skills={})
    hi = score_pair(job_hi, user_hi)
    lo = score_pair(job_lo, user_lo)
    assert hi["overall_score"] > lo["overall_score"]
    assert (
        hi["dimension_scores"]["experience_match"]
        > lo["dimension_scores"]["experience_match"]
    )
    assert (
        hi["dimension_scores"]["job_title_similarity"]
        > lo["dimension_scores"]["job_title_similarity"]
    )


def test_score_pair_years_shortfall_discounts_and_reports_gap():
    job_ok, user_ok = _make_pair(years_required=5, years_experience=8.0)
    job_short, user_short = _make_pair(years_required=10, years_experience=2.0)
    ok = score_pair(job_ok, user_ok)
    short = score_pair(job_short, user_short)
    assert (
        ok["dimension_scores"]["experience_match"]
        > short["dimension_scores"]["experience_match"]
    )
    assert any("10+ years" in gap for gap in short["gaps"])


def test_score_pair_education_rule():
    job_req, user_no_degree = _make_pair(degree_required=True, has_degree=False)
    no_degree = score_pair(job_req, user_no_degree)
    job_req2, user_degree = _make_pair(degree_required=True, has_degree=True)
    with_degree = score_pair(job_req2, user_degree)
    job_none, user_none = _make_pair(degree_required=None, has_degree=False)
    not_required = score_pair(job_none, user_none)
    assert with_degree["dimension_scores"]["education"] == 90
    assert no_degree["dimension_scores"]["education"] == 30
    assert not_required["dimension_scores"]["education"] == 75


def test_score_pair_missing_required_skills_reported():
    job, user = _make_pair(
        job_skills={"python": "required", "kubernetes": "required", "rust": "required"},
        user_skills={"python": 1.0},
    )
    result = score_pair(job, user)
    joined = " ".join(result["gaps"])
    assert "kubernetes" in joined and "rust" in joined
