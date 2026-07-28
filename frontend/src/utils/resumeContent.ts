import type { ResumeContent } from '../types/resumeDesign';
import type {
  UserProfile,
  WorkExperienceBlock,
  TechnicalSkillBlock,
  EducationBlock,
  CertificateBlock,
} from '../types/profile';
import { deriveWorkContent } from './workExperience';

export const emptyContentSkill = (): ResumeContent['technical_skills'][number] => ({ category: '', skills: '' });

export const emptyContentWork = (): ResumeContent['work_experience'][number] => ({
  company_name: '',
  job_title: '',
  period_start: '',
  period_end: '',
  location: '',
  job_type: '',
  employment_type: '',
  project_title: '',
  project_intro: '',
  contributions: [''],
  used_skills: '',
  description: '',
});

export const emptyContentEducation = (): ResumeContent['education'][number] => ({
  university_name: '',
  degree: '',
  mark: '',
  period_start: '',
  period_end: '',
  location: '',
  description: '',
});

export const emptyContentCert = (): ResumeContent['certificates'][number] => ({
  name: '',
  issued_at: '',
  url: '',
});

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

type ContentWork = ResumeContent['work_experience'][number];

/**
 * Expand legacy `description` blobs into project_title / project_intro / contributions
 * so the Content editor shows the same fields the live preview derives.
 *
 * Important: when `contributions` is already an array (including blank lines), preserve it
 * as-is. The multi-line Key contributions editor relies on empty trailing lines for Enter;
 * running them through deriveWorkContent().filter(Boolean) would eat those newlines.
 */
export function normalizeContentWork(w: ContentWork | WorkExperienceBlock): ContentWork {
  const derived = deriveWorkContent(w);
  const rawContribs = Array.isArray(w.contributions)
    ? w.contributions.map((c) => (typeof c === 'string' ? c : String(c ?? '')))
    : null;
  const contributions =
    rawContribs != null
      ? rawContribs.length > 0
        ? rawContribs
        : derived.contributions.length
          ? derived.contributions
          : ['']
      : derived.contributions.length
        ? derived.contributions
        : [''];

  return {
    company_name: str(w.company_name),
    job_title: str(w.job_title),
    period_start: str(w.period_start),
    period_end: str(w.period_end),
    location: str(w.location),
    job_type: str(w.job_type),
    employment_type: str(w.employment_type),
    project_title: derived.projectTitle,
    project_intro: derived.intro,
    contributions,
    used_skills: str(w.used_skills),
    description: str(w.description),
  };
}

/** Normalize a full content override (especially work experience) for editor + preview parity. */
export function normalizeResumeContent(content: ResumeContent): ResumeContent {
  return {
    ...content,
    name_first: str(content.name_first),
    name_middle: str(content.name_middle),
    name_last: str(content.name_last),
    title: str(content.title),
    email: str(content.email),
    phone_country_code: str(content.phone_country_code),
    phone_number: str(content.phone_number),
    linkedin_url: str(content.linkedin_url),
    github_url: str(content.github_url),
    profile_summary: str(content.profile_summary),
    technical_skills: (content.technical_skills ?? []).map((s) => ({
      category: str(s.category),
      skills: str(s.skills),
    })),
    work_experience: (content.work_experience ?? []).map((w) => normalizeContentWork(w)),
    education: (content.education ?? []).map((e) => ({
      university_name: str(e.university_name),
      degree: str(e.degree),
      mark: str(e.mark),
      period_start: str(e.period_start),
      period_end: str(e.period_end),
      location: str(e.location),
      description: str(e.description),
    })),
    certificates: (content.certificates ?? []).map((c) => ({
      name: str(c.name),
      issued_at: str((c as { issued_at?: string }).issued_at),
      url: str((c as { url?: string }).url),
    })),
  };
}

/** Seed a content override from the user's master profile (used when the Content panel
 *  is opened for the first time so the editor starts pre-filled with real data). */
export function profileToContent(profile: UserProfile | null): ResumeContent {
  const p = profile;
  const skills = (p?.technical_skills ?? []) as TechnicalSkillBlock[];
  const work = (p?.work_experience ?? []) as WorkExperienceBlock[];
  const edu = (p?.education ?? []) as EducationBlock[];
  const certs = (p?.certificates ?? []) as CertificateBlock[];
  return normalizeResumeContent({
    name_first: str(p?.name_first),
    name_middle: str(p?.name_middle),
    name_last: str(p?.name_last),
    title: str(p?.title),
    email: str(p?.email),
    phone_country_code: str(p?.phone_country_code),
    phone_number: str(p?.phone_number),
    linkedin_url: str(p?.linkedin_url),
    github_url: str(p?.github_url),
    profile_summary: str(p?.profile_summary),
    technical_skills: skills.map((s) => ({ category: str(s.category), skills: str(s.skills) })),
    work_experience: work.map((w) => ({
      company_name: str(w.company_name),
      job_title: str(w.job_title),
      period_start: str(w.period_start),
      period_end: str(w.period_end),
      location: str(w.location),
      job_type: str(w.job_type),
      employment_type: str(w.employment_type),
      project_title: str(w.project_title),
      project_intro: str(w.project_intro),
      contributions: Array.isArray(w.contributions) ? w.contributions.map(str) : [],
      used_skills: str(w.used_skills),
      description: str(w.description),
    })),
    education: edu.map((e) => ({
      university_name: str(e.university_name),
      degree: str(e.degree),
      mark: str(e.mark),
      period_start: str(e.period_start),
      period_end: str(e.period_end),
      location: str(e.location),
      description: str(e.description),
    })),
    certificates: certs.map((c) => ({
      name: str(c.name),
      issued_at: str(c.issued_at),
      url: str(c.url),
    })),
  });
}

/** Overlay a content override onto a profile so the live preview reflects manual edits.
 *  Mirrors the backend overlay: scalar header fields fall back to the profile when blank;
 *  list sections are used as authored. */
export function effectiveProfile(profile: UserProfile | null, content?: ResumeContent | null): UserProfile | null {
  if (!content) return profile;
  const normalized = normalizeResumeContent(content);
  const base: UserProfile =
    profile ?? ({
      user_id: '',
      name: '',
      technical_skills: [],
      work_experience: [],
      education: [],
      certificates: [],
      extra: [],
      created_at: '',
      updated_at: '',
    } as UserProfile);
  const pick = (a: string, b: string | null | undefined) => (a.trim() ? a : b ?? '');
  return {
    ...base,
    name_first: pick(normalized.name_first, base.name_first),
    name_middle: pick(normalized.name_middle, base.name_middle),
    name_last: pick(normalized.name_last, base.name_last),
    title: pick(normalized.title, base.title),
    email: pick(normalized.email, base.email),
    phone_country_code: pick(normalized.phone_country_code, base.phone_country_code),
    phone_number: pick(normalized.phone_number, base.phone_number),
    linkedin_url: pick(normalized.linkedin_url, base.linkedin_url),
    github_url: pick(normalized.github_url, base.github_url),
    profile_summary: pick(normalized.profile_summary, base.profile_summary),
    technical_skills: normalized.technical_skills,
    work_experience: normalized.work_experience,
    education: normalized.education,
    certificates: normalized.certificates,
  };
}
