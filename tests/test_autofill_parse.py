import json

from app.api.assistant_routes import (
    AutofillControlIn,
    AutofillFieldIn,
    _match_option,
    _parse_autofill_results,
)


def _field(handle, controls):
    return AutofillFieldIn(handle=handle, label="", controls=controls)


class TestMatchOption:
    def test_exact_case_insensitive(self):
        assert _match_option("yes", ["Yes", "No"]) == "Yes"

    def test_substring_fallback(self):
        assert _match_option("United States", ["United States of America", "Canada"]) == (
            "United States of America"
        )

    def test_no_match_returns_none(self):
        assert _match_option("Mars", ["Yes", "No"]) is None

    def test_empty_returns_none(self):
        assert _match_option("", ["Yes", "No"]) is None


class TestParseAutofillResults:
    def test_cid_mapping(self):
        fields = [
            _field(
                1,
                [
                    AutofillControlIn(cid="1:0", kind="text", label="First Name"),
                    AutofillControlIn(cid="1:1", kind="email", label="Email"),
                ],
            )
        ]
        text = json.dumps(
            {
                "results": [
                    {
                        "handle": 1,
                        "controls": [
                            {"cid": "1:0", "value": "Jane", "kind": "text"},
                            {"cid": "1:1", "value": "jane@x.com", "kind": "email"},
                        ],
                    }
                ]
            }
        )
        out = _parse_autofill_results(text, fields)
        assert len(out) == 1
        assert {c.cid: c.value for c in out[0].controls} == {"1:0": "Jane", "1:1": "jane@x.com"}

    def test_drops_unknown_handle_and_cid(self):
        fields = [_field(1, [AutofillControlIn(cid="1:0", kind="text")])]
        text = json.dumps(
            {
                "results": [
                    {"handle": 1, "controls": [{"cid": "1:0", "value": "a"}, {"cid": "9:9", "value": "ghost"}]},
                    {"handle": 7, "controls": [{"cid": "7:0", "value": "nope"}]},
                ]
            }
        )
        out = _parse_autofill_results(text, fields)
        assert len(out) == 1
        assert out[0].handle == 1
        assert len(out[0].controls) == 1
        assert out[0].controls[0].cid == "1:0"

    def test_option_snapped_to_allowed_list(self):
        fields = [
            _field(2, [AutofillControlIn(cid="2:0", kind="select", options=["Yes", "No"])]),
        ]
        text = json.dumps(
            {"results": [{"handle": 2, "controls": [{"cid": "2:0", "value": "yes", "kind": "select"}]}]}
        )
        out = _parse_autofill_results(text, fields)
        ctrl = out[0].controls[0]
        assert ctrl.value == "Yes"
        assert ctrl.option == "Yes"

    def test_file_role_clamped_and_value_cleared(self):
        fields = [_field(3, [AutofillControlIn(cid="3:0", kind="file", is_file=True)])]
        text = json.dumps(
            {
                "results": [
                    {
                        "handle": 3,
                        "controls": [{"cid": "3:0", "kind": "file", "value": "ignored", "file_role": "RESUME"}],
                    }
                ]
            }
        )
        out = _parse_autofill_results(text, fields)
        ctrl = out[0].controls[0]
        assert ctrl.file_role == "resume"
        assert ctrl.value == ""

    def test_file_role_unknown_becomes_other(self):
        fields = [_field(3, [AutofillControlIn(cid="3:0", kind="file", is_file=True)])]
        text = json.dumps(
            {"results": [{"handle": 3, "controls": [{"cid": "3:0", "kind": "file", "file_role": "weird"}]}]}
        )
        out = _parse_autofill_results(text, fields)
        assert out[0].controls[0].file_role == "other"

    def test_needs_user_preserved(self):
        fields = [_field(5, [AutofillControlIn(cid="5:0", kind="radio", options=["Yes", "No"])])]
        text = json.dumps(
            {
                "results": [
                    {
                        "handle": 5,
                        "controls": [
                            {"cid": "5:0", "value": "", "kind": "radio", "needs_user": True, "reason": "EEO"}
                        ],
                    }
                ]
            }
        )
        out = _parse_autofill_results(text, fields)
        assert out[0].controls[0].needs_user is True
        assert out[0].controls[0].reason == "EEO"

    def test_malformed_json_returns_empty(self):
        fields = [_field(1, [AutofillControlIn(cid="1:0", kind="text")])]
        assert _parse_autofill_results("not json", fields) == []
        assert _parse_autofill_results("{}", fields) == []
        assert _parse_autofill_results(json.dumps({"results": "nope"}), fields) == []


class TestPhoneCountryCodeSplit:
    """When a separate country/dial-code control is present, the phone-number
    field must hold only the local national number (deterministic, not prompt)."""

    def _phone_payload(self, phone_value):
        return json.dumps(
            {
                "results": [
                    {
                        "handle": 1,
                        "controls": [
                            {"cid": "1:0", "value": "United States", "option": "United States"},
                            {"cid": "1:1", "value": phone_value, "kind": "tel"},
                        ],
                    }
                ]
            }
        )

    def test_strips_country_code_when_country_control_present(self):
        fields = [
            _field(
                1,
                [
                    AutofillControlIn(cid="1:0", kind="custom", label="Country", options=["United States", "Canada"]),
                    AutofillControlIn(cid="1:1", kind="tel", label="Phone"),
                ],
            )
        ]
        out = _parse_autofill_results(self._phone_payload("+1 814-313-3669"), fields)
        vals = {c.cid: c.value for c in out[0].controls}
        assert vals["1:1"] == "814-313-3669"
        assert vals["1:0"] == "United States"

    def test_keeps_full_number_without_country_control(self):
        fields = [_field(1, [AutofillControlIn(cid="1:1", kind="tel", label="Phone")])]
        text = json.dumps(
            {"results": [{"handle": 1, "controls": [{"cid": "1:1", "value": "+1 814-313-3669", "kind": "tel"}]}]}
        )
        out = _parse_autofill_results(text, fields)
        assert out[0].controls[0].value == "+1 814-313-3669"

    def test_local_number_unchanged(self):
        fields = [
            _field(
                1,
                [
                    AutofillControlIn(cid="1:0", kind="custom", label="Country", options=["United States", "Canada"]),
                    AutofillControlIn(cid="1:1", kind="tel", label="Phone"),
                ],
            )
        ]
        out = _parse_autofill_results(self._phone_payload("814-313-3669"), fields)
        assert {c.cid: c.value for c in out[0].controls}["1:1"] == "814-313-3669"


