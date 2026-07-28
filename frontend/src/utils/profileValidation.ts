import type { ProfileFormData } from '../types/profile';
import { isValidJobArrangement } from '../types/profile';
import { isFlexibleDateAfter, parseFlexibleDate } from './flexibleDate';

function validateEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function validateLinkedIn(s: string): boolean {
  return s.trim().length > 0 && /linkedin\.com\/in\//i.test(s);
}

function validateGitHub(s: string): boolean {
  if (!s.trim()) return true;
  return /github\.com\//i.test(s);
}

function validatePhone(s: string): boolean {
  return /^[\d\s\-+()]{7,25}$/.test(s.trim());
}

/** Client-side checks aligned with profile save / server validation. */
export function validateProfileForSave(form: ProfileFormData): Record<string, string> {
  const err: Record<string, string> = {};
  if (!form.name_first.trim()) err.name_first = 'First name is required';
  if (!form.name_last.trim()) err.name_last = 'Last name is required';
  if (!form.title.trim()) err.title = 'Title is required';
  if (!form.email.trim()) err.email = 'Email is required';
  else if (!validateEmail(form.email)) err.email = 'Invalid email format';
  if (!form.phone_country_code.trim()) err.phone_country_code = 'Phone country code is required';
  if (!form.phone_number.trim()) err.phone_number = 'Phone number is required';
  else if (!validatePhone(form.phone_number)) err.phone_number = 'Use 7–25 digits/spaces/+-()';
  if (!form.linkedin_url.trim()) err.linkedin_url = 'LinkedIn URL is required';
  else if (!validateLinkedIn(form.linkedin_url)) err.linkedin_url = 'Use a profile URL (linkedin.com/in/…)';
  if (form.github_url.trim() && !validateGitHub(form.github_url)) err.github_url = 'Use a GitHub URL (github.com/…)';
  if (!form.profile_summary.trim()) err.profile_summary = 'Profile summary is required';
  else if (form.profile_summary.length > 5000) err.profile_summary = 'Max 5,000 characters';

  form.technical_skills.forEach((t, i) => {
    const c = t.category.trim();
    const sk = t.skills.trim();
    if (c && !sk) err[`skills_${i}_skills`] = 'Add skills or clear the category';
    if (!c && sk) err[`skills_${i}_category`] = 'Add a category or clear skills';
  });

  form.work_experience.forEach((w, i) => {
    const co = w.company_name.trim();
    const jt = w.job_title.trim();
    if (co && !jt) err[`work_${i}_job_title`] = 'Job title is required when company is set';
    if (!co && jt) err[`work_${i}_company_name`] = 'Company is required when job title is set';
    // Location and work arrangement are optional (profile-strength suggestions), not save blockers.
    const arrangement = (w.job_type ?? '').trim();
    if (arrangement && !isValidJobArrangement(arrangement)) {
      err[`work_${i}_job_type`] = 'Choose remote, hybrid, or onsite';
    }
    const ps = (w.period_start ?? '').trim();
    const pe = (w.period_end ?? '').trim();
    const peIsPresent = !pe || /^(present|current|now|ongoing)$/i.test(pe);
    if (ps && !parseFlexibleDate(ps)) err[`work_${i}_period_start`] = 'Pick a valid start date';
    if (pe && !peIsPresent && !parseFlexibleDate(pe)) err[`work_${i}_period_end`] = 'Pick a valid end date';
    if (ps && pe && !peIsPresent && parseFlexibleDate(ps) && parseFlexibleDate(pe) && isFlexibleDateAfter(ps, pe)) {
      err[`work_${i}_period_end`] = 'End date must be after start';
    }
  });

  form.education.forEach((ed, i) => {
    const u = ed.university_name.trim();
    const d = ed.degree.trim();
    if (u && !d) err[`edu_${i}_degree`] = 'Degree is required when university is set';
    if (!u && d) err[`edu_${i}_university`] = 'University is required when degree is set';
    const ps = (ed.period_start ?? '').trim();
    const pe = (ed.period_end ?? '').trim();
    if (ps && !parseFlexibleDate(ps)) err[`edu_${i}_period_start`] = 'Pick a valid start date';
    if (pe && !parseFlexibleDate(pe)) err[`edu_${i}_period_end`] = 'Pick a valid end date';
    if (ps && pe && parseFlexibleDate(ps) && parseFlexibleDate(pe) && isFlexibleDateAfter(ps, pe)) {
      err[`edu_${i}_period_end`] = 'End date must be after start';
    }
  });

  form.extra.forEach((line, i) => {
    if (line.length > 500) err[`extra_${i}`] = 'Max 500 characters per line';
  });

  form.certificates.forEach((c, i) => {
    if ((c.name?.length ?? 0) > 200) err[`cert_${i}_name`] = 'Max 200 characters';
    const issued = (c.issued_at ?? '').trim();
    if (issued.length > 40) err[`cert_${i}_issued_at`] = 'Max 40 characters';
    else if (issued && !parseFlexibleDate(issued)) err[`cert_${i}_issued_at`] = 'Pick a valid issue date';
    const url = (c.url ?? '').trim();
    if (url.length > 500) err[`cert_${i}_url`] = 'Max 500 characters';
    else if (url && !/^https?:\/\//i.test(url) && !/^[a-z0-9.-]+\.[a-z]{2,}/i.test(url)) {
      err[`cert_${i}_url`] = 'Enter a valid URL';
    }
  });

  return err;
}

const FIELD_LABELS: Record<string, string> = {
  name_first: 'First name',
  name_last: 'Last name',
  title: 'Professional title',
  email: 'Email',
  phone_country_code: 'Phone country code',
  phone_number: 'Phone number',
  linkedin_url: 'LinkedIn',
  github_url: 'GitHub',
  profile_summary: 'Profile summary',
};

function fieldLabel(key: string): string {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  const work = key.match(/^work_(\d+)_job_type$/);
  if (work) return `Work role ${Number(work[1]) + 1} arrangement`;
  const workLoc = key.match(/^work_(\d+)_location$/);
  if (workLoc) return `Work role ${Number(workLoc[1]) + 1} location`;
  return key.replace(/_/g, ' ');
}

export function formatProfileValidationSummary(errors: Record<string, string>, max = 4): string {
  const entries = Object.entries(errors);
  if (!entries.length) return '';
  const parts = entries.slice(0, max).map(([key, msg]) => {
    const label = fieldLabel(key);
    return `${label}: ${msg}`;
  });
  const more = entries.length > max ? ` (+${entries.length - max} more)` : '';
  return `Could not save imported résumé. Fix these fields in Profile details below: ${parts.join('; ')}${more}`;
}
