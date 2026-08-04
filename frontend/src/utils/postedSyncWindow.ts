/**
 * Shared posted-date window for Job fetch (dashboard) and Job Sync (settings).
 * One source of truth so Sync all / manual date sync cannot diverge.
 */

export const POSTED_SYNC_WINDOW_KEY = 'scraper_sync_posted_window_v1';
export const POSTED_SYNC_WINDOW_EVENT = 'scraper:posted-sync-window';
export const JOB_SYNC_SCHEDULE_UPDATED_EVENT = 'scraper:job-sync-schedule-updated';

export type PostedSyncWindow = { since: string; until: string };

export function readPostedSyncWindow(): PostedSyncWindow {
  try {
    const raw = sessionStorage.getItem(POSTED_SYNC_WINDOW_KEY);
    if (!raw) return { since: '', until: '' };
    const parsed = JSON.parse(raw) as { since?: string; until?: string };
    return {
      since: typeof parsed.since === 'string' ? parsed.since : '',
      until: typeof parsed.until === 'string' ? parsed.until : '',
    };
  } catch {
    return { since: '', until: '' };
  }
}

export function writePostedSyncWindow(value: PostedSyncWindow): void {
  try {
    sessionStorage.setItem(POSTED_SYNC_WINDOW_KEY, JSON.stringify(value));
  } catch {
    /* ignore quota / private mode */
  }
  if (typeof globalThis !== 'undefined' && 'dispatchEvent' in globalThis) {
    globalThis.dispatchEvent(
      new CustomEvent(POSTED_SYNC_WINDOW_EVENT, { detail: value }),
    );
  }
}

export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function formatPostedWindowShort(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
