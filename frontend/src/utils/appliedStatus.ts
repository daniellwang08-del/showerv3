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
    return 'bg-sky-50 border-l-[3px] border-l-sky-500 ring-1 ring-inset ring-sky-200/80 dark:bg-sky-500/15 dark:ring-sky-400/30';
  }
  if (isApplied) {
    return 'bg-sky-50 border-l-[3px] border-l-sky-500 dark:bg-sky-500/15';
  }
  if (isSelected) {
    return 'bg-blue-50 border-l-[3px] border-l-blue-500 dark:bg-blue-500/15';
  }
  return 'border-l-[3px] border-l-transparent hover:bg-blue-50/30';
}

export function dashboardJobStickyCellClass(
  job: Pick<DashboardJob, 'applied_at' | 'applied_by_name'>,
  opts: { isSelected?: boolean } = {},
): string {
  const isSelected = opts.isSelected ?? false;
  const isApplied = dashboardJobMarkedApplied(job);
  // The sticky cell must stay OPAQUE (it overlays horizontally-scrolled cells). The
  // light `!bg-*-50` utilities use `!important`, which the global `.dark .bg-*-50`
  // overrides can't beat, so without an explicit dark variant the selected cell would
  // render bright light-blue over the dark table. The dark hexes match each row's tint.
  if (isApplied) return '!bg-sky-50 group-hover:!bg-sky-50 dark:!bg-[#13314d] dark:group-hover:!bg-[#13314d]';
  if (isSelected) return '!bg-blue-50 group-hover:!bg-blue-50 dark:!bg-[#192b4d] dark:group-hover:!bg-[#192b4d]';
  return 'bg-white group-hover:bg-blue-50/30';
}