class TestMultiSelect:
    def _multi_field(self, options):
        return [_field(1, [AutofillControlIn(cid="1:0", kind="custom", multi=True, options=options)])]

    def test_option_values_snapped_and_deduped(self):
        fields = self._multi_field(["Python", "Go", "Rust", "TypeScript"])
        text = json.dumps(
            {
                "results": [
                    {
                        "handle": 1,
                        "controls": [{"cid": "1:0", "option_values": ["python", "GO", "go", "java"]}],
                    }
                ]
            }
        )
        out = _parse_autofill_results(text, fields)
        ctrl = out[0].controls[0]
        # snapped to allowed casing, "go" deduped, "java" (unmatched) dropped
        assert ctrl.option_values == ["Python", "Go"]
        assert ctrl.value == ""
        assert ctrl.option is None

    def test_falls_back_to_value_when_no_option_values(self):
        fields = self._multi_field(["Yes", "No"])
        text = json.dumps({"results": [{"handle": 1, "controls": [{"cid": "1:0", "value": "yes"}]}]})
        out = _parse_autofill_results(text, fields)
        assert out[0].controls[0].option_values == ["Yes"]

    def test_empty_when_nothing_matches(self):
        fields = self._multi_field(["Yes", "No"])
        text = json.dumps({"results": [{"handle": 1, "controls": [{"cid": "1:0", "option_values": ["Maybe"]}]}]})
        out = _parse_autofill_results(text, fields)
        assert out[0].controls[0].option_values == []


class TestDemographicAndConsent:
    def test_demographic_answer_is_not_flagged(self):
        """Parser passes a demographic single-select answer through (no needs_user)."""
        fields = [_field(1, [AutofillControlIn(cid="1:0", kind="custom", label="Gender", options=["Male", "Female"])])]
        text = json.dumps({"results": [{"handle": 1, "controls": [{"cid": "1:0", "value": "Male"}]}]})
        out = _parse_autofill_results(text, fields)
        ctrl = out[0].controls[0]
        assert ctrl.value == "Male"
        assert ctrl.option == "Male"
        assert ctrl.needs_user is False

    def test_consent_single_option(self):
        fields = [_field(1, [AutofillControlIn(cid="1:0", kind="custom", label="Talent community", options=["I agree"])])]
        text = json.dumps({"results": [{"handle": 1, "controls": [{"cid": "1:0", "value": "I agree"}]}]})
        out = _parse_autofill_results(text, fields)
        assert out[0].controls[0].value == "I agree"


class TestDeterministicEEOOverride:
    """When the model refuses an EEO/demographic/consent control and returns
    needs_user (or empty), the parser forces a default from the option list."""

    def _flagged(self, label, options, reason="EEO demographic question"):
        fields = [_field(1, [AutofillControlIn(cid="1:0", kind="custom", label=label, options=options)])]
        text = json.dumps(
            {
                "results": [
                    {
                        "handle": 1,
                        "controls": [
                            {"cid": "1:0", "value": "", "needs_user": True, "reason": reason}
                        ],
                    }
                ]
            }
        )
        return _parse_autofill_results(text, fields)[0].controls[0]

    def test_gender_forced_male_not_female(self):
        c = self._flagged("Gender", ["Male", "Female", "Decline To Self Identify"])
        assert c.value == "Male"
        assert c.option == "Male"
        assert c.needs_user is False
        assert c.reason is None

    def test_hispanic_forced_no(self):
        c = self._flagged("Are you Hispanic/Latino?", ["Yes", "No", "Decline To Self Identify"])
        assert c.value == "No"
        assert c.needs_user is False

    def test_veteran_forced_not_protected(self):
        c = self._flagged(
            "Veteran Status",
            [
                "I am not a protected veteran",
                "I identify as one or more classifications of a protected veteran",
                "I don't wish to answer",
            ],
        )
        assert c.value == "I am not a protected veteran"
        assert c.needs_user is False

    def test_disability_forced_no(self):
        c = self._flagged(
            "Disability Status",
            [
                "Yes, I have a disability, or have had one in the past",
                "No, I do not have a disability and have not had one in the past",
                "I do not want to answer",
            ],
        )
        assert c.value == "No, I do not have a disability and have not had one in the past"
        assert c.needs_user is False

    def test_race_forced_asian(self):
        c = self._flagged("Race / Ethnicity", ["White", "Asian", "Black or African American", "Decline"])
        assert c.value == "Asian"
        assert c.needs_user is False

    def test_consent_single_option_forced_when_flagged(self):
        c = self._flagged("Do you agree to join the talent community?", ["I agree"], reason="consent")
        assert c.value == "I agree"
        assert c.needs_user is False

    def test_non_demographic_needs_user_preserved(self):
        # A genuine unknown qualification with a generic label stays needs_user.
        c = self._flagged("Do you hold a Top Secret clearance?", ["Yes", "No"], reason="no evidence")
        assert c.needs_user is True
        assert c.value == ""
