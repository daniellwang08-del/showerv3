import {
  type CertificateBlock,
  type EducationBlock,
  type ProfileFormData,
  type TechnicalSkillBlock,
  type WorkExperienceBlock,
  isValidJobArrangement,
} from '../types/profile';
import type { UserProfile } from '../types/profile';
import { profileToForm } from '../components/ProfileForm';

export type ResumeDraft = {
  name_first?: string | null;
  name_middle?: string | null;
  name_last?: string | null;
  title?: string | null;
  email?: string | null;
  phone_country_code?: string | null;
  phone_number?: string | null;
  linkedin_url?: string | null;
  github_url?: string | null;
  profile_summary?: string | null;
  technical_skills?: Array<{ category?: string | null; skills?: string | null }>;
  work_experience?: Array<{
    company_name?: string | null;
    job_title?: string | null;
    period_start?: string | null;
    period_end?: string | null;
    location?: string | null;
    job_type?: string | null;
    description?: string | null;
  }>;
  education?: Array<{
    university_name?: string | null;
    degree?: string | null;
    mark?: string | null;
    period_start?: string | null;
    period_end?: string | null;
    location?: string | null;
    description?: string | null;
  }>;
  certificates?: Array<{ name?: string | null }>;
  extra?: string[];
};

export type ResumeConflict = { id: string; label: string; currentPreview: string; proposedPreview: string };

function hasCompleteSkillRow(t: TechnicalSkillBlock): boolean {
  return !!(t.category?.trim() && t.skills?.trim());
}

function hasCompleteWorkRow(w: WorkExperienceBlock): boolean {
  return !!(
    w.company_name?.trim() &&
    w.job_title?.trim() &&
    w.location?.trim() &&
    isValidJobArrangement(w.job_type)
  );
}

function hasCompleteEduRow(e: EducationBlock): boolean {
  return !!(e.university_name?.trim() && e.degree?.trim());
}

function hasMeaningfulSkills(form: ProfileFormData): boolean {
  return form.technical_skills.some(hasCompleteSkillRow);
}

function hasMeaningfulWork(form: ProfileFormData): boolean {
  return form.work_experience.some(hasCompleteWorkRow);
}

function hasMeaningfulEducation(form: ProfileFormData): boolean {
  return form.education.some(hasCompleteEduRow);
}

function hasMeaningfulCerts(form: ProfileFormData): boolean {
  return form.certificates.some((c) => c.name?.trim());
}

function hasMeaningfulExtra(form: ProfileFormData): boolean {
  return form.extra.some((x) => x.trim());
}

export function draftToFormPartial(draft: ResumeDraft, accountEmail: string | undefined): Partial<ProfileFormData> {
  const pick = (v: string | null | undefined) => (v != null && String(v).trim() ? String(v).trim() : undefined);

  const skills: TechnicalSkillBlock[] = (draft.technical_skills ?? [])
    .map((s) => ({
      category: pick(s.category) ?? '',
      skills: pick(s.skills) ?? '',
    }))
    .filter((s) => s.category || s.skills);

  const work: WorkExperienceBlock[] = (draft.work_experience ?? [])
    .map((w) => ({
      company_name: pick(w.company_name) ?? '',
      job_title: pick(w.job_title) ?? '',
      period_start: pick(w.period_start) ?? '',
      period_end: pick(w.period_end) ?? '',
      location: pick(w.location) ?? '',
      job_type: pick(w.job_type) ?? '',
      description: pick(w.description) ?? '',
    }))
    .filter((w) => w.company_name || w.job_title);

  const education: EducationBlock[] = (draft.education ?? [])
    .map((e) => ({
      university_name: pick(e.university_name) ?? '',
      degree: pick(e.degree) ?? '',
      mark: pick(e.mark) ?? '',
      period_start: pick(e.period_start) ?? '',
      period_end: pick(e.period_end) ?? '',
      location: pick(e.location) ?? '',
      description: pick(e.description) ?? '',
    }))
    .filter((e) => e.university_name || e.degree);

  const certificates: CertificateBlock[] = (draft.certificates ?? [])
    .map((c) => ({ name: pick(c.name) ?? '' }))
    .filter((c) => c.name);

  const extra = (draft.extra ?? []).map((x) => String(x).trim()).filter(Boolean);

  const emailFromDraft = pick(draft.email);
  const email = emailFromDraft || (accountEmail?.trim() ? accountEmail.trim().toLowerCase() : undefined);

  const partial: Partial<ProfileFormData> = {};
  if (pick(draft.name_first) !== undefined) partial.name_first = pick(draft.name_first)!;
  if (pick(draft.name_middle) !== undefined) partial.name_middle = pick(draft.name_middle)!;
  if (pick(draft.name_last) !== undefined) partial.name_last = pick(draft.name_last)!;
  if (pick(draft.title) !== undefined) partial.title = pick(draft.title)!;
  if (email !== undefined) partial.email = email;
  if (pick(draft.phone_country_code) !== undefined) partial.phone_country_code = pick(draft.phone_country_code)!;
  if (pick(draft.phone_number) !== undefined) partial.phone_number = pick(draft.phone_number)!;
  if (pick(draft.linkedin_url) !== undefined) partial.linkedin_url = pick(draft.linkedin_url)!;
  if (pick(draft.github_url) !== undefined) partial.github_url = pick(draft.github_url)!;
  if (pick(draft.profile_summary) !== undefined) partial.profile_summary = pick(draft.profile_summary)!;
  if (skills.length) partial.technical_skills = skills;
  if (work.length) partial.work_experience = work;
  if (education.length) partial.education = education;
  if (certificates.length) partial.certificates = certificates;
  if (extra.length) partial.extra = extra;

  return partial;
}

