from app.models.profile_schemas import ResumeExtractedDraft
from app.services.resume_parse_service import (
    _fill_missing_contact_from_text,
    _normalize_phone_fields,
)


def test_keeps_uk_number_and_code():
    assert _normalize_phone_fields("+44", "7700 900123") == ("+44", "7700900123")
    assert _normalize_phone_fields(None, "+44 7700 900123") == ("+44", "7700900123")
    assert _normalize_phone_fields("+447700900123", None) == ("+44", "7700900123")


def test_keeps_ireland_and_germany():
    assert _normalize_phone_fields("+353", "86 123 4567") == ("+353", "861234567")
    assert _normalize_phone_fields(None, "+353 86 123 4567") == ("+353", "861234567")
    assert _normalize_phone_fields("+49", "030 12345678") == ("+49", "03012345678")


def test_default_plus_one_does_not_steal_international():
    assert _normalize_phone_fields("+1", "+44 7700 900123") == ("+44", "7700900123")
    assert _normalize_phone_fields("+1", "+353861234567") == ("+353", "861234567")


def test_us_number_still_formats():
    assert _normalize_phone_fields("+1", "6102347936") == ("+1", "(610) 234-7936")
    assert _normalize_phone_fields(None, "(610) 234-7936") == ("+1", "(610) 234-7936")
    assert _normalize_phone_fields("+1", "313-3369") == (None, None)


def test_fill_recovers_international_from_header_text():
    draft = ResumeExtractedDraft()
    notes = _fill_missing_contact_from_text(
        draft,
        "Jane Doe\nDublin, Ireland\n+353 86 123 4567\njane@example.com\n",
    )
    assert draft.phone_country_code == "+353"
    assert draft.phone_number == "861234567"
    assert any("Phone number" in n for n in notes)
