import json
from types import SimpleNamespace

import pytest

from app.api.assistant_routes import (
    AutofillControlIn,
    AutofillFieldIn,
    _applicant_profile_text,
    _build_autofill_prompt,
    _match_option,
    _parse_autofill_results,
)

PREFS = {"gender": "Male", "work_authorized": True, "needs_sponsorship": False}


def _answer(label, options, model_value, prefs=PREFS):
    field = AutofillFieldIn(
        handle=1, label=label, controls=[AutofillControlIn(cid="c1", kind="select", label=label, options=options)]
    )
    text = json.dumps({"results": [{"handle": 1, "controls": [{"cid": "c1", "value": model_value}]}]})
    (result,) = _parse_autofill_results(text, [field], prefs)
    return result.controls[0].value


@pytest.mark.parametrize(
    "label",
    [
        "Are you able to work from our NYC office (Three World Trade Center) 3 times per week?",
        "This is a hybrid role. Are you comfortable working onsite 2 days a week?",
        "Would you be willing to relocate to Austin, TX?",
        "Can you commute to our Seattle office?",
        "Are you open to working in person?",
    ],
)
def test_onsite_and_hybrid_requirements_are_answered_yes(label):
    assert _answer(label, ["Yes", "No"], "No") == "Yes"


def test_yes_variants_are_picked_for_onsite_questions():
    options = ["Yes, I can be in the office 3 days a week", "No, I need a fully remote role"]
    assert _answer("Are you able to work in the office 3 days per week?", options, options[1]) == options[0]


@pytest.mark.parametrize(
    ("label", "model"),
    [
        ("Do you require relocation assistance?", "No"),
        ("Are you authorized to work in the United States?", "Yes"),
        ("Do you have experience with office automation tools?", "No"),
    ],
)
def test_other_yes_no_questions_are_left_to_the_model(label, model):
    assert _answer(label, ["Yes", "No"], model) == model


def test_arrangement_preference_is_not_forced():
    options = ["Remote", "Hybrid", "Onsite"]
    assert _answer("Which work arrangement do you prefer?", options, "Remote") == "Remote"


def test_male_never_snaps_to_female_options():
    assert _match_option("Male", ["Female", "Male", "Non-binary"]) == "Male"
    assert _match_option("Male", ["Cisgender/Female", "Cisgender/Male", "Transgender"]) == "Cisgender/Male"
    assert _match_option("Male", ["Female", "Woman"]) is None
    assert _match_option("Man", ["Woman", "Man"]) == "Man"
    assert _match_option("Bachelor", ["Bachelors Degree", "Masters Degree"]) == "Bachelors Degree"
    assert _answer("Gender Identity", ["Cisgender/Female", "Cisgender/Male", "Transgender"], "Male") == "Cisgender/Male"


def test_chat_and_autofill_see_the_home_address_and_eeo_answers():
    user = SimpleNamespace(
        name="Nathaniel Giron",
        name_first="Nathaniel",
        name_last="Giron",
        phone_country_code="+1",
        phone_number="347-752-4729",
        profile_openai_cache="## Summary\nBackend engineer",
        address={"line1": "27102 123rd Place Southeast", "city": "Kent", "state": "WA", "postal_code": "98030", "country": "United States"},
        eeo_preferences={"gender": "Male"},
    )
    text = _applicant_profile_text(user, "")
    assert "- Postal/ZIP code: 98030" in text
    assert "- Street address: 27102 123rd Place Southeast" in text
    assert "- Phone: +1 347-752-4729" in text
    assert "Backend engineer" in text
    assert "Gender: Male" in text


def test_prompt_separates_preference_from_attendance_requirements():
    prompt = _build_autofill_prompt("profile", "job", settings_text="", answer_strategy="")
    assert "Onsite / hybrid / office attendance requirements" in prompt
    assert "even though the candidate prefers remote work" in prompt