function previewSnippet(s: string, max = 80): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t) return '—';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Fields that would be overwritten if we applied replace while current has data. */
export function detectResumeConflicts(current: ProfileFormData, proposedPartial: Partial<ProfileFormData>): ResumeConflict[] {
  const conflicts: ResumeConflict[] = [];

  const checkScalar = (id: keyof ProfileFormData, label: string) => {
    const cv = String(current[id] ?? '').trim();
    const pv = String(proposedPartial[id] ?? '').trim();
    if (!cv || !pv) return;
    if (cv !== pv) {
      conflicts.push({ id: String(id), label, currentPreview: previewSnippet(cv), proposedPreview: previewSnippet(pv) });
    }
  };

  checkScalar('name_first', 'First name');
  checkScalar('name_middle', 'Middle name');
  checkScalar('name_last', 'Last name');
  checkScalar('title', 'Professional title');
  checkScalar('email', 'Email');
  checkScalar('phone_country_code', 'Phone country code');
  checkScalar('phone_number', 'Phone number');
  checkScalar('linkedin_url', 'LinkedIn');
  checkScalar('github_url', 'GitHub');
  checkScalar('profile_summary', 'Profile summary');

  if (hasMeaningfulSkills(current) && proposedPartial.technical_skills?.length) {
    const ca = JSON.stringify(current.technical_skills.filter(hasCompleteSkillRow));
    const pa = JSON.stringify(proposedPartial.technical_skills!.filter(hasCompleteSkillRow));
    if (ca !== pa) {
      conflicts.push({
        id: 'technical_skills',
        label: 'Technical skills',
        currentPreview: `${current.technical_skills.filter(hasCompleteSkillRow).length} group(s)`,
        proposedPreview: `${proposedPartial.technical_skills!.filter(hasCompleteSkillRow).length} group(s)`,
      });
    }
  }

  if (hasMeaningfulWork(current) && proposedPartial.work_experience?.length) {
    const ca = JSON.stringify(current.work_experience.filter(hasCompleteWorkRow));
    const pa = JSON.stringify(proposedPartial.work_experience!.filter(hasCompleteWorkRow));
    if (ca !== pa) {
      conflicts.push({
        id: 'work_experience',
        label: 'Work experience',
        currentPreview: `${current.work_experience.filter(hasCompleteWorkRow).length} role(s)`,
        proposedPreview: `${proposedPartial.work_experience!.filter(hasCompleteWorkRow).length} role(s)`,
      });
    }
  }

  if (hasMeaningfulEducation(current) && proposedPartial.education?.length) {
    const ca = JSON.stringify(current.education.filter(hasCompleteEduRow));
    const pa = JSON.stringify(proposedPartial.education!.filter(hasCompleteEduRow));
    if (ca !== pa) {
      conflicts.push({
        id: 'education',
        label: 'Education',
        currentPreview: `${current.education.filter(hasCompleteEduRow).length} entr(y/ies)`,
        proposedPreview: `${proposedPartial.education!.filter(hasCompleteEduRow).length} entr(y/ies)`,
      });
    }
  }

  if (hasMeaningfulCerts(current) && proposedPartial.certificates?.length) {
    const ca = JSON.stringify(current.certificates.filter((c) => c.name.trim()));
    const pa = JSON.stringify(proposedPartial.certificates!.filter((c) => c.name.trim()));
    if (ca !== pa) {
      conflicts.push({
        id: 'certificates',
        label: 'Certifications',
        currentPreview: `${current.certificates.filter((c) => c.name.trim()).length} cert(s)`,
        proposedPreview: `${proposedPartial.certificates!.filter((c) => c.name.trim()).length} cert(s)`,
      });
    }
  }

  if (hasMeaningfulExtra(current) && proposedPartial.extra?.length) {
    const ca = current.extra.filter((x) => x.trim()).join(' | ');
    const pa = proposedPartial.extra!.filter((x) => x.trim()).join(' | ');
    if (ca !== pa) {
      conflicts.push({
        id: 'extra',
        label: 'Additional notes',
        currentPreview: previewSnippet(ca, 60),
        proposedPreview: previewSnippet(pa, 60),
      });
    }
  }

  return conflicts;
}

