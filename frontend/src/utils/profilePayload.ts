import type { ProfileFormData } from '../types/profile';

/** Convert form state to the API PUT /profile body. */
export function profileFormToPayload(data: ProfileFormData) {
  const emptyToNull = (s: string | undefined) => (s?.trim() ? s.trim() : null);
  return {
    name_first: data.name_first.trim(),
    name_middle: emptyToNull(data.name_middle),
    name_last: data.name_last.trim(),
    title: data.title.trim(),
    email: data.email.trim(),
    phone_country_code: data.phone_country_code,
    phone_number: data.phone_number.trim(),
    linkedin_url: data.linkedin_url.trim(),
    github_url: emptyToNull(data.github_url),
    profile_summary: data.profile_summary.trim(),
    technical_skills: data.technical_skills
      .filter((t) => t.category.trim() && t.skills.trim())
      .map((t) => ({ category: t.category.trim(), skills: t.skills.trim() })),
    work_experience: data.work_experience
      .filter((w) => w.company_name.trim() && w.job_title.trim())
      .map((w) => ({
        company_name: w.company_name.trim(),
        job_title: w.job_title.trim(),
        period_start: emptyToNull(w.period_start),
        period_end: emptyToNull(w.period_end),
        location: emptyToNull(w.location),
        job_type: emptyToNull(w.job_type) || null,
        employment_type: emptyToNull(w.employment_type) || null,
        project_title: emptyToNull(w.project_title),
        project_intro: emptyToNull(w.project_intro),
        contributions: (w.contributions ?? [])
          .map((c) => c.trimEnd())
          .filter((c) => c.trim().length > 0),
        used_skills: emptyToNull(w.used_skills),
        description: emptyToNull(w.description),
      })),
    education: data.education
      .filter((e) => e.university_name.trim() && e.degree.trim())
      .map((e) => ({
        university_name: e.university_name.trim(),
        degree: e.degree.trim(),
        mark: emptyToNull(e.mark),
        period_start: emptyToNull(e.period_start),
        period_end: emptyToNull(e.period_end),
        location: emptyToNull(e.location),
        description: emptyToNull(e.description),
      })),
    certificates: data.certificates
      .filter((c) => c.name.trim())
      .map((c) => ({
        name: c.name.trim(),
        issued_at: emptyToNull(c.issued_at),
        url: emptyToNull(c.url),
      })),
    extra: data.extra.filter((x) => x.trim()),
    eeo_preferences: {
      gender: emptyToNull(data.eeo_preferences.gender ?? undefined),
      race: emptyToNull(data.eeo_preferences.race ?? undefined),
      hispanic_latino: data.eeo_preferences.hispanic_latino ?? null,
      veteran_status: data.eeo_preferences.veteran_status ?? null,
      disability_status: data.eeo_preferences.disability_status ?? null,
      work_authorized: data.eeo_preferences.work_authorized ?? null,
      needs_sponsorship: data.eeo_preferences.needs_sponsorship ?? null,
    },
    address: {
      line1: emptyToNull(data.address.line1 ?? undefined),
      line2: emptyToNull(data.address.line2 ?? undefined),
      city: emptyToNull(data.address.city ?? undefined),
      state: emptyToNull(data.address.state ?? undefined),
      postal_code: emptyToNull(data.address.postal_code ?? undefined),
      country: emptyToNull(data.address.country ?? undefined),
    },
  };
}
