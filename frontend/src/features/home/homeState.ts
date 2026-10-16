import type { DashboardJob, ScraperStats } from '@/types/scraper';
import type { UserProfile } from '@/types/profile';
import type { UserSettings } from '@/types/settings';
import { computeProfileCompletion } from '@/utils/profileCompletion';

export type ChecklistId = 'profile' | 'preferences' | 'jobs' | 'apply';

export type ChecklistItem = {
  id: ChecklistId;
  label: string;
  hint: string;
  done: boolean;
};

export type NextStep =
  | { kind: 'onboarding' }
  | { kind: 'profile'; missing: number }
  | { kind: 'add-jobs' }
  | { kind: 'review-ready'; count: number }
  | { kind: 'review-matches'; count: number }
  | null;

export type HomeInputs = {
  profile: UserProfile | null | undefined;
  settings: UserSettings | undefined;
  stats: ScraperStats | undefined;
};

/** New accounts get an empty profile row (GET /profile is 200), so "no profile" means nothing filled in yet. */
export function isBlankProfile(profile: UserProfile | null | undefined): boolean {
  if (!profile) return true;
  return (
    !profile.name_first?.trim() &&
    !profile.name_last?.trim() &&
    !profile.title?.trim() &&
    !profile.profile_summary?.trim() &&
    (profile.work_experience?.length ?? 0) === 0
  );
}

export function profileComplete(profile: UserProfile | null | undefined): boolean {
  return !!profile && computeProfileCompletion(profile).missingRequired.length === 0;
}

export function buildChecklist({ profile, settings, stats }: HomeInputs): ChecklistItem[] {
  const missing = profile ? computeProfileCompletion(profile).missingRequired.length : null;
  return [
    {
      id: 'profile',
      label: 'Complete your profile',
      hint: missing == null ? 'Import your résumé to start' : missing ? `${missing} required field${missing === 1 ? '' : 's'} left` : 'All required fields filled',
      done: missing === 0,
    },
    {
      id: 'preferences',
      label: 'Tell NAO what you want',
      hint: 'Countries and the roles you are after',
      done: !!settings && (settings.country_preferences.length > 0 || !!settings.job_match_preferences.trim()),
    },
    {
      id: 'jobs',
      label: 'Add your first jobs',
      hint: 'Paste links or connect a job site',
      done: (stats?.total_jobs ?? 0) > 0,
    },
    {
      id: 'apply',
      label: 'Apply to a job',
      hint: 'Open a ready job and apply with the extension',
      done: (stats?.applied_jobs ?? 0) > 0,
    },
  ];
}

/** The single most useful thing to do next, in priority order. */
export function nextStep({ profile, stats }: HomeInputs, onboardingPending: boolean): NextStep {
  if (profile !== undefined && isBlankProfile(profile) && onboardingPending) return { kind: 'onboarding' };
  if (profile !== undefined) {
    const missing = profile ? computeProfileCompletion(profile).missingRequired.length : 1;
    if (missing > 0) return { kind: 'profile', missing };
  }
  if (!stats) return null;
  if ((stats.total_jobs ?? 0) === 0) return { kind: 'add-jobs' };
  if ((stats.ready_jobs ?? 0) > 0) return { kind: 'review-ready', count: stats.ready_jobs };
  // best_jobs/good_jobs include jobs already applied to; only suggest the rest.
  const good = stats.unapplied_good_jobs ?? 0;
  if (good > 0) return { kind: 'review-matches', count: good };
  return null;
}

export function appliedWithin(jobs: DashboardJob[], days: number, now = Date.now()): number {
  const since = now - days * 24 * 60 * 60 * 1000;
  return jobs.filter((j) => j.applied_at && new Date(j.applied_at).getTime() >= since).length;
}
