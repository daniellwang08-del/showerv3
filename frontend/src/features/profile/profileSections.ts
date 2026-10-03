import type { ProfileFormData } from '@/types/profile';
import { coerceFlexibleDate } from '@/utils/flexibleDate';
import { validateProfileForSave } from '@/utils/profileValidation';

export type FormSectionId =
  | 'basics'
  | 'summary'
  | 'skills'
  | 'experience'
  | 'education'
  | 'certifications'
  | 'additional';

export type SectionId = FormSectionId | 'documents';

export type EditorProps = {
  form: ProfileFormData;
  update: (patch: Partial<ProfileFormData>) => void;
  /** Visible error for a validation key (only once touched or after a save attempt). */
  err: (key: string) => string | undefined;
  touch: (key: string) => void;
};

export const SECTIONS: { id: SectionId; label: string }[] = [
  { id: 'basics', label: 'Basics' },
  { id: 'summary', label: 'Summary' },
  { id: 'skills', label: 'Skills' },
  { id: 'experience', label: 'Experience' },
  { id: 'education', label: 'Education' },
  { id: 'certifications', label: 'Certifications' },
  { id: 'additional', label: 'Additional' },
  { id: 'documents', label: 'Source documents' },
];

export const FORM_SECTIONS: FormSectionId[] = [
  'basics',
  'summary',
  'skills',
  'experience',
  'education',
  'certifications',
  'additional',
];

export const SECTION_LABEL: Record<SectionId, string> = Object.fromEntries(
  SECTIONS.map((s) => [s.id, s.label]),
) as Record<SectionId, string>;

export const SECTION_KEYS: Record<FormSectionId, (keyof ProfileFormData)[]> = {
  basics: [
    'name_first',
    'name_middle',
    'name_last',
    'title',
    'email',
    'phone_country_code',
    'phone_number',
    'linkedin_url',
    'github_url',
  ],
  summary: ['profile_summary'],
  skills: ['technical_skills'],
  experience: ['work_experience'],
  education: ['education'],
  certifications: ['certificates'],
  additional: ['extra'],
};

export function sectionDomId(id: SectionId): string {
  return `profile-section-${id}`;
}

/** Map a `validateProfileForSave` error key (e.g. `work_0_job_title`) to its section. */
export function sectionForErrorKey(key: string): FormSectionId {
  if (key === 'profile_summary') return 'summary';
  if (key.startsWith('skills_')) return 'skills';
  if (key.startsWith('work_')) return 'experience';
  if (key.startsWith('edu_')) return 'education';
  if (key.startsWith('cert_')) return 'certifications';
  if (key.startsWith('extra_')) return 'additional';
  return 'basics';
}

/** Completion ids from `computeProfileCompletion` → section that fixes them. */
export const COMPLETION_SECTION: Record<string, FormSectionId> = {
  name_first: 'basics',
  name_last: 'basics',
  title: 'basics',
  email: 'basics',
  phone: 'basics',
  linkedin: 'basics',
  github: 'basics',
  summary: 'summary',
  skills: 'skills',
  work: 'experience',
  work_location_type: 'experience',
  education: 'education',
  certificates: 'certifications',
  extra: 'additional',
};

export function copySections(
  target: ProfileFormData,
  source: ProfileFormData,
  sections: Iterable<FormSectionId>,
): ProfileFormData {
  const out = { ...target } as Record<keyof ProfileFormData, unknown>;
  for (const s of sections) {
    for (const k of SECTION_KEYS[s]) out[k] = source[k];
  }
  return out as ProfileFormData;
}

export function isSectionDirty(draft: ProfileFormData, saved: ProfileFormData, section: FormSectionId): boolean {
  return SECTION_KEYS[section].some((k) => JSON.stringify(draft[k]) !== JSON.stringify(saved[k]));
}

const PRESENT_RE = /^(present|current|now|ongoing)$/i;

function normalizeDate(raw: string | undefined, allowPresent: boolean): string {
  const v = (raw ?? '').trim();
  if (!v) return '';
  if (allowPresent && PRESENT_RE.test(v)) return 'Present';
  return coerceFlexibleDate(v) || v;
}

/** Canonicalize free-text dates ("Jan 2022" → "2022-01") so strict validation and the API accept them. */
export function normalizeFormDates(form: ProfileFormData): ProfileFormData {
  return {
    ...form,
    work_experience: form.work_experience.map((w) => ({
      ...w,
      period_start: normalizeDate(w.period_start, false),
      period_end: normalizeDate(w.period_end, true),
    })),
    education: form.education.map((e) => ({
      ...e,
      period_start: normalizeDate(e.period_start, false),
      period_end: normalizeDate(e.period_end, false),
    })),
    certificates: form.certificates.map((c) => ({ ...c, issued_at: normalizeDate(c.issued_at, false) })),
  };
}

export function normalizeDateInput(raw: string, allowPresent: boolean): string {
  return normalizeDate(raw, allowPresent);
}

export const MAX_CONTRIBUTIONS = 40;

/** Legacy save rules plus the server-side length limits the legacy form enforced via maxLength. */
export function validateProfile(form: ProfileFormData): Record<string, string> {
  const err = validateProfileForSave(normalizeFormDates(form));
  const max = (key: string, value: string | undefined, limit: number) => {
    if (!err[key] && (value ?? '').length > limit) err[key] = `Max ${limit.toLocaleString()} characters`;
  };
  max('name_first', form.name_first, 100);
  max('name_middle', form.name_middle, 100);
  max('name_last', form.name_last, 100);
  max('title', form.title, 200);
  form.technical_skills.forEach((t, i) => {
    max(`skills_${i}_category`, t.category, 100);
    max(`skills_${i}_skills`, t.skills, 500);
  });
  form.work_experience.forEach((w, i) => {
    max(`work_${i}_project_title`, w.project_title, 300);
    max(`work_${i}_project_intro`, w.project_intro, 2000);
    const filled = (w.contributions ?? []).filter((c) => c.trim()).length;
    if (filled > MAX_CONTRIBUTIONS) err[`work_${i}_contributions`] = `At most ${MAX_CONTRIBUTIONS} contributions`;
  });
  return err;
}
