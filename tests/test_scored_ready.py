from types import SimpleNamespace

from app.services.scored_ready_service import _content_matches_mode

TAILORED = {"work_experience": [{"company": "Acme"}]}
COVER = {"body": "Dear team"}


def _row(tailored=None, cover=None):
    return SimpleNamespace(tailored_resume_data=tailored, cover_letter_data=cover)


def test_no_build_row_needs_fresh_content():
    assert _content_matches_mode(None, original=False) is False
    assert _content_matches_mode(None, original=True) is False


def test_tailored_mode_reuses_existing_tailored_resume():
    assert _content_matches_mode(_row(TAILORED, COVER), original=False) is True
    assert _content_matches_mode(_row(None, COVER), original=False) is False


def test_original_mode_reuses_cover_letter_only_content():
    assert _content_matches_mode(_row(None, COVER), original=True) is True
    assert _content_matches_mode(_row(None, {"body": ""}), original=True) is False


def test_original_mode_regenerates_when_a_tailored_resume_is_present():
    assert _content_matches_mode(_row(TAILORED, COVER), original=True) is False
