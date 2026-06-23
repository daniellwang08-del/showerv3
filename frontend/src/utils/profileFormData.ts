import type {
  ProfileFormData,
  TechnicalSkillBlock,
  WorkExperienceBlock,
  EducationBlock,
  CertificateBlock,
  EEOPreferences,
  AddressInfo,
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
export const emptyEEO = (): EEOPreferences => ({
  gender: '',
  race: '',
  hispanic_latino: null,
  veteran_status: null,
  disability_status: null,
  work_authorized: null,
  needs_sponsorship: null,
});

/** Normalize a stored tri-state yes/no value into true | false | null. */
function toTriState(v: unknown): boolean | null {
  if (v === true || v === false) return v;
  return null;
}

export const emptyAddress = (): AddressInfo => ({
  line1: '',
  line2: '',
  city: '',
  state: '',
  postal_code: '',
  country: 'United States of America',
});

function addressToForm(raw: UserProfile['address']): AddressInfo {
  const a = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const hasAny = ['line1', 'line2', 'city', 'state', 'postal_code', 'country'].some((k) => str(a[k]).trim());
  return {
    line1: str(a.line1),
    line2: str(a.line2),
    city: str(a.city),
    state: str(a.state),
    postal_code: str(a.postal_code),
    // Default country only for a brand-new (empty) address.
    country: str(a.country) || (hasAny ? '' : 'United States of America'),
  };
}

function eeoToForm(raw: UserProfile['eeo_preferences']): EEOPreferences {
  const e = (raw ?? {}) as Record<string, unknown>;
  return {
    gender: typeof e.gender === 'string' ? e.gender : '',
    race: typeof e.race === 'string' ? e.race : '',
    hispanic_latino: toTriState(e.hispanic_latino),
    veteran_status: toTriState(e.veteran_status),
    disability_status: toTriState(e.disability_status),
    work_authorized: toTriState(e.work_authorized),
    needs_sponsorship: toTriState(e.needs_sponsorship),
  };
}

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
      eeo_preferences: emptyEEO(),
      address: emptyAddress(),
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
    eeo_preferences: eeoToForm(p.eeo_preferences),
    address: addressToForm(p.address),
  };
}
