import type { SubmittedUrlItem } from '../types/ui';
import type { DashboardJob } from '../types/scraper';
import { toFiniteTimeMs } from './serverDate';

/** True when the job has a persisted applied timestamp and display name (matches API / charts). */
export function jobMarkedApplied(j: SubmittedUrlItem): boolean {
  return Boolean(j.appliedBy?.trim() && toFiniteTimeMs(j.appliedAt as unknown) != null);
}

/** Dashboard row applied state (applied_at + applied_by_name from GET /jobs/dashboard). */
export function dashboardJobMarkedApplied(
  j: Pick<DashboardJob, 'applied_at' | 'applied_by_name'>,
): boolean {
  return toFiniteTimeMs(j.applied_at) != null;
}

/** Table row surface classes: applied jobs get a persistent light-blue background. */
export function dashboardJobRowSurfaceClass(
  job: Pick<DashboardJob, 'applied_at' | 'applied_by_name'>,
  opts: { isSelected?: boolean } = {},
): string {
  const isSelected = opts.isSelected ?? false;
  const isApplied = dashboardJobMarkedApplied(job);

  if (isSelected) {
    return 'bg-blue-50 border-l-[3px] border-l-blue-500';
  }
  if (isApplied) {
    return 'bg-blue-50 border-l-[3px] border-l-sky-300 hover:bg-blue-100/60';
  }
  return 'border-l-[3px] border-l-transparent hover:bg-blue-50/30';
}

export function dashboardJobStickyCellClass(
  job: Pick<DashboardJob, 'applied_at' | 'applied_by_name'>,
  opts: { isSelected?: boolean } = {},
): string {
  const highlighted =
    (opts.isSelected ?? false) || dashboardJobMarkedApplied(job);
  return highlighted ? '!bg-blue-50 group-hover:!bg-blue-50' : 'bg-white group-hover:bg-blue-50/30';
}
