import type {
  ProfileFormData,
  TechnicalSkillBlock,
  WorkExperienceBlock,
  EducationBlock,
  CertificateBlock,
  UserProfile,
} from '../types/profile';

export const emptyTechSkill = (): TechnicalSkillBlock => ({ category: '', skills: '' });
export const emptyWorkExp = (): WorkExperienceBlock => ({
  company_name: '',
  job_title: '',
  period_start: '',
  period_end: '',
  location: '',
  job_type: '',
  description: '',
});
export const emptyEducation = (): EducationBlock => ({
  university_name: '',
  degree: '',
  mark: '',
  period_start: '',
  period_end: '',
  location: '',
  description: '',
});
export const emptyCert = (): CertificateBlock => ({ name: '' });

export function profileToForm(p: UserProfile | null): ProfileFormData {
  if (!p) {
    return {
      name_first: '',
      name_middle: '',
      name_last: '',
      title: '',
      email: '',
      phone_country_code: '+1',
      phone_number: '',
      linkedin_url: '',
      github_url: '',
      profile_summary: '',
      technical_skills: [emptyTechSkill()],
      work_experience: [emptyWorkExp()],
      education: [emptyEducation()],
      certificates: [emptyCert()],
      extra: [''],
    };
  }
  const ts = (p.technical_skills?.length ? p.technical_skills : [emptyTechSkill()]) as TechnicalSkillBlock[];
  const we = (p.work_experience?.length ? p.work_experience : [emptyWorkExp()]) as WorkExperienceBlock[];
  const ed = (p.education?.length ? p.education : [emptyEducation()]) as EducationBlock[];
  const cert = (p.certificates?.length ? p.certificates : [emptyCert()]) as CertificateBlock[];
  const extra = p.extra?.length ? p.extra : [''];
  return {
    name_first: p.name_first ?? '',
    name_middle: p.name_middle ?? '',
    name_last: p.name_last ?? '',
    title: p.title ?? '',
    email: p.email ?? '',
    phone_country_code: p.phone_country_code ?? '+1',
    phone_number: p.phone_number ?? '',
    linkedin_url: p.linkedin_url ?? '',
    github_url: p.github_url ?? '',
    profile_summary: p.profile_summary ?? '',
    technical_skills: ts.map((x) => ({ category: (x as TechnicalSkillBlock).category ?? '', skills: (x as TechnicalSkillBlock).skills ?? '' })),
    work_experience: we.map((x) => ({
      company_name: (x as WorkExperienceBlock).company_name ?? '',
      job_title: (x as WorkExperienceBlock).job_title ?? '',
      period_start: (x as WorkExperienceBlock).period_start ?? '',
      period_end: (x as WorkExperienceBlock).period_end ?? '',
      location: (x as WorkExperienceBlock).location ?? '',
      job_type: (x as WorkExperienceBlock).job_type ?? '',
      description: (x as WorkExperienceBlock).description ?? '',
    })),
    education: ed.map((x) => ({
      university_name: (x as EducationBlock).university_name ?? '',
      degree: (x as EducationBlock).degree ?? '',
      mark: (x as EducationBlock).mark ?? '',
      period_start: (x as EducationBlock).period_start ?? '',
      period_end: (x as EducationBlock).period_end ?? '',
      location: (x as EducationBlock).location ?? '',
      description: (x as EducationBlock).description ?? '',
    })),
    certificates: cert.map((x) => ({ name: (x as CertificateBlock).name ?? '' })),
    extra,
  };
}