export function mergeResumeImport(
  currentProfile: UserProfile | null,
  draft: ResumeDraft,
  accountEmail: string | undefined,
  mode: 'empty_only' | 'replace',
): ProfileFormData {
  const base = profileToForm(currentProfile);
  const partial = draftToFormPartial(draft, accountEmail);

  const mergeScalar = (key: keyof ProfileFormData): string => {
    const c = String(base[key] ?? '').trim();
    const p = partial[key as keyof typeof partial];
    const pv = typeof p === 'string' ? p.trim() : '';
    if (mode === 'replace') return pv || c;
    return c || pv;
  };

  const out: ProfileFormData = {
    ...base,
    name_first: mergeScalar('name_first'),
    name_middle: mergeScalar('name_middle'),
    name_last: mergeScalar('name_last'),
    title: mergeScalar('title'),
    email: mergeScalar('email'),
    phone_country_code: (() => {
      const c = base.phone_country_code?.trim() || '+1';
      const p = partial.phone_country_code?.trim();
      if (mode === 'replace') return p || c;
      return c !== '+1' || !p ? (c !== '+1' ? c : p || c) : p || c;
    })(),
    phone_number: mergeScalar('phone_number'),
    linkedin_url: mergeScalar('linkedin_url'),
    github_url: mergeScalar('github_url'),
    profile_summary: mergeScalar('profile_summary'),
  };

  const mergeList = <T>(hasCurrent: boolean, currentList: T[], draftList: T[] | undefined, draftHas: boolean): T[] => {
    if (!draftHas || !draftList?.length) return currentList;
    if (mode === 'replace') return draftList;
    if (!hasCurrent) return draftList;
    return currentList;
  };

  out.technical_skills = mergeList(
    hasMeaningfulSkills(base),
    base.technical_skills,
    partial.technical_skills,
    !!(partial.technical_skills && partial.technical_skills.length > 0),
  );

  out.work_experience = mergeList(
    hasMeaningfulWork(base),
    base.work_experience,
    partial.work_experience,
    !!(partial.work_experience && partial.work_experience.length > 0),
  );

  out.education = mergeList(
    hasMeaningfulEducation(base),
    base.education,
    partial.education,
    !!(partial.education && partial.education.length > 0),
  );

  out.certificates = mergeList(
    hasMeaningfulCerts(base),
    base.certificates,
    partial.certificates,
    !!(partial.certificates && partial.certificates.length > 0),
  );

  if (partial.extra && partial.extra.length > 0) {
    if (mode === 'replace' || !hasMeaningfulExtra(base)) {
      out.extra = partial.extra.length ? partial.extra : [''];
    } else {
      out.extra = base.extra;
    }
  } else {
    out.extra = base.extra;
  }

  if (!out.phone_country_code?.trim()) out.phone_country_code = '+1';
  if (!out.extra?.length) out.extra = [''];

  return out;
}
