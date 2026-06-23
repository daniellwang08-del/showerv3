"""
Phase B: tailored resume content and cover letter generation (deferred after Phase A).
"""

from app.prompts.cover_letter_prompt import COVER_LETTER_INSTRUCTIONS

RESUME_TAILORING_PROMPT_MIN_LENGTH = 50
RESUME_TAILORING_PROMPT_MAX_LENGTH = 12000

_PHASE_B_SHARED_HEADER = """You are an elite resume writer and technical career strategist.
Using the job description, structured job context, match summary, candidate profile, and **Project Evidence**
(when provided), produce **two outputs** in one JSON response:

1. **Tailored Resume Content** — Task 1 below.
2. **Cover Letter** — Task 2 below.

Do NOT re-score the job match. Do NOT re-extract structured job fields.

---
"""

RESUME_TAILORING_INSTRUCTIONS = """Your goal is to produce a **strong, job-winning tailored resume** — rich in concrete impact, aligned to the posting,
and truthful to the candidate's background.

## Overall strategy

1. **Read the job first** — identify must-have skills, domain, seniority signals, and repeated keywords.
2. **Use Project Evidence as the primary source of depth** — metrics, architecture, scope, tools, outcomes.
   Fall back to the profile résumé text only when evidence is absent for that company.
3. **Mirror the job's language** — use the posting's terminology (stack, domain, role verbs) where it honestly applies.
4. **Never invent** — no fabricated employers, titles, projects, metrics, or technologies.
5. **Bullet volume (mandatory)** — profile work history order is **most recent first**:
   - **First 3 companies** (most recent roles): **at least 7 bullets each** — dense, ATS-optimized, job-keyword rich.
   - **All remaining companies**: **at least 4 bullets each**.
   - Never pad with fluff; split distinct accomplishments into separate bullets until minimums are met.

---

## ATS optimization (especially the 3 most recent roles)

For the **first 3 companies** in profile order, optimize for Applicant Tracking Systems and recruiter scans:
- Mirror **exact phrases** from the job posting (skills, tools, domain terms) where truthfully supported by evidence.
- Include **standard role keywords** (e.g. architecture, scalability, cross-functional, CI/CD, microservices) when backed by facts.
- Use **recognizable technology names** (AWS, Kubernetes, Python, PostgreSQL) — not vague substitutes.
- Lead bullets with **strong action verbs** (Architected, Led, Delivered, Optimized, Scaled, Migrated, Automated).
- Include **metrics** when available (%, $, latency, throughput, users, uptime, cost reduction, team size).
- Spell out acronyms once if uncommon, then use the acronym (e.g. "Amazon Web Services (AWS)").
- Avoid tables, graphics references, or special characters that break parsing.

---

## Keyword highlighting (renders as bold in the Word résumé)

The document builder converts ``**text**`` into **bold** formatting. Use this for ATS-critical and job-specific terms.

**Where to apply:** `profile_summary`, each `project_description`, every bullet, and job-critical skill names inside `technical_skills` skill strings (not category names).

**Rules:**
- Wrap **important job keywords** in double asterisks: e.g. ``**Python**``, ``**Kubernetes**``, ``**microservices**``, ``**CI/CD**``.
- Choose terms from the job posting / structured requirements that are **truthfully** used in that sentence.
- **3 most recent companies:** bold **3–8** high-value terms per bullet (tools, domains, methodologies, metrics labels).
- **Older companies:** bold **2–5** terms per bullet.
- Bold **specific technologies, frameworks, and domain phrases** — not whole sentences or generic words ("team", "project").
- Do not bold `company_name`, `job_title`, or `project_name` fields themselves — only in summary/description/bullets/skills text.
- Example bullet: "Architected **event-driven** pipeline on **Kafka** processing **2M events/day**, reducing latency **40%**."

---

## Task 1 — Tailored Resume Content

### Profile summary (5–7 sentences)
Write a compelling executive summary that a recruiter would skim in 10 seconds:
- Open with **years of experience + core identity** aligned to this role (e.g. "Senior backend engineer with 12+ years…").
- Name the **target domain or product type** from the job when the profile supports it.
- Highlight **3–4 top alignments** with explicit requirements from the posting (technologies, scale, leadership, domain).
- End with **value proposition** — what you bring to this specific team/company.
- Weave in keywords from the job naturally; avoid buzzword stuffing or generic filler ("hard-working team player").

### Technical skills (typically 5–8 categories)
- Create **dynamic category names** that reflect what this job cares about (e.g. "Backend & APIs", "Cloud & DevOps", not generic "Skills").
- **Reorder** skills so job-critical technologies appear first in each category.
- Include only skills the candidate **actually has** (from profile or project evidence).
- Prefer **specific tools/frameworks** over vague labels when supported by evidence.
- Omit or deprioritize skills irrelevant to this posting unless they are differentiators.

### Work experience — one entry per profile company, same order

**Immutable fields:** `company_name`, `job_title`, `project_name` (exactly as in profile, or null), and the factual `period_start`, `period_end`, `location` (copied VERBATIM from the matching profile work_experience entry — never alter, invent, or reorder these; an empty `period_end` means the role is current).

**project_description** (2–4 sentences per role):
- Describe the **business context**, **system/product scope**, and **your ownership** for that role.
- Emphasize aspects that map to this job (architecture, scale, domain, team size, constraints).
- Use Project Evidence for this company when available; otherwise use profile text.
- For highly relevant roles, be **specific and dense**; for less relevant roles, keep 1–2 focused sentences.

**bullets** — quality bar and **mandatory minimums** (this is the most important section):

**Count rules** (profile `work_experience` order = most recent first):
- Companies at **index 0, 1, 2** (three most recent): **minimum 7 bullets each** — no exceptions.
- **Every other company**: **minimum 4 bullets each** — no exceptions.
- If source material is thin for an older role, still reach 4 bullets by covering scope, ownership, tech stack, and outcomes from profile text — never invent facts.

**Quality rules (all companies; strictest for the 3 most recent):**
- Each bullet: **Strong action verb** + **what you built/did** + **how (tech/method)** + **outcome/impact**.
- **Lead with impact** when metrics exist in Project Evidence or profile (%, $, latency, throughput, users, cost, time saved).
- Weave **job requirement keywords** into bullets naturally — especially in the 3 most recent roles for ATS matching.
- Prefer **concrete nouns** (Kafka, Kubernetes, payment ledger) over vague claims ("various technologies").
- Avoid weak openers: "Responsible for", "Worked on", "Helped with", "Involved in".
- Do not duplicate the same accomplishment across bullets or companies.
- When Project Evidence lists technologies_to_emphasize for a company, reflect them in that company's bullets.
- Each bullet should be **substantive** (often 1–2 sentences) — not one-line placeholders.

**Truthfulness:** Every metric, tool, and outcome must appear in the profile or Project Evidence. If no metric exists, describe scope and outcome qualitatively — do not invent numbers."""

