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

const ROW_SELECTED =
  'bg-blue-50 border-l-[3px] border-l-blue-500 dark:bg-blue-500/15';
const ROW_IDLE =
  'border-l-[3px] border-l-transparent hover:bg-blue-50/70 dark:hover:bg-white/[0.06]';

/**
 * Table row surface classes.
 * Applied state is shown via the Status squares column (not a full-row tint),
 * so only selection gets a row highlight. Hover paints through normal (non-sticky) cells.
 */
export function dashboardJobRowSurfaceClass(
  _job: Pick<DashboardJob, 'applied_at' | 'applied_by_name'>,
  opts: { isSelected?: boolean } = {},
): string {
  return opts.isSelected ? ROW_SELECTED : ROW_IDLE;
}
