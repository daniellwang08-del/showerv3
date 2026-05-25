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

  // Applied must remain visible even when the row is selected (bulk actions).
  if (isApplied && isSelected) {
    return 'bg-sky-50 border-l-[3px] border-l-sky-500 ring-1 ring-inset ring-sky-200/80';
  }
  if (isApplied) {
    return 'bg-sky-50 border-l-[3px] border-l-sky-500';
  }
  if (isSelected) {
    return 'bg-blue-50 border-l-[3px] border-l-blue-500';
  }
  return 'border-l-[3px] border-l-transparent hover:bg-blue-50/30';
}

export function dashboardJobStickyCellClass(
  job: Pick<DashboardJob, 'applied_at' | 'applied_by_name'>,
  opts: { isSelected?: boolean } = {},
): string {
  const isSelected = opts.isSelected ?? false;
  const isApplied = dashboardJobMarkedApplied(job);
  if (isApplied) return '!bg-sky-50 group-hover:!bg-sky-50';
  if (isSelected) return '!bg-blue-50 group-hover:!bg-blue-50';
  return 'bg-white group-hover:bg-blue-50/30';
}
