"""Canonical resume template requirements - fixed EXP slots are the default layout."""

from __future__ import annotations

from app.core.config import get_settings
from app.models.database import User
from app.models.resume_template_schemas import (
    ResumeStyleSectionSpec,
    ResumeTemplateRequirementsResponse,
    TemplateFormatSpec,
    TemplatePlaceholderSpec,
    TemplateTypeSpec,
)


def _list_field(user: User | None, key: str) -> list:
    if not user:
        return []
    val = getattr(user, key, None) or []
    return list(val) if isinstance(val, list) else []


def _profile_section_counts(user: User | None) -> dict[str, int]:
    work = 0
    for item in _list_field(user, "work_experience"):
        if isinstance(item, dict) and (
            (item.get("company_name") or "").strip() or (item.get("job_title") or "").strip()
        ):
            work += 1
    skills = sum(
        1
        for item in _list_field(user, "technical_skills")
        if isinstance(item, dict) and ((item.get("category") or "").strip() or (item.get("skills") or "").strip())
    )
    education = sum(
        1
        for item in _list_field(user, "education")
        if isinstance(item, dict) and ((item.get("university_name") or "").strip() or (item.get("degree") or "").strip())
    )
    certificates = sum(
        1
        for item in _list_field(user, "certificates")
        if isinstance(item, dict) and (item.get("name") or "").strip()
    )
    return {
        "work": work,
        "skills": skills,
        "education": education,
        "certificates": certificates,
    }


def _exp_slot_tags(profile_work_count: int) -> list[str]:
    count = max(profile_work_count, 1)
    return [f"{{{{EXP_{i}}}}}" for i in range(1, count + 1)]


