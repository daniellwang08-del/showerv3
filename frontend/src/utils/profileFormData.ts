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
import { coerceFlexibleDate } from './flexibleDate';
import { deriveWorkContent } from './workExperience';

export const emptyTechSkill = (): TechnicalSkillBlock => ({ category: '', skills: '' });
export const emptyWorkExp = (): WorkExperienceBlock => ({
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
export const emptyEducation = (): EducationBlock => ({
  university_name: '',
  degree: '',
  mark: '',
  period_start: '',
  period_end: '',
  location: '',
  description: '',
  field_of_study: '',
});
export const emptyCert = (): CertificateBlock => ({ name: '', issued_at: '', url: '' });
export const emptyEEO = (): EEOPreferences => ({
  gender: '',
  race: '',
  sexual_orientation: '',
  hispanic_latino: null,
  veteran_status: null,
  disability_status: null,
  work_authorized: null,
  needs_sponsorship: null,
});

/** Normalize a stored tri-state yes/no value into true | false | null. */
function asRecord(x: unknown): Record<string, unknown> | null {
  return x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function asStringList(v: unknown): string[] {
  if (typeof v === 'string') return v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(v)) return [];
  return v.map((item) => (typeof item === 'string' ? item : item == null ? '' : String(item)));
}

function asObjectList(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) return [];
  return v.map((item) => asRecord(item) ?? {});
}

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
  local_preferences: [],
});

function addressToForm(raw: UserProfile['address']): AddressInfo {
  const a = asRecord(raw) ?? {};
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const hasAny = ['line1', 'line2', 'city', 'state', 'postal_code', 'country'].some((k) => str(a[k]).trim());
  const local_preferences = asStringList(a.local_preferences)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 30);
  return {
    line1: str(a.line1),
    line2: str(a.line2),
    city: str(a.city),
    state: str(a.state),
    postal_code: str(a.postal_code),
    // Default country only for a brand-new (empty) address.
    country: str(a.country) || (hasAny ? '' : 'United States of America'),
    local_preferences,
  };
}

function eeoToForm(raw: UserProfile['eeo_preferences']): EEOPreferences {
  const e = asRecord(raw) ?? {};
  return {
    gender: typeof e.gender === 'string' ? e.gender : '',
    race: typeof e.race === 'string' ? e.race : '',
    sexual_orientation: typeof e.sexual_orientation === 'string' ? e.sexual_orientation : '',
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
  const tsRows = asObjectList(p.technical_skills);
  const weRows = asObjectList(p.work_experience);
  const edRows = asObjectList(p.education);
  const certRows = asObjectList(p.certificates);
  const extraRows = asStringList(p.extra);
  const ts = tsRows.length ? tsRows : [emptyTechSkill() as unknown as Record<string, unknown>];
  const we = weRows.length ? weRows : [emptyWorkExp() as unknown as Record<string, unknown>];
  const ed = edRows.length ? edRows : [emptyEducation() as unknown as Record<string, unknown>];
  const cert = certRows.length ? certRows : [emptyCert() as unknown as Record<string, unknown>];
  const extra = extraRows.length ? extraRows : [''];
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
    technical_skills: ts.map((x) => ({
      category: asString(x.category),
      skills: asString(x.skills),
    })),
    work_experience: we.map((x) => {
      const w = {
        company_name: asString(x.company_name),
        job_title: asString(x.job_title),
        period_start: asString(x.period_start),
        period_end: asString(x.period_end),
        location: asString(x.location),
        job_type: asString(x.job_type),
        employment_type: asString(x.employment_type),
        project_title: asString(x.project_title),
        project_intro: asString(x.project_intro),
        contributions: asStringList(x.contributions),
        used_skills: asString(x.used_skills),
        description: asString(x.description),
      };
      // Older imported/AI-parsed roles packed the project title, intro, and bullets
      // into a single `description` blob with empty structured fields. Derive the
      // structured pieces (the same way the resume preview does) so the editor shows
      // real values and the view renders proper bullets instead of one raw paragraph.
      //
      // CRITICAL: only promote derived fields that still fit ProfileCreateRequest
      // limits (project_intro ≤ 2000, contributions ≤ 40). Otherwise a Preferences
      // save that round-trips the whole profile through PUT /profile 422s on
      // work_experience even though EEO itself is valid, which is exactly how
      // "Failed to save EEO preferences" appeared for profiles with long JD blobs.
      const derived = deriveWorkContent(w);
      const nextTitle = derived.projectTitle || w.project_title;
      const nextIntro = derived.intro || w.project_intro;
      const nextContribs = derived.contributions.length ? derived.contributions : [''];
      const introFits = nextIntro.length <= 2000;
      const contribsFit = nextContribs.filter((c) => c.trim()).length <= 40;
      return {
        ...w,
        project_title: nextTitle.length <= 300 ? nextTitle : w.project_title,
        project_intro: introFits ? nextIntro : w.project_intro,
        contributions: contribsFit ? nextContribs : w.contributions.length ? w.contributions : [''],
      };
    }),
    education: ed.map((x) => ({
      university_name: asString(x.university_name),
      degree: asString(x.degree),
      mark: asString(x.mark),
      period_start: asString(x.period_start),
      period_end: asString(x.period_end),
      location: asString(x.location),
      description: asString(x.description),
      field_of_study: asString(x.field_of_study),
    })),
    certificates: cert.map((x) => ({
      name: asString(x.name),
      issued_at: coerceFlexibleDate(asString(x.issued_at)),
      url: asString(x.url),
    })),
    extra,
    eeo_preferences: eeoToForm(p.eeo_preferences),
    address: addressToForm(p.address),
  };
}
