import type { SubmittedUrlItem } from '../types/ui';
import { toFiniteTimeMs } from './serverDate';

/** True when the job has a persisted applied timestamp and display name (matches API / charts). */
export function jobMarkedApplied(j: SubmittedUrlItem): boolean {
  return Boolean(j.appliedBy?.trim() && toFiniteTimeMs(j.appliedAt as unknown) != null);
}
