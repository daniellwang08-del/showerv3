"""
Phase B: tailored resume content and cover letter generation (deferred after Phase A).
"""

from app.prompts.cover_letter_prompt import COVER_LETTER_INSTRUCTIONS

RESUME_TAILORING_PROMPT_MIN_LENGTH = 50
RESUME_TAILORING_PROMPT_MAX_LENGTH = 12000

PHASE_B_INTRO = """You are an expert resume writer and career advisor.
Using the candidate's profile and the job description (plus structured job context from a prior step),
produce **two outputs** in one JSON response:

1. **Tailored Resume Content** — job-optimized profile summary, technical skills, and work experience.
2. **Cover Letter** — professional cover letter body.

Do NOT re-score the job match. Do NOT re-extract structured job fields."""

RESUME_TAILORING_INSTRUCTIONS = """---

## Task 1 — Tailored Resume Content

### Rules
- **Profile summary**: Rewrite to highlight alignment with this specific role (3-5 sentences). Do not invent experience.
- **Technical skills**: Dynamically grouped categories with comma-separated skills. Reorder for relevance. Only skills the candidate actually has. Typically 5-8 categories.
- **Work experience**: Exactly one entry for **every company** in the profile, same order. Never change company_name or job_title. Keep project_name as in profile or null.
  - Rewrite project_description and bullets to emphasize job-relevant skills and outcomes.
  - When **Project Evidence** is provided below, treat it as authoritative for metrics, technologies, and accomplishments. Prefer evidence over the shorter profile résumé text. Do not invent facts not supported by the profile or project evidence.
  - Each company experience must have at least 4 bullet points.
  - Rewrite my resume specifically for this job
  - Preserve factual accuracy, do not invent experience
  - Optimize for ATS keyword matching
  - Prioritize the most relevant experience
  - Rewrite bullet points to align with the job description
  - Emphasize matching technologies, architecture patterns, and domain experience
  - Keep strong measurable impact
  - Keep the tone concise, technical, and senior-level
  - Make the resume sound like a strong direct fit for the role
  - Remove or reduce less relevant content
  - Keep bullet points achievement-oriented
  - Use modern senior/staff-level resume style
  - Avoid generic buzzwords and fluff
  - Do NOT use em dashes
  - Keep bullet points concise but high impact
  - Preserve chronology and company names
  - Do not hallucinate technologies or projects"""

JOB_MATCH_PHASE_B_INSTRUCTIONS = (
    f"{PHASE_B_INTRO.strip()}\n\n"
    f"{RESUME_TAILORING_INSTRUCTIONS.strip()}\n\n"
    f"{COVER_LETTER_INSTRUCTIONS.strip()}"
)

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


def build_phase_b_system_prompt(
    resume_instructions: str,
    cover_letter_instructions: str,
) -> str:
    """Combine intro, resume instructions, cover letter instructions, and locked JSON contract."""
    resume = resume_instructions.strip() or RESUME_TAILORING_INSTRUCTIONS.strip()
    cover = cover_letter_instructions.strip() or COVER_LETTER_INSTRUCTIONS.strip()
    return f"{PHASE_B_INTRO.strip()}\n\n{resume}\n\n{cover}{JOB_MATCH_PHASE_B_OUTPUT_CONTRACT}"


JOB_MATCH_PHASE_B_SYSTEM_PROMPT = build_phase_b_system_prompt(
    RESUME_TAILORING_INSTRUCTIONS,
    COVER_LETTER_INSTRUCTIONS,
)

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

## Project Evidence (authoritative source material — use for facts and metrics; do not invent)
{project_evidence_context}

---

Generate tailored resume content and cover letter body as specified.
Include exactly one work_experience entry for EVERY company in the profile — do not skip any."""
