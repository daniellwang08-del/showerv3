import type { ResumeContent } from '../types/resumeDesign';
import type {
  UserProfile,
  WorkExperienceBlock,
  TechnicalSkillBlock,
  EducationBlock,
  CertificateBlock,
} from '../types/profile';

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

export const emptyContentCert = (): ResumeContent['certificates'][number] => ({ name: '' });

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Seed a content override from the user's master profile (used when the Content panel
 *  is opened for the first time so the editor starts pre-filled with real data). */
export function profileToContent(profile: UserProfile | null): ResumeContent {
  const p = profile;
  const skills = (p?.technical_skills ?? []) as TechnicalSkillBlock[];
  const work = (p?.work_experience ?? []) as WorkExperienceBlock[];
  const edu = (p?.education ?? []) as EducationBlock[];
  const certs = (p?.certificates ?? []) as CertificateBlock[];
  return {
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
      contributions: Array.isArray(w.contributions) ? w.contributions.map(str).filter((c) => c.length > 0) : [],
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
    certificates: certs.map((c) => ({ name: str(c.name) })),
  };
}

/** Overlay a content override onto a profile so the live preview reflects manual edits.
 *  Mirrors the backend overlay: scalar header fields fall back to the profile when blank;
 *  list sections are used as authored. */
export function effectiveProfile(profile: UserProfile | null, content?: ResumeContent | null): UserProfile | null {
  if (!content) return profile;
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
    name_first: pick(content.name_first, base.name_first),
    name_middle: pick(content.name_middle, base.name_middle),
    name_last: pick(content.name_last, base.name_last),
    title: pick(content.title, base.title),
    email: pick(content.email, base.email),
    phone_country_code: pick(content.phone_country_code, base.phone_country_code),
    phone_number: pick(content.phone_number, base.phone_number),
    linkedin_url: pick(content.linkedin_url, base.linkedin_url),
    github_url: pick(content.github_url, base.github_url),
    profile_summary: pick(content.profile_summary, base.profile_summary),
    technical_skills: content.technical_skills,
    work_experience: content.work_experience,
    education: content.education,
    certificates: content.certificates,
  };
}