def _build_resume_style_sections(
    *,
    profile_work_count: int,
    counts: dict[str, int],
) -> list[ResumeStyleSectionSpec]:
    slot_count = max(profile_work_count, 1)
    exp_tags = _exp_slot_tags(profile_work_count)

    exp_layout_lines = ["WORK EXPERIENCE", ""]
    for i in range(1, slot_count + 1):
        exp_layout_lines.extend(
            [
                f"(Your Word formatting for role {i}: company line, dates, spacing, fonts…)",
                f"{{{{EXP_{i}}}}}",
                "",
            ]
        )
    exp_layout_example = "\n".join(exp_layout_lines).strip()

    work_description = (
        "Default approach: design each job's layout yourself in Word, then place one "
        "{{EXP_N}} placeholder per role where tailored text should be inserted. "
        "The app fills each slot without cloning paragraphs - your formatting stays intact."
    )
    if profile_work_count > 0:
        work_description += (
            f" Your profile has {profile_work_count} role(s) - include "
            f"{{{{EXP_1}}}} through {{{{EXP_{profile_work_count}}}}} at minimum."
        )
    else:
        work_description += " Add work experience to your profile, then add matching EXP slots."

    sections: list[ResumeStyleSectionSpec] = [
        ResumeStyleSectionSpec(
            id="header",
            heading="Header & contact",
            description=(
                "For fixed-slot templates, type your name and contact as normal Word text "
                "(recommended). Do not rely on {{profile.*}} tags here - they are only used "
                "with the optional repeat-block layout."
            ),
            layout_example=(
                "Jane Doe\n"
                "Senior Engineer | jane@email.com | +1 555 0100\n"
                "LinkedIn: linkedin.com/in/jane"
            ),
            placeholders=[
                TemplatePlaceholderSpec(
                    tag="(static text)",
                    label="Name & contact",
                    required=True,
                    description="Fixed text in Word - not replaced at build time.",
                ),
            ],
            required=True,
            applies_to_profile=True,
        ),
        ResumeStyleSectionSpec(
            id="summary",
            heading="Professional summary",
            description=(
                "One paragraph replaced with AI-tailored summary for each job application."
            ),
            layout_example=(
                "PROFESSIONAL SUMMARY\n"
                "{{PROFILE_SUMMARY}}"
            ),
            placeholders=[
                TemplatePlaceholderSpec(
                    tag="{{PROFILE_SUMMARY}}",
                    label="Tailored summary",
                    required=True,
                    description="Required for fixed-slot templates.",
                ),
                TemplatePlaceholderSpec(
                    tag="{{tailored.profile_summary}}",
                    label="Summary (repeat-block templates only)",
                    required=False,
                    description="Use with optional {{#work_experience}} layout instead.",
                ),
            ],
            required=True,
            applies_to_profile=True,
        ),
    ]

    if counts["skills"] > 0:
        sections.append(
            ResumeStyleSectionSpec(
                id="skills",
                heading="Technical skills",
                description=(
                    f"Optional - {counts['skills']} skill categor"
                    f"{'y' if counts['skills'] == 1 else 'ies'} in your profile. "
                    "Use one placeholder; the app expands it into category lines."
                ),
                layout_example=(
                    "TECHNICAL SKILLS\n"
                    "{{SKILLS_CONTENT}}"
                ),
                placeholders=[
                    TemplatePlaceholderSpec(
                        tag="{{SKILLS_CONTENT}}",
                        label="Skills block",
                        required=False,
                        description="Replaced with tailored skill categories.",
                    ),
                ],
                required=False,
                applies_to_profile=True,
            )
        )

    exp_placeholders = [
        TemplatePlaceholderSpec(
            tag=tag,
            label=f"Experience slot {i}",
            required=i <= profile_work_count if profile_work_count > 0 else i == 1,
            description=(
                "Put this tag on its own line (or paragraph) where tailored role text "
                "and bullets should appear. Style the surrounding lines in Word."
            ),
        )
        for i, tag in enumerate(exp_tags, start=1)
    ]

    sections.append(
        ResumeStyleSectionSpec(
            id="work_experience",
            heading="Work experience (fixed slots)",
            description=work_description,
            layout_example=exp_layout_example,
            placeholders=exp_placeholders,
            required=True,
            applies_to_profile=profile_work_count > 0,
        )
    )

    if counts["education"] > 0:
        sections.append(
            ResumeStyleSectionSpec(
                id="education",
                heading="Education",
                description=(
                    f"Optional - {counts['education']} entr"
                    f"{'y' if counts['education'] == 1 else 'ies'} in your profile. "
                    "Keep as static formatted text in Word."
                ),
                layout_example=(
                    "EDUCATION\n"
                    "State University | B.S. Computer Science | GPA 3.8\n"
                    "2016 – 2020"
                ),
                placeholders=[
                    TemplatePlaceholderSpec(
                        tag="(static text)",
                        label="Education entries",
                        required=False,
                        description="Fixed formatting in Word.",
                    ),
                ],
                required=False,
                applies_to_profile=True,
            )
        )

    if counts["certificates"] > 0:
        sections.append(
            ResumeStyleSectionSpec(
                id="certificates",
                heading="Certifications",
                description="Optional - static text in Word.",
                layout_example="CERTIFICATIONS\n• AWS Solutions Architect\n• PMP",
                placeholders=[
                    TemplatePlaceholderSpec(
                        tag="(static text)",
                        label="Certificate list",
                        required=False,
                        description="Fixed formatting in Word.",
                    ),
                ],
                required=False,
                applies_to_profile=True,
            )
        )

    return sections


