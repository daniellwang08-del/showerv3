import type { ProfileFormData } from '../types/profile';
import type { UserProfile } from '../types/profile';
import { isValidJobArrangement } from '../types/profile';
import { profileToForm } from '../components/ProfileForm';

function validateEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
function validateLinkedIn(s: string): boolean {
  return s.trim().length > 0 && /linkedin\.com\/in\//i.test(s);
}

function validatePhone(s: string): boolean {
  return /^[\d\s\-+()]{7,25}$/.test(s.trim());
}

function hasCompleteSkillGroup(form: ProfileFormData): boolean {
  return form.technical_skills.some((t) => t.category.trim() && t.skills.trim());
}

function meaningfulWorkRoles(form: ProfileFormData) {
  return form.work_experience.filter((w) => w.company_name.trim() && w.job_title.trim());
}

function hasAtLeastOneWorkRole(form: ProfileFormData): boolean {
  return meaningfulWorkRoles(form).length > 0;
}

/** Location + onsite/hybrid/remote on every non-empty role (used for job matching). */
function everyWorkRoleHasLocationAndArrangement(form: ProfileFormData): boolean {
  const rows = meaningfulWorkRoles(form);
  if (!rows.length) return false;
  return rows.every((w) => !!w.location?.trim() && isValidJobArrangement(w.job_type));
}

function hasCompleteEducation(form: ProfileFormData): boolean {
  return form.education.some((e) => e.university_name.trim() && e.degree.trim());
}

export type ProfileCompletionResult = {
  requiredFilled: number;
  requiredTotal: number;
  requiredPercent: number;
  missingRequired: { id: string; label: string }[];
  optionalItems: { id: string; label: string; done: boolean }[];
};

/** Scores saved profile data (server snapshot). Matches the same “complete enough to be useful” rules as the form. */
export function computeProfileCompletion(profile: UserProfile | null): ProfileCompletionResult {
  const form = profileToForm(profile);

  const requiredChecks: { id: string; label: string; ok: boolean }[] = [
    { id: 'name_first', label: 'First name', ok: !!form.name_first.trim() },
    { id: 'name_last', label: 'Last name', ok: !!form.name_last.trim() },
    { id: 'title', label: 'Professional title', ok: !!form.title.trim() },
    {
      id: 'email',
      label: 'Valid email address',
      ok: !!form.email.trim() && validateEmail(form.email),
    },
    {
      id: 'phone',
      label: 'Phone number',
      ok: !!form.phone_number.trim() && validatePhone(form.phone_number),
    },
    {
      id: 'linkedin',
      label: 'LinkedIn profile URL (linkedin.com/in/…)',
      ok: validateLinkedIn(form.linkedin_url),
    },
    { id: 'summary', label: 'Profile summary', ok: !!form.profile_summary.trim() },
    { id: 'skills', label: 'At least one technical skill group', ok: hasCompleteSkillGroup(form) },
    {
      id: 'work',
      label: 'At least one work experience entry (company & job title)',
      ok: hasAtLeastOneWorkRole(form),
    },
    {
      id: 'work_location_type',
      label: 'Each work role has location and work arrangement (remote / hybrid / onsite)',
      ok: everyWorkRoleHasLocationAndArrangement(form),
    },
    { id: 'education', label: 'At least one education entry', ok: hasCompleteEducation(form) },
  ];

  const optionalItems = [
    {
      id: 'github',
      label: 'GitHub profile',
      done: !!form.github_url.trim() && /github\.com\//i.test(form.github_url),
    },
    {
      id: 'certificates',
      label: 'Certifications',
      done: form.certificates.some((c) => c.name.trim()),
    },
    {
      id: 'extra',
      label: 'Additional notes',
      done: form.extra.some((x) => x.trim()),
    },
  ];

  const requiredFilled = requiredChecks.filter((c) => c.ok).length;
  const requiredTotal = requiredChecks.length;
  const requiredPercent = requiredTotal === 0 ? 100 : Math.round((100 * requiredFilled) / requiredTotal);
  const missingRequired = requiredChecks.filter((c) => !c.ok).map(({ id, label }) => ({ id, label }));

  return { requiredFilled, requiredTotal, requiredPercent, missingRequired, optionalItems };
}