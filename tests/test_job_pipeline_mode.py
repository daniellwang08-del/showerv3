"""Tests for admin extract-only vs applicant full pipeline ownership."""

from types import SimpleNamespace

from app.models.schemas import ExtractionStatus
from app.services.job_pipeline_mode import extraction_has_shared_jd, ingest_chain_user_id


def test_admin_ingest_is_extract_only():
    assert ingest_chain_user_id(is_admin=True, user_id="admin-1") is None


def test_applicant_ingest_chains_personal_pipeline():
    assert ingest_chain_user_id(is_admin=False, user_id="user-1") == "user-1"


def test_missing_user_is_extract_only():
    assert ingest_chain_user_id(is_admin=False, user_id=None) is None
    assert ingest_chain_user_id(is_admin=False, user_id="") is None


def test_extraction_has_shared_jd_for_extracted_and_completed():
    assert extraction_has_shared_jd(
        SimpleNamespace(status=ExtractionStatus.EXTRACTED)
    )
    assert extraction_has_shared_jd(
        SimpleNamespace(status=ExtractionStatus.COMPLETED)
    )
    assert not extraction_has_shared_jd(
        SimpleNamespace(status=ExtractionStatus.PENDING)
    )
    assert not extraction_has_shared_jd(
        SimpleNamespace(status=ExtractionStatus.PROCESSING)
    )
    assert not extraction_has_shared_jd(None)
