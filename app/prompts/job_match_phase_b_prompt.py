"""
Phase B: tailored resume content and cover letter generation (deferred after Phase A).
"""

RESUME_TAILORING_PROMPT_MIN_LENGTH = 50
RESUME_TAILORING_PROMPT_MAX_LENGTH = 12000

JOB_MATCH_PHASE_B_INSTRUCTIONS = """You are an expert resume writer and career advisor.
Using the candidate's profile and the job description (plus structured job context from a prior step),
produce **two outputs** in one JSON response:

1. **Tailored Resume Content** — job-optimized profile summary, technical skills, and work experience.
2. **Cover Letter** — professional cover letter body.

Do NOT re-score the job match. Do NOT re-extract structured job fields.

---

## Task 1 — Tailored Resume Content

### Rules
- **Profile summary**: Rewrite to highlight alignment with this specific role (3-5 sentences). Do not invent experience.
- **Technical skills**: Dynamically grouped categories with comma-separated skills. Reorder for relevance. Only skills the candidate actually has. Typically 5-8 categories.
- **Work experience**: Exactly one entry for **every company** in the profile, same order. Never change company_name or job_title. Keep project_name as in profile or null.
  - Rewrite project_description and bullets to emphasize job-relevant skills and outcomes.

---

## Task 2 — Cover Letter

Generate a professional cover letter body (3-4 paragraphs).
- Reference the specific role and company from the structured job context.
- Highlight 2-3 key strengths aligned with the job.
- Do NOT include greeting or closing — body paragraphs only."""

JOB_MATCH_PHASE_B_OUTPUT_CONTRACT = """
---

## Response Format
Return ONLY valid JSON:

{
  "tailored_resume": {
    "profile_summary": "<string>",
    "technical_skills": [
      {"category": "<string>", "skills": "<comma-separated string>"}
    ],
    "work_experience": [
      {
        "company_name": "<string>",
        "job_title": "<string>",
        "project_name": "<string or null>",
        "project_description": "<string>",
        "bullets": ["<string>", ...]
      }
    ]
  },
  "cover_letter": {
    "body": "<string — paragraphs separated by \\n\\n>"
  }
}"""


def build_phase_b_system_prompt(instructions: str) -> str:
    """Combine user-editable instructions with the locked JSON output contract."""
    cleaned = instructions.strip()
    if not cleaned:
        cleaned = JOB_MATCH_PHASE_B_INSTRUCTIONS.strip()
    return f"{cleaned}{JOB_MATCH_PHASE_B_OUTPUT_CONTRACT}"


JOB_MATCH_PHASE_B_SYSTEM_PROMPT = build_phase_b_system_prompt(JOB_MATCH_PHASE_B_INSTRUCTIONS)

JOB_MATCH_PHASE_B_USER_TEMPLATE = """## Job Description
{job_text}

---

## Candidate Profile
{profile_text}

---

## Structured Job (from prior analysis)
{structured_context}

---

## Match Summary (from prior analysis)
{match_summary}

---

Generate tailored resume content and cover letter body as specified.
Include exactly one work_experience entry for EVERY company in the profile — do not skip any."""
