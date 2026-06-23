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

/** Mailing address used to auto-fill application forms (Workday etc.). */
export type AddressInfo = {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
};

/** Voluntary EEO / demographic answers. Yes/No fields are tri-state:
 *  true = yes, false = no, null/undefined = unspecified (engine default). */
export type EEOPreferences = {
  gender?: string | null;
  race?: string | null;
  hispanic_latino?: boolean | null;
  veteran_status?: boolean | null;
  disability_status?: boolean | null;
  work_authorized?: boolean | null;
  needs_sponsorship?: boolean | null;
};

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
  eeo_preferences?: EEOPreferences | Record<string, unknown> | null;
  address?: AddressInfo | Record<string, unknown> | null;
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
  eeo_preferences: EEOPreferences;
  address: AddressInfo;
};

export const JOB_TYPES = ['onsite', 'hybrid', 'remote'] as const;

/** Option lists for the EEO section selects. */
export const GENDER_OPTIONS = ['Male', 'Female', 'Non-binary', 'Decline to self-identify'] as const;
export const RACE_OPTIONS = [
  'Asian',
  'White',
  'Black or African American',
  'Hispanic or Latino',
  'Native American or Alaska Native',
  'Native Hawaiian or Other Pacific Islander',
  'Two or More Races',
  'Decline to self-identify',
] as const;

/** Normalized remote / hybrid / onsite — used for validation and profile completion. */
export function isValidJobArrangement(s: string | undefined | null): boolean {
  const v = (s ?? '').trim().toLowerCase();
  return (JOB_TYPES as readonly string[]).includes(v);
}
