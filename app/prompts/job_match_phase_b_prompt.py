"""
Phase B: tailored resume content and cover letter generation (deferred after Phase A).
"""

from app.prompts.cover_letter_prompt import COVER_LETTER_INSTRUCTIONS

RESUME_TAILORING_PROMPT_MIN_LENGTH = 50
RESUME_TAILORING_PROMPT_MAX_LENGTH = 12000

_PHASE_B_SHARED_HEADER = """You are an elite resume writer and technical career strategist.
Using the job description, structured job context, match summary, candidate profile, and **Project Evidence**
(when provided), produce **two outputs** in one JSON response:

1. **Tailored Resume Content** - Task 1 below.
2. **Cover Letter** - Task 2 below.

Do NOT re-score the job match. Do NOT re-extract structured job fields.

---
"""

RESUME_TAILORING_INSTRUCTIONS = """Your goal is a **truthful, job-first resume** for THIS posting. Modern ATS platforms (Workday
HiredScore, Greenhouse, Lever, Ashby, iCIMS) parse the resume into dated roles, then rank it by how well each
job requirement is evidenced, and recruiters search it with the posting's literal terms. A skill only counts as
experience when it appears inside a dated role. A recruiter's first skim lasts seconds and keys on titles, recent
roles and numbers. Write for both readers: evidence inside the right role, the posting's exact terms, no padding.

## 1. Evidence first (non-negotiable)
- The **Role evidence map** lists, per role, the technologies the profile or Project Evidence ties to that role.
  A role's bullets, project_description and used_skills may name only technologies on its line or stated in that
  role's profile text. Technologies on the "Skills list only" line belong in technical_skills, never in a role.
- Never move a technology, project, metric or responsibility from one employer to another, and never tie a
  technology to a specific accomplishment unless the profile's line for that accomplishment names it.
- When Project Evidence lists technologies_to_emphasize for a company, use them in that company's bullets.
- A job requirement the candidate cannot support stays out. Do not hint at it with "exposure to", "familiar
  with" or adjacent wording. A credible 80% match beats an inflated 95% that fails the interview and the ATS audit.
- Company names, job titles, dates, locations and employment types are copied verbatim from the profile.

## 2. Preserve facts
- Every item under **Facts to preserve** survives with its number or scale unchanged (60%, 2M users, "large
  fleets", "across 12 teams"). Put the strongest one in a recent role's first or second bullet.
- Facts to preserve also lists leadership and quality evidence: mentoring, cross-functional collaborators,
  evaluation criteria, test coverage, dashboards, access control and audit safeguards. Keep each one, with its
  specifics (name the collaborators and criteria), unless it is irrelevant to this posting. Senior and staff
  postings weigh this evidence heavily; it is the last thing to cut, not the first.
- Keep the profile's ownership verbs in both directions: "Led" stays Led, "Contributed to" stays Contributed to.
  Never upgrade to Architected, Owned or Spearheaded, and never downgrade a lead claim.
- No invented metrics. When the profile gives no number, state the concrete result (what shipped, what it
  replaced, who used it) instead of "improving efficiency" or "measurable outcomes".

## 3. Speak the posting's language
- Use the posting's exact spelling for each item under **Job terms the candidate supports** at least once,
  inside a role that evidences it ("PostgreSQL" not "Postgres" when the posting says PostgreSQL).
- Spell out acronyms once alongside the abbreviation, in the summary or the first role that uses them:
  "Large Language Models (LLMs)". Job terms the candidate supports marks the ones to spell out.
- Mirror the posting's vocabulary, not its sentences. Never copy a run of 6 or more words from the posting:
  ATS audits flag resumes that echo the job description.

## 4. profile_summary
- 3-4 sentences, 45-75 words.
- Sentence 1: the target title family plus truthful years in the discipline the profile actually shows
  (e.g. "Senior software engineer with 8 years building backend services"). Never attach the total career
  length to a specialty the profile shows for fewer years.
- Sentences 2-3: the two or three strongest proofs for THIS job, including the best metric from Facts to preserve.
- Name at most 4 technologies, all evidenced in a dated role. No technology lists, no pitch for the hiring
  company, no "strong fit for", "passionate", "results-driven" or "proven track record".

## 5. work_experience
Profile order is most recent first. Length budget (keeps a senior resume to about two pages):
- Index 0 and 1: 6-8 bullets each. Index 2: 4-5. Older roles: 3-4. Internships and roles under a year: 2-3.
- 20-26 bullets in total. Fewer, stronger bullets beat padding; a role with thin evidence gets fewer bullets.
- Select and order bullets by relevance to THIS posting, not by profile order: for each role, rank its profile
  facts against the posting's requirements, keep the top ones, and merge related minor facts into one bullet
  rather than dropping a requirement's only evidence. Drop the facts least relevant to the posting first.
- Each bullet is one sentence of about 18-30 words: action verb + what was built or changed + how (named
  technology) + result. The first bullet of index 0 and 1 matches the posting's primary function (backend
  services for a backend role, model deployment for an ML role, pipelines for a data role, test strategy
  for a quality role), using that role's most relevant real work.
- No duplicate accomplishments across bullets or companies.
- Banned openers and filler: "Responsible for", "Worked on", "Helped", "Involved in", "Supported X by",
  "Leveraged", "Spearheaded", "Utilized", "production-oriented", "end-to-end solutions", "cutting-edge",
  "robust and scalable" as decoration, "measurable outcomes" without a number.
- project_description: one short sentence about the product or client the profile names, or empty.
- used_skills: 4-10 technologies from that role's evidence line, the posting's terms first.

## 6. technical_skills
- 4-6 categories and at most 30 items in total, only technologies the profile states somewhere. A long list
  dilutes the match: first keep every item the posting names, then the role family's core stack, and cut the rest.
- Lead with the categories and items the posting asks for.
- Place items correctly: runtimes and frameworks (Node.js, Django, React) are not Languages; managed search,
  queues and AI services are not Databases; cloud services go under Cloud.
- No soft skills, no inferred items, and methodologies (Agile, Scrum) only when the posting lists them."""

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
      {"category": "<short single-concept name, e.g. Backend>", "skills": "<plain technologies, comma and space separated>"}
    ],
    "work_experience": [
      {
        "company_name": "<string>",
        "job_title": "<string>",
        "period_start": "<string copied verbatim from profile, or empty>",
        "period_end": "<string copied verbatim from profile, or empty if current>",
        "location": "<string copied verbatim from profile, or empty>",
        "employment_type": "<string copied verbatim from profile, or empty>",
        "project_name": "<string or null>",
        "project_description": "<one sentence from the profile, or empty>",
        "used_skills": "<comma-separated technologies this role's evidence shows, or empty>",
        "bullets": ["<one sentence - 6-8 for the two most recent roles, 4-5 for the third, 3-4 for older>", ...]
      }
    ]
  },
  "cover_letter": {
    "body": "<string - paragraphs separated by \\n\\n>"
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

_PHASE_B_RESUME_HEADER = """You are an elite resume writer and technical career strategist.
Using the job description, structured job context, match summary, candidate profile, and **Project Evidence**
(when provided), produce the **Tailored Resume Content** (Task 1 below) as one JSON response.
The cover letter is written in a separate step: do not write one here.

Do NOT re-score the job match. Do NOT re-extract structured job fields.

---
"""

_COVER_LETTER_HEADER = """You are a senior engineer writing your own cover letter for a specific job.
Using the job description, structured job context, match summary, candidate profile, and **Project Evidence**
(when provided), write the **Cover Letter** (Task 2 below) as one JSON response.

---
"""

PHASE_B_RESUME_OUTPUT_CONTRACT = JOB_MATCH_PHASE_B_OUTPUT_CONTRACT.split('  "cover_letter"')[0].rstrip().rstrip(",") + "\n}"

COVER_LETTER_OUTPUT_CONTRACT = """
---

## Response Format
Return ONLY valid JSON:

{
  "cover_letter": {
    "body": "<string - paragraphs separated by \\n\\n>"
  }
}"""


# Appended after editable (possibly user-customised) instructions: the renderer depends
# on these, so they win over any conflicting wording above.
PHASE_B_FORMAT_CONTRACT = """
---

## Formatting contract (overrides any conflicting instruction above)
- Role evidence: a role's bullets, `project_description` and `used_skills` name only technologies the Role
  evidence map ties to that role. Never move work, tools or metrics between employers.
- Length: 6-8 bullets for each of the two most recent roles, 4-5 for the third, 3-4 for older roles, at most
  26 in total, chosen by relevance to the posting; `profile_summary` is 3-4 sentences and at most 75 words;
  `technical_skills` holds at most 30 items. Never pad to reach a count.
- No run of 6 or more words copied from the job description.
- `technical_skills`: 4-6 categories with short Title Case names that each name one concept (e.g. Languages,
  Frontend, Backend, Databases, Cloud, DevOps, Testing, Machine Learning, Data Processing). No "&" or "/" joins,
  no filler words (Libraries, APIs, Storage, Frameworks, Platforms, Tools & Technologies), never "Skills",
  "Other" or "Miscellaneous". Each technology appears in exactly one category.
- `technical_skills[].skills` and `used_skills`: plain text, items separated by a comma and a space, no `**`.
- `**bold**` only inside `profile_summary`, `project_description` and bullets: at most 2 spans per bullet (many bullets
  have none), only named technologies or figures, never common words or fragments of a name.
- Truthfulness: keep the profile's ownership verbs, years of experience, and skill qualifiers ("basic");
  never add tools, scale, domains, collaborators, or outcomes the profile does not state.
- Never use em dashes."""


def build_phase_b_resume_system_prompt(resume_instructions: str) -> str:
    """Resume-only Phase B system prompt (editable instructions + locked format and JSON contracts)."""
    resume = resume_instructions.strip() or RESUME_TAILORING_INSTRUCTIONS.strip()
    return f"{_PHASE_B_RESUME_HEADER}{resume}{PHASE_B_FORMAT_CONTRACT}{PHASE_B_RESUME_OUTPUT_CONTRACT}"


def build_cover_letter_system_prompt(cover_letter_instructions: str) -> str:
    """Cover-letter-only system prompt (editable instructions + locked JSON contract)."""
    cover = cover_letter_instructions.strip() or COVER_LETTER_INSTRUCTIONS.strip()
    return f"{_COVER_LETTER_HEADER}{cover}{COVER_LETTER_OUTPUT_CONTRACT}"


PHASE_B_RESUME_SYSTEM_PROMPT = build_phase_b_resume_system_prompt("")
COVER_LETTER_SYSTEM_PROMPT = build_cover_letter_system_prompt("")

# Per-candidate material comes first: it is identical across that candidate's
# jobs, so providers can serve it from the prompt-prefix cache.
COVER_LETTER_USER_TEMPLATE = """## Candidate Profile
{profile_text}

---

## Project Evidence (authoritative source material - use for facts and examples; do not invent)
{project_evidence_context}

---

## Job Description
{job_text}

---

## Structured Job (from prior analysis)
{structured_context}

---

## Company / domain cues
{company_domain_cues}

---

## Match Summary (from prior analysis)
{match_summary}

---

Write the cover letter body for THIS role. Name the hiring company and role when present above.
Return the cover letter JSON as specified."""

JOB_MATCH_PHASE_B_USER_TEMPLATE = """## Candidate Profile
{profile_text}

---

## Project Evidence (authoritative source material - use for facts, metrics, and depth; do not invent)
{project_evidence_context}

---

## Job Description
{job_text}

---

## Structured Job (from prior analysis)
{structured_context}

---

## Must-cover requirements (map into recent roles when background supports)
{must_cover_requirements}

---

## Company / domain cues
{company_domain_cues}

---

## Match Summary (from prior analysis)
{match_summary}

---

## Role evidence map (computed from the profile: the technologies each role may name)
{role_evidence_map}

---

## Facts to preserve (numbers, scale and ownership from the profile; keep them intact)
{source_facts}

---

## Job terms the candidate supports (use the posting's spelling, in the role listed)
{supported_job_terms}

---

## Execution checklist
1. List the posting's requirements (Must-cover first) and, for each, the role that truthfully evidences it.
   Requirements with no evidence stay out of the resume.
2. Put the strongest evidence in the two most recent roles; their first bullets match the posting's primary function.
   Choose and order each role's bullets by relevance to the posting, not by profile order.
3. **Rewrite** (do not lightly edit) the summary, skills and bullets so THIS job's evidenced stack dominates,
   naming in each role only the technologies its Role evidence map line allows.
4. Keep every Facts to preserve item that is relevant to the posting, with its number, specifics and ownership verb.
5. Length budget: index 0-1 get 6-8 bullets each, index 2 gets 4-5, older roles 3-4; 20-26 in total.
6. Summary: 3-4 sentences, 45-75 words, truthful years in the right discipline, one metric, at most 4 technologies.
7. Technical skills: 4-6 clean single-concept categories, at most 30 technologies from the profile, plain text, no `**`.
8. Bold sparingly with ``**double asterisks**``: at most 2 named job technologies or figures per bullet.
9. Return the tailored resume JSON as specified.

Include exactly one work_experience entry for EVERY company in the profile - do not skip any."""
