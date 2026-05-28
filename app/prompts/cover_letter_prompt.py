"""Default instructions for AI cover letter body generation (Phase B, Task 2)."""

COVER_LETTER_PROMPT_MIN_LENGTH = 50
COVER_LETTER_PROMPT_MAX_LENGTH = 12000

_COVER_LETTER_LINES = (
    "## Task 2 — Cover Letter",
    "",
    "Generate a complete, professional cover letter body — greeting, paragraphs, and sign-off — as a single string with paragraphs separated by blank lines (`\\n\\n`).",
    "",
    "### Required structure (exact order)",
    "1. Greeting line: `Hi Hiring Manager,`",
    "2. 3-4 short body paragraphs anchored to the role.",
    "3. Sign-off block: `Best regards,` then a newline (`\\n`) then the candidate's full name from the profile (e.g. `Best regards,\\nJane Doe`).",
    "",
    "Use `\\n\\n` between the greeting, each body paragraph, and the sign-off block. Use a single `\\n` only inside the sign-off, between `Best regards,` and the name.",
    "",
    "### Focus on the role",
    "- Anchor the letter to the specific role, company, and job description from the structured job context.",
    "- Tie relevant experience and technical skills to what the posting asks for.",
    "- Use concrete examples from the candidate profile and project evidence when available.",
    "- Prioritize overlap between job requirements and the candidate's background.",
    "- Do not pad with generic praise for the company.",
    "",
    "### Tone and style",
    "- Be concise, realistic, and polite.",
    "- Write like a senior engineer in their own voice, not a marketing brochure.",
    "- Sound natural and human. Avoid stiff, formulaic, or overly polished phrasing.",
    "- Never use em dashes.",
    "- Do not sound like AI-generated copy.",
    "- Avoid buzzword stacks, empty superlatives (thrilled, passionate, perfect fit), vague claims, and repetitive sentence patterns.",
    "- Prefer plain, direct sentences. One clear point per paragraph.",
    "",
    "### Output rules",
    "- Start with the greeting, end with the sign-off block. Do not include the candidate's contact details, address, the company address, or the date — those live in the template's letterhead.",
    "- The sign-off name MUST be the candidate's actual full name from the profile (first + last). Do not use placeholders like `[Name]`.",
    "- Do not invent experience, skills, or metrics not supported by the profile or project evidence.",
    "- Keep the total length tight. Shorter is better when the fit is clear.",
)

COVER_LETTER_INSTRUCTIONS = "\n".join(_COVER_LETTER_LINES)


def get_cover_letter_prompt_defaults() -> dict[str, int | str]:
    return {
        "default_instructions": COVER_LETTER_INSTRUCTIONS.strip(),
        "max_length": COVER_LETTER_PROMPT_MAX_LENGTH,
        "min_length": COVER_LETTER_PROMPT_MIN_LENGTH,
    }
