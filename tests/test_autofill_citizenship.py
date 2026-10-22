import json

import pytest

from app.api.assistant_routes import (
    AutofillControlIn,
    AutofillFieldIn,
    _build_autofill_prompt,
    _eeo_for_autofill,
    _eeo_preferences_text,
    _is_safest_only_label,
    _parse_autofill_results,
    us_citizenship,
)

EAR_LABEL = (
    "This position may require access to information and technology that is subject to export "
    "controls, such as EAR. Are you any of the following?"
)
EAR_OPTIONS = [
    "A United States Citizen",
    "A lawful permanent resident of the United States (i.e. Greencard holder)",
    "A protected individual",
    "Other",
]
AUTHORIZED = {"work_authorized": True, "needs_sponsorship": False}


def _answer(label, options, model_value, prefs, *, multi=False, kind="radio"):
    field = AutofillFieldIn(
        handle=1,
        label=label,
        controls=[AutofillControlIn(cid="c1", kind=kind, label=label, options=options, multi=multi)],
    )
    control = {"cid": "c1", "kind": kind}
    if multi:
        control["option_values"] = model_value if isinstance(model_value, list) else [model_value]
    else:
        control["value"] = model_value
    text = json.dumps({"results": [{"handle": 1, "controls": [control]}]})
    (result,) = _parse_autofill_results(text, [field], prefs)
    (out,) = result.controls
    return out.option_values if multi else out.value


@pytest.mark.parametrize(
    ("prefs", "status"),
    [
        ({}, "U.S. citizen"),
        (AUTHORIZED, "U.S. citizen"),
        ({"work_authorized": True, "needs_sponsorship": True}, "Neither"),
        ({"work_authorized": False}, "Neither"),
        ({**AUTHORIZED, "us_citizenship": "U.S. permanent resident"}, "U.S. permanent resident"),
        ({**AUTHORIZED, "us_citizenship": "Neither"}, "Neither"),
        ({**AUTHORIZED, "us_citizenship": "something else"}, "U.S. citizen"),
    ],
)
def test_citizenship_comes_from_the_profile_or_work_eligibility(prefs, status):
    assert us_citizenship(prefs) == status


def test_issue_16_export_control_status_picks_us_citizen_not_other():
    assert _answer(EAR_LABEL, EAR_OPTIONS, "Other", AUTHORIZED) == "A United States Citizen"


def test_a_green_card_holder_picks_the_permanent_resident_option():
    prefs = {**AUTHORIZED, "us_citizenship": "U.S. permanent resident"}
    assert _answer(EAR_LABEL, EAR_OPTIONS, "A United States Citizen", prefs) == EAR_OPTIONS[1]


def test_someone_who_needs_sponsorship_picks_other():
    prefs = {"work_authorized": True, "needs_sponsorship": True}
    assert _answer(EAR_LABEL, EAR_OPTIONS, "A United States Citizen", prefs) == "Other"


def test_a_checkbox_version_selects_exactly_one_status():
    assert _answer(EAR_LABEL, EAR_OPTIONS, ["Other", "A protected individual"], AUTHORIZED, multi=True) == [
        "A United States Citizen"
    ]


def test_yes_no_us_person_and_citizen_questions_follow_the_status():
    resident = {**AUTHORIZED, "us_citizenship": "U.S. permanent resident"}
    itar = "Are you a U.S. person as defined by ITAR (22 CFR 120.62)?"
    assert _answer(itar, ["Yes", "No"], "No", AUTHORIZED) == "Yes"
    assert _answer(itar, ["Yes", "No"], "No", resident) == "Yes"
    assert _answer("Are you a U.S. citizen?", ["Yes", "No"], "Yes", resident) == "No"
    assert _answer("Are you a U.S. citizen?", ["Yes", "No"], "No", AUTHORIZED) == "Yes"


def test_work_authorization_questions_are_left_to_the_model():
    label = "Are you legally authorized to work in the United States?"
    assert _answer(label, ["Yes", "No"], "Yes", {"us_citizenship": "Neither"}) == "Yes"


def test_export_control_disclosures_still_get_the_safest_answer():
    label = "Have you ever violated U.S. export control regulations?"
    assert _answer(label, ["Yes", "No"], "Yes", AUTHORIZED) == "No"


def test_year_labels_are_not_treated_as_export_control():
    assert not _is_safest_only_label("Graduation year (YYYY)")
    assert not _is_safest_only_label("What year did you start your current role?")
    assert _is_safest_only_label("Is this role subject to ITAR?")
    assert _is_safest_only_label("Export controlled technology (EAR) acknowledgement")


def test_the_model_sees_the_status_and_the_exception_to_the_safest_rule():
    assert "- U.S. citizenship status: U.S. citizen" in _eeo_preferences_text(AUTHORIZED)
    assert "- U.S. citizenship status: Neither" in _eeo_preferences_text({"needs_sponsorship": True})
    prompt = _build_autofill_prompt("profile", "job", settings_text="", answer_strategy="")
    assert "safest-option rule below does NOT apply" in prompt
    assert _eeo_for_autofill(AUTHORIZED)["usCitizenship"] == "U.S. citizen"