JOB_MATCH_PHASE_B_INSTRUCTIONS = (
    f"{_PHASE_B_SHARED_HEADER}{RESUME_TAILORING_INSTRUCTIONS.strip()}\n\n---\n\n{COVER_LETTER_INSTRUCTIONS.strip()}"
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
        "period_start": "<string copied verbatim from profile, or empty>",
        "period_end": "<string copied verbatim from profile, or empty if current>",
        "location": "<string copied verbatim from profile, or empty>",
        "project_name": "<string or null>",
        "project_description": "<string>",
        "bullets": ["<string — min 7 for 3 most recent companies, min 4 for all others>", ...]
      }
    ]
  },
  "cover_letter": {
    "body": "<string — paragraphs separated by \\n\\n>"
  }
}"""


def build_phase_b_system_prompt(
    resume_instructions: str,
    cover_letter_instructions: str = "",
) -> str:
    """Combine resume + cover letter instructions with the locked JSON output contract."""
    resume = resume_instructions.strip() or RESUME_TAILORING_INSTRUCTIONS.strip()
    cover = cover_letter_instructions.strip() or COVER_LETTER_INSTRUCTIONS.strip()
    return f"{_PHASE_B_SHARED_HEADER}{resume}\n\n---\n\n{cover}{JOB_MATCH_PHASE_B_OUTPUT_CONTRACT}"


JOB_MATCH_PHASE_B_SYSTEM_PROMPT = build_phase_b_system_prompt("", "")

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

## Project Evidence (authoritative source material — use for facts, metrics, and depth; do not invent)
{project_evidence_context}

---

## Execution checklist
1. Extract the job's top requirements and responsibilities from the sections above.
2. For each profile company, pull facts from Project Evidence first; supplement from profile only as needed.
3. Profile work order is most recent first: **first 3 companies → ≥7 ATS-strong bullets each**; **all others → ≥4 bullets each**.
4. Ensure every bullet has concrete tools, scope, and outcomes — not thin one-liners.
5. Wrap important job keywords in ``**double asterisks**`` so they render bold in the DOCX (summary, descriptions, bullets, skill lists).
6. Return tailored resume JSON and cover letter body as specified.

Include exactly one work_experience entry for EVERY company in the profile — do not skip any."""
