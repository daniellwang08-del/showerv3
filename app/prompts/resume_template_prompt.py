"""LLM prompts for analyzing uploaded resume DOCX structure."""

RESUME_TEMPLATE_STRUCTURE_INSTRUCTIONS = """You are a document structure analyst for Word resume templates.

Given an outline of a resume DOCX (indexed body blocks), identify logical sections and produce a JSON blueprint.

Default layout (recommended): fixed experience slots {{EXP_1}}, {{EXP_2}}, … with {{PROFILE_SUMMARY}} and optional {{SKILLS_CONTENT}}.
- Set engine to "legacy_exp_n" when EXP tags are present or when no repeat block is used.
- Header/contact is usually static Word text (not {{profile.*}} tags).

Alternate layout (advanced): one {{#work_experience}} … {{/work_experience}} repeat block — set engine to "blueprint" only when that loop is present.

Rules:
- Identify sections: header/contact, summary, skills, work_experience, education, certificates, other.
- For legacy_exp_n: count {{EXP_N}} tags; do not require working_block.
- For blueprint: locate ONE repeatable role block using start_index/end_index inclusive.
- Supported tags:
  {{PROFILE_SUMMARY}} (default summary tag)
  {{SKILLS_CONTENT}} (optional skills block)
  {{EXP_1}}, {{EXP_2}}, … (default work history slots)
  {{#work_experience}} … {{company_name}} {{job_title}} {{project_description}} {{/work_experience}} (alternate)
  {{tailored.profile_summary}}, {{profile.full_name}}, {{#technical_skills}} … (alternate layout only)
- education and certificates are optional sections.
- Return ONLY valid JSON matching the schema below.
"""

RESUME_TEMPLATE_STRUCTURE_USER_TEMPLATE = """Document outline (index, kind, text):
{outline}

Detected tags in document:
{detected_tags}

User profile work experience count: {profile_work_count}

Return JSON:
{{
  "version": 1,
  "engine": "legacy_exp_n" | "blueprint",
  "sections": [
    {{
      "id": "summary",
      "label": "Professional Summary",
      "type": "scalar",
      "start_index": 0,
      "end_index": 0,
      "optional": false,
      "bindings": [{{"tag": "{{PROFILE_SUMMARY}}", "path": "tailored.profile_summary", "label": "Summary"}}]
    }}
  ],
  "working_block": null,
  "detected_tags": [],
  "warnings": []
}}

Use engine "legacy_exp_n" unless {{#work_experience}} is clearly present without EXP tags.
"""

RESUME_TEMPLATE_VALIDATION_INSTRUCTIONS = """You are a resume template validator for Word DOCX files with placeholder tags.

Validate whether the uploaded template matches the app's **default fixed-slot résumé style**:
static header/contact → {{PROFILE_SUMMARY}} → optional {{SKILLS_CONTENT}} → {{EXP_1}} … {{EXP_N}} (one slot per profile role).

Alternate (advanced): a single {{#work_experience}} repeat block with company/title/description tags inside.

Required for default templates:
- {{PROFILE_SUMMARY}}
- Enough {{EXP_N}} slots for the user's profile role count ({{EXP_1}} through {{EXP_N}})

Set passed=false for blocking issues (missing summary, missing EXP slots, insufficient slot count).
Warnings = optional sections missing (skills). Suggestions = concrete layout fixes in résumé terms.

Return ONLY valid JSON matching the schema in the user message."""

RESUME_TEMPLATE_VALIDATION_USER_TEMPLATE = """## Expected template requirements
{requirements_summary}

## User profile
Work experience roles in profile: {profile_work_count}

## Detected tags in uploaded DOCX
{detected_tags}

## Document outline (indexed body blocks)
{outline}

## Parsed blueprint (from structure analysis)
{blueprint_json}

Return JSON:
{{
  "passed": true,
  "template_type": "legacy_exp_n" | "dynamic" | "unknown",
  "summary": "One or two sentences for the user explaining validation outcome.",
  "errors": ["blocking issue if any"],
  "warnings": ["non-blocking note"],
  "suggestions": ["actionable fix"],
  "detected_required_tags": ["tags found that satisfy requirements"],
  "missing_required_tags": ["required tags not found"]
}}
"""