def _dynamic_template_type(profile_work_count: int) -> TemplateTypeSpec:
    return TemplateTypeSpec(
        id="dynamic",
        label="Repeat-block layout (advanced)",
        engine="blueprint",
        recommended=False,
        description=(
            "Optional. Use {{#work_experience}} … {{/work_experience}} with one sample role block; "
            "the app clones it for each job. Formatting may differ from your hand-designed Word layout."
        ),
        required_placeholders=[
            TemplatePlaceholderSpec(
                tag="{{#work_experience}}",
                label="Loop open",
                required=True,
                description="Wrap a single role layout.",
                repeatable=True,
            ),
            TemplatePlaceholderSpec(
                tag="{{company_name}}",
                label="Company",
                required=True,
                description="Inside the loop.",
                repeatable=True,
            ),
            TemplatePlaceholderSpec(
                tag="{{/work_experience}}",
                label="Loop close",
                required=True,
                description="End of loop.",
                repeatable=True,
            ),
        ],
        optional_placeholders=[
            TemplatePlaceholderSpec(
                tag="{{profile.full_name}}",
                label="Profile tags",
                required=False,
                description="Only supported with this advanced layout.",
            ),
        ],
        example_snippet=(
            "{{#work_experience}}\n"
            "{{company_name}} | {{job_title}}\n"
            "{{project_description}}\n"
            "{{/work_experience}}"
        ),
    )


def get_template_requirements(
    *,
    user: User | None = None,
    profile_work_count: int = 0,
) -> ResumeTemplateRequirementsResponse:
    """Return résumé-style template guidance personalized to the user's profile."""
    max_bytes = get_settings().resume_template_max_bytes
    counts = _profile_section_counts(user)
    if profile_work_count <= 0:
        profile_work_count = counts["work"]

    style_sections = _build_resume_style_sections(
        profile_work_count=profile_work_count,
        counts=counts,
    )

    intro_parts = [
        "Default: fixed-slot templates with {{PROFILE_SUMMARY}}, optional {{SKILLS_CONTENT}}, "
        "and {{EXP_1}} … {{EXP_N}} for work history.",
        "Design each job's visual layout in Word yourself; placeholders mark where tailored text is inserted.",
    ]
    if profile_work_count > 0:
        intro_parts.append(
            f"You need at least {profile_work_count} experience slot(s): "
            + ", ".join(_exp_slot_tags(profile_work_count))
            + "."
        )

    return ResumeTemplateRequirementsResponse(
        file_format=TemplateFormatSpec(
            extension=".docx",
            mime_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            max_bytes=max_bytes,
            notes=(
                "Upload a .docx with your own Word formatting. "
                "Use {{EXP_N}} slots for work experience - not multiple duplicate sections cloned by code."
            ),
        ),
        resume_style_title="Fixed-slot résumé template (recommended)",
        resume_style_intro=" ".join(intro_parts),
        resume_style_sections=style_sections,
        template_types=[_dynamic_template_type(profile_work_count)],
        validation_notes=[
            "After upload, OpenAI validates {{PROFILE_SUMMARY}} and enough {{EXP_N}} slots for your profile.",
            "If you add or remove roles in Profile, add or remove EXP slots and re-validate.",
            "Repeat-block templates ({{#work_experience}}) are optional under Alternate layout.",
        ],
        profile_work_count=profile_work_count,
    )


def resume_style_summary_for_prompt(requirements: ResumeTemplateRequirementsResponse) -> str:
    """Compact résumé-style summary for OpenAI validation prompts."""
    lines = [
        requirements.resume_style_intro,
        "",
        "Default template type: fixed EXP_N slots (legacy_exp_n). "
        "Required: {{PROFILE_SUMMARY}}, {{EXP_1}} … {{EXP_N}} where N >= profile work count.",
        "Optional: {{SKILLS_CONTENT}}.",
        "",
    ]
    for section in requirements.resume_style_sections:
        req_tags = [p.tag for p in section.placeholders if p.required and not p.tag.startswith("(static")]
        opt_tags = [p.tag for p in section.placeholders if not p.required and not p.tag.startswith("(static")]
        line = f"- {section.heading}: {section.description}"
        if req_tags:
            line += f" Required: {', '.join(req_tags)}."
        if opt_tags:
            line += f" Optional: {', '.join(opt_tags[:6])}."
        lines.append(line)
    return "\n".join(lines)
