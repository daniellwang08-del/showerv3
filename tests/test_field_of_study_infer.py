"""Field of Study inference + Computer Science fallback for Workday autofill."""

from app.api.assistant_routes import _build_education, _infer_field_of_study


class TestInferFieldOfStudy:
    def test_default_computer_engineering_gets_cs_fallback(self):
        primary, fallbacks = _infer_field_of_study({}, "Computer Engineering")
        assert primary == "Computer Engineering"
        assert "Computer Science" in fallbacks

    def test_explicit_field_of_study_wins(self):
        primary, fallbacks = _infer_field_of_study(
            {"field_of_study": "Software Engineering"},
            "Computer Engineering",
        )
        assert primary == "Software Engineering"
        assert "Computer Science" in fallbacks

    def test_build_education_includes_fallbacks(self):
        rows = _build_education(
            [
                {
                    "university_name": "MIT",
                    "degree": "MS",
                    "mark": "3.7",
                    "period_start": "2018-01",
                    "period_end": "2018-12",
                }
            ],
            default_gpa="3.7",
            default_field_of_study="Computer Engineering",
        )
        assert len(rows) == 1
        assert rows[0]["fieldOfStudy"] == "Computer Engineering"
        assert "Computer Science" in rows[0]["fieldOfStudyFallbacks"]
