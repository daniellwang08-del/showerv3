"""Tests for hybrid rules + MiniLM work-mode classification."""

from app.services.work_mode_classifier import (
    build_work_mode_signal_text,
    classify_work_mode,
    classify_work_mode_rules,
)
from app.services.job_metadata_hydrator import build_metadata, infer_company_from_url
from app.extractors.greenhouse_board_extractor import parse_greenhouse_job_id_from_url


def test_rules_title_pipe_remote():
    mode = classify_work_mode_rules(title="AI Product Engineer | REMOTE")
    assert mode == "remote"


def test_rules_location_hybrid():
    mode = classify_work_mode_rules(location="Austin, TX (Hybrid)")
    assert mode == "hybrid"


def test_rules_body_onsite():
    text = "About the role\nThis is an on-site role requiring daily presence at the office.\nApply now"
    mode = classify_work_mode_rules(plain_text=text)
    assert mode == "onsite"


def test_rules_is_remote_flag():
    assert classify_work_mode_rules(is_remote=True) == "remote"


def test_build_metadata_title_remote_without_location_mode():
    meta = build_metadata(
        plain_text="Title: Staff Engineer | Hybrid\nCompany: Acme\n\nWe build things.",
        source_url="https://jobs.lever.co/acme/abc",
        existing_company="Unknown",
    )
    assert meta["work_mode"] == "hybrid"
    assert meta["title"] == "Staff Engineer | Hybrid"


def test_greenhouse_embed_token_job_id():
    url = (
        "https://job-boards.greenhouse.io/embed/job_app"
        "?for=tibitit&token=7255621003&utm_source=jobright"
    )
    assert parse_greenhouse_job_id_from_url(url) == "7255621003"


def test_infer_company_from_greenhouse_embed():
    url = "https://job-boards.greenhouse.io/embed/job_app?for=abnormalsecurity&token=1"
    assert infer_company_from_url(url) == "Abnormalsecurity"


def test_classify_prefers_rules_over_vector_flag():
    mode, explain = classify_work_mode(
        title="Backend Engineer | Remote",
        use_vector=True,
    )
    assert mode == "remote"
    assert explain["source"] == "rules"


def test_rules_does_not_force_remote_support_title():
    assert classify_work_mode_rules(title="Remote Support Engineer") is None


def test_signal_text_extracts_mode_lines():
    text = build_work_mode_signal_text(
        title="Engineer",
        plain_text="Intro\nWe offer a hybrid workplace with 3 days in office.\nBenefits",
    )
    assert "hybrid" in text.lower()
