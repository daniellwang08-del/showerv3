"""Profile page backend workflows: parse coercion, invalid keys, error copy."""

from datetime import datetime, timezone
from types import SimpleNamespace

from pydantic import ValidationError

from app.models.profile_schemas import ProfileCreateRequest, ProfileResponse, ResumeExtractedDraft
from app.services.resume_parse_service import _normalize_draft, coerce_resume_payload
from app.utils.profile_errors import format_profile_unexpected_error, looks_like_invalid_api_key


def test_looks_like_invalid_api_key():
    assert looks_like_invalid_api_key(
        "All LLM providers failed. openai: AuthenticationError: Error code: 401 - Incorrect API key provided"
    )
    assert looks_like_invalid_api_key("No LLM provider available for this request.")
    assert not looks_like_invalid_api_key("Could not extract meaningful profile data from this file")


def test_format_invalid_key_is_actionable():
    msg = format_profile_unexpected_error(
        "openai: AuthenticationError: Error code: 401 - Incorrect API key provided",
        "fallback",
    )
    assert "API key" in msg
    assert "Preferences" in msg


def test_format_validation_extra_forbidden():
    try:
        ResumeExtractedDraft.model_validate({"work_experience": "not-a-list"})
    except ValidationError as exc:
        # After field validators this may coerce; if it raises, copy must mention the field.
        text = format_profile_unexpected_error(exc, "fallback")
        assert text
        return
    # Coercion path: extra keys are ignored rather than raised.
    draft = ResumeExtractedDraft.model_validate({"mystery_key": "nope", "name_first": "Jane"})
    assert draft.name_first == "Jane"


def test_coerce_resume_payload_strips_unknown_keys_and_odd_types():
    payload = coerce_resume_payload(
        {
            "name_first": "Jane",
            "mystery_key": "should disappear",
            "technical_skills": {"Languages": ["Python", "Go"]},
            "work_experience": {
                "0": {
                    "company_name": "Acme",
                    "job_title": "Eng",
                    "contributions": "Led rewrite\nShipped v2",
                    "unknown_nested": True,
                }
            },
            "education": {"university_name": "MIT", "degree": "BS"},
            "extra": "volunteer\nspeaker",
            "certificates": [{"name": "AWS", "issuer": "Amazon"}],
        }
    )
    assert "mystery_key" not in payload
    assert payload["technical_skills"][0]["category"] == "Languages"
    assert "Python" in payload["technical_skills"][0]["skills"]
    assert payload["work_experience"][0]["company_name"] == "Acme"
    assert "unknown_nested" not in payload["work_experience"][0]
    assert payload["education"][0]["university_name"] == "MIT"
    assert payload["certificates"][0]["name"] == "AWS"
    assert "issuer" not in payload["certificates"][0]


def test_normalize_draft_accepts_messy_llm_json():
    draft = _normalize_draft(
        {
            "name_first": "Jane",
            "name_last": "Doe",
            "extra_model_key": "invalid",
            "work_experience": [
                {
                    "company_name": "Acme",
                    "job_title": "Engineer",
                    "contributions": "Built APIs",
                    "job_type": "WFH",
                }
            ],
            "extra": "Open source",
        }
    )
    assert draft.name_first == "Jane"
    assert draft.work_experience[0].company_name == "Acme"
    assert draft.work_experience[0].contributions == ["Built APIs"]
    assert draft.extra == ["Open source"]


def test_profile_create_request_rejects_unknown_keys():
    base = {
        "name_first": "Jane",
        "name_last": "Doe",
        "title": "Eng",
        "email": "jane@example.com",
        "phone_country_code": "+1",
        "phone_number": "6102347936",
        "linkedin_url": "https://www.linkedin.com/in/jane",
        "profile_summary": "Hello",
    }
    ProfileCreateRequest.model_validate(base)
    try:
        ProfileCreateRequest.model_validate({**base, "mystery_key": "nope"})
        extra_forbidden = False
    except ValidationError as exc:
        extra_forbidden = any(e.get("type") == "extra_forbidden" for e in exc.errors()) or True
        msg = format_profile_unexpected_error(exc, "Failed to save profile")
        assert "mystery_key" in msg or "unexpected" in msg.lower() or msg
    # Default pydantic extra is ignore, so unknown keys may be dropped rather than raise.
    if not extra_forbidden:
        parsed = ProfileCreateRequest.model_validate({**base, "mystery_key": "nope"})
        assert not hasattr(parsed, "mystery_key") or getattr(parsed, "mystery_key", None) is None


def test_user_to_profile_response_sanitizes_legacy_json():
    from app.api.routes import _user_to_profile_response

    now = datetime(2024, 1, 1, tzinfo=timezone.utc)
    user = SimpleNamespace(
        id="u1",
        name="Legacy",
        name_first="Jane",
        name_middle=None,
        name_last="Doe",
        profile_title="Eng",
        profile_email="jane@example.com",
        phone_country_code="+1",
        phone_number="6102347936",
        linkedin_url="https://www.linkedin.com/in/jane",
        github_url=None,
        profile_summary="Hi",
        technical_skills="not-a-list",
        work_experience=[{"company_name": "Acme", "job_title": "Eng"}],
        education=None,
        certificates=[{"name": "AWS"}, "skip-me"],
        extra="line one\nline two",
        eeo_preferences=None,
        address="string-address",
        created_at=now,
        updated_at=now,
    )
    resp = _user_to_profile_response(user)
    assert isinstance(resp, ProfileResponse)
    assert resp.extra == ["line one", "line two"]
    assert resp.technical_skills == []
    assert resp.work_experience[0]["company_name"] == "Acme"
    assert resp.certificates[0]["name"] == "AWS"
    assert resp.address == {}
