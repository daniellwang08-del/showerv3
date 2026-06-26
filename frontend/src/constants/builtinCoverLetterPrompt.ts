/** Built-in cover letter prompt (keep in sync with app/prompts/cover_letter_prompt.py). */
export const BUILTIN_COVER_LETTER_PROMPT_INSTRUCTIONS = [
  '## Task 2 - Cover Letter',
  '',
  'Generate a professional cover letter body (3-4 short paragraphs).',
  '',
  '### Focus on the role',
  '- Anchor the letter to the specific role, company, and job description from the structured job context.',
  '- Tie relevant experience and technical skills to what the posting asks for.',
  '- Use concrete examples from the candidate profile and project evidence when available.',
  '- Prioritize overlap between job requirements and the candidate\'s background.',
  '- Do not pad with generic praise for the company.',
  '',
  '### Tone and style',
  '- Be concise, realistic, and polite.',
  '- Write like a senior engineer in their own voice, not a marketing brochure.',
  '- Sound natural and human. Avoid stiff, formulaic, or overly polished phrasing.',
  '- Never use em dashes.',
  '- Do not sound like AI-generated copy.',
  '- Avoid buzzword stacks, empty superlatives (thrilled, passionate, perfect fit), vague claims, and repetitive sentence patterns.',
  '- Prefer plain, direct sentences. One clear point per paragraph.',
  '',
  '### Output rules',
  '- Body paragraphs only. Do not include greeting, sign-off, name, or contact details.',
  '- Do not invent experience, skills, or metrics not supported by the profile or project evidence.',
  '- Keep the total length tight. Shorter is better when the fit is clear.',
].join('\n');

export const BUILTIN_COVER_LETTER_PROMPT_MAX_LENGTH = 12000;
