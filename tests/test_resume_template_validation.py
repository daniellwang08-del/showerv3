from datetime import datetime

from app.models.resume_template_schemas import ResumeTemplateAiValidation, ResumeTemplateBlueprint
from app.services.resume_template_service import (
    _blueprint_for_storage,
    _merge_validations,
    validate_blueprint,
)

def test_merge_validations_combines_rule_and_ai_errors():
    blueprint = ResumeTemplateBlueprint(engine="legacy_exp_n", detected_tags=["{{PROFILE_SUMMARY}}"])
    ai = ResumeTemplateAiValidation(
        passed=True,
        template_type="legacy_exp_n",
        summary="Looks good",
        errors=[],
    )
    rule_errors = validate_blueprint(blueprint, profile_work_count=2, detected_tags=blueprint.detected_tags)
    merged = _merge_validations(ai, rule_errors, blueprint, blueprint.detected_tags, 2)
    assert merged.passed is False
    assert merged.errors


def test_validate_legacy_requires_exp_slots():
    blueprint = ResumeTemplateBlueprint(
        engine="legacy_exp_n",
        detected_tags=["{{PROFILE_SUMMARY}}", "{{EXP_1}}"],
    )
    errors = validate_blueprint(blueprint, profile_work_count=2, detected_tags=blueprint.detected_tags)
    assert any("EXP_2" in e for e in errors)


def test_blueprint_for_storage_is_json_serializable():
    blueprint = ResumeTemplateBlueprint(
        engine="legacy_exp_n",
        detected_tags=["{{PROFILE_SUMMARY}}", "{{EXP_1}}"],
        ai_validation=ResumeTemplateAiValidation(
            passed=True,
            template_type="legacy_exp_n",
            validated_at=datetime(2026, 5, 26, 13, 44, 19),
        ),
    )
    payload = _blueprint_for_storage(blueprint)
    import json

    json.dumps(payload)
    assert isinstance(payload["ai_validation"]["validated_at"], str)
    restored = ResumeTemplateBlueprint.model_validate(payload)
    assert restored.ai_validation is not None
    assert restored.ai_validation.validated_at == datetime(2026, 5, 26, 13, 44, 19)


def test_requirements_follow_resume_style_sections():
    from app.services.resume_template_requirements import get_template_requirements

    req = get_template_requirements(profile_work_count=2)
    assert req.resume_style_title
    assert len(req.resume_style_sections) >= 3
    headings = [s.heading for s in req.resume_style_sections]
    assert "Header & contact" in headings
    assert "Professional summary" in headings
    assert "Work experience" in headings
    work = next(s for s in req.resume_style_sections if s.id == "work_experience")
    assert any(p.tag == "{{EXP_1}}" for p in work.placeholders)
    assert work.layout_example
    assert req.template_types[0].id == "dynamic"
    assert req.template_types[0].recommended is False
