"""MiniLM span-rank metadata extraction (mocked embeddings — no torch needed)."""

from __future__ import annotations

import numpy as np
import pytest

from app.services import metadata_vector_extractor as mve


_GH_UPBOUND = (
    "Job Application for Senior Software Engineer [REMOTE] at Upbound - Job Posting"
    "Senior Software Engineer [REMOTE]San Francisco, California, United States"
    "Upbound is redefining how modern infrastructure is built for the Agentic AI Era."
)


def _unit(v: list[float]) -> np.ndarray:
    a = np.asarray(v, dtype=np.float32)
    n = float(np.linalg.norm(a)) or 1.0
    return a / n


@pytest.fixture(autouse=True)
def _reset_proto_cache():
    mve._proto_cache = None
    yield
    mve._proto_cache = None


def test_generate_span_candidates_includes_role_windows():
    cands = mve.generate_span_candidates(_GH_UPBOUND)
    joined = " | ".join(cands).lower()
    assert "senior software engineer" in joined
    assert any("upbound" in c.lower() for c in cands)


def test_board_slug_from_greenhouse_embed_url():
    url = (
        "https://job-boards.greenhouse.io/embed/job_app"
        "?for=upboundext&token=5695708004"
    )
    assert mve._board_slug_candidate(url) == "Upboundext"


def test_extract_title_company_ml_ranks_with_mock_embeddings(monkeypatch):
    # 3-d space: axis0=title-ish, axis1=company-ish, axis2=noise-ish
    title_axis = _unit([1.0, 0.0, 0.0])
    company_axis = _unit([0.0, 1.0, 0.0])
    noise_axis = _unit([0.0, 0.0, 1.0])

    def fake_encode(texts):
        out = []
        for t in texts:
            low = t.lower()
            if "job title" in low or "role name" in low or "position:" in low or "hiring for" in low or "looking for" in low:
                out.append(title_axis)
            elif "employer company" in low or "company name" in low or "position is at" in low or "organization:" in low or "join our team" in low:
                out.append(company_axis)
            elif "job alert" in low or "first name" in low or "skip to main" in low or "refresh the page" in low or "location only" in low:
                out.append(noise_axis)
            elif "senior software engineer" in low and "upbound" not in low:
                out.append(_unit([0.95, 0.05, 0.05]))
            elif low.strip() in {"upbound", "upboundext"} or (
                "upbound" in low and "engineer" not in low and len(t) < 40
            ):
                out.append(_unit([0.05, 0.95, 0.05]))
            elif "create a job alert" in low or "job application for" in low:
                out.append(_unit([0.1, 0.1, 0.9]))
            else:
                out.append(_unit([0.2, 0.2, 0.6]))
        return np.stack(out, axis=0)

    monkeypatch.setattr(
        "app.services.encoding_service.encode_texts",
        fake_encode,
    )

    result = mve.extract_title_company_ml(
        _GH_UPBOUND,
        source_url=(
            "https://job-boards.greenhouse.io/embed/job_app"
            "?for=upbound&token=5695708004"
        ),
    )
    assert result["title"] is not None
    assert "Senior Software Engineer" in result["title"]
    assert result["company"] is not None
    assert "Upbound" in result["company"]
    assert result["explain"]["source"] == "minilm_span_rank"


def test_extract_skips_when_already_filled(monkeypatch):
    called = {"n": 0}

    def boom(_texts):
        called["n"] += 1
        raise AssertionError("should not encode")

    monkeypatch.setattr("app.services.encoding_service.encode_texts", boom)
    out = mve.extract_title_company_ml(
        _GH_UPBOUND,
        existing_title="Already Set",
        existing_company="Acme",
    )
    assert out["title"] == "Already Set"
    assert out["company"] == "Acme"
    assert called["n"] == 0
