export type TechnicalSkillBlock = { category: string; skills: string };
export type WorkExperienceBlock = {
  company_name: string;
  job_title: string;
  period_start?: string;
  period_end?: string;
  location?: string;
  job_type?: string;
  description?: string;
};
export type EducationBlock = {
  university_name: string;
  degree: string;
  mark?: string;
  period_start?: string;
  period_end?: string;
  location?: string;
  description?: string;
};
export type CertificateBlock = { name: string };

export type UserProfile = {
  user_id: string;
  name: string;
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
  technical_skills: TechnicalSkillBlock[] | Record<string, unknown>[];
  work_experience: WorkExperienceBlock[] | Record<string, unknown>[];
  education: EducationBlock[] | Record<string, unknown>[];
  certificates: CertificateBlock[] | Record<string, unknown>[];
  extra: string[];
  created_at: string;
  updated_at: string;
};

export type ProfileFormData = {
  name_first: string;
  name_middle: string;
  name_last: string;
  title: string;
  email: string;
  phone_country_code: string;
  phone_number: string;
  linkedin_url: string;
  github_url: string;
  profile_summary: string;
  technical_skills: TechnicalSkillBlock[];
  work_experience: WorkExperienceBlock[];
  education: EducationBlock[];
  certificates: CertificateBlock[];
  extra: string[];
};

export const JOB_TYPES = ['onsite', 'hybrid', 'remote'] as const;
