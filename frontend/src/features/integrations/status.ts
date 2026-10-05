import type { JobSiteConnection, JobSitePlugin } from '@/api/jobSitesApi';
import type { SheetsConfig, SheetsStatus } from '@/types/googleSheets';
import type { PumbleConfig, PumbleStatus } from '@/types/pumble';

export type StatusKind = 'connected' | 'attention' | 'off' | 'not_connected' | 'unavailable';

export interface IntegrationStatus {
  kind: StatusKind;
  /** One short line under the card description (sync info, error, reason). */
  detail?: string;
}

export const STATUS_LABEL: Record<StatusKind, string> = {
  connected: 'Connected',
  attention: 'Needs attention',
  off: 'Off',
  not_connected: 'Not connected',
  unavailable: 'Unavailable',
};

export const DEFAULT_AUTO_POST_THRESHOLD = 75;

export function errorDetail(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const detail = (err as { response?: { data?: { detail?: unknown } } }).response?.data?.detail;
    if (typeof detail === 'string' && detail.trim()) return detail;
  }
  return fallback;
}

/** Backend timestamps are naive UTC; treat a missing zone as UTC. */
export function parseServerDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(iso);
  const date = new Date(hasZone ? iso : `${iso}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function relativeTime(iso: string | null | undefined, now = Date.now()): string | null {
  const date = parseServerDate(iso);
  if (!date) return null;
  const mins = Math.floor((now - date.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

export function syncSummary(connection: JobSiteConnection, now = Date.now()): string {
  const when = relativeTime(connection.last_synced_at, now);
  const parts = [when ? `Synced ${when}` : 'Not synced yet'];
  if (connection.last_listing_count != null) {
    parts.push(`${connection.last_listing_count} listing${connection.last_listing_count === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}

export function jobSiteStatus(plugin: JobSitePlugin, connection: JobSiteConnection | undefined): IntegrationStatus {
  if (!plugin.connectable) {
    return { kind: 'unavailable', detail: plugin.unavailable_reason || 'Not available right now' };
  }
  if (!connection) return { kind: 'not_connected' };
  const state = connection.status ?? 'connected';
  if (state === 'needs_reauth') {
    return { kind: 'attention', detail: `Sign in again to resume syncing · ${connection.last_error ?? 'Session expired'}` };
  }
  if (state === 'quota_exhausted' || state === 'rate_limited') {
    const resume = resumeLabel(connection.next_sync_at);
    const reason = state === 'quota_exhausted' ? 'Request limit reached' : 'Rate limited by the site';
    return {
      kind: 'attention',
      detail: resume ? `${reason} · resumes ${resume}` : `${reason} · ${connection.last_error ?? 'new key needed'}`,
    };
  }
  if (connection.last_error) return { kind: 'attention', detail: connection.last_error };
  if (!connection.enabled) return { kind: 'off', detail: `Auto-sync paused · ${syncSummary(connection)}` };
  return { kind: 'connected', detail: syncSummary(connection) };
}

/** "in 3h", "in 2d", or a date; null when there is no scheduled time. */
export function resumeLabel(iso: string | null | undefined, now = Date.now()): string | null {
  const date = parseServerDate(iso);
  if (!date) return null;
  const mins = Math.ceil((date.getTime() - now) / 60000);
  if (mins <= 1) return 'shortly';
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `in ${hrs}h`;
  return `on ${date.toLocaleDateString()}`;
}

export function needsReconnect(connection: JobSiteConnection | undefined): boolean {
  return connection?.status === 'needs_reauth';
}

export interface SheetsData {
  status: SheetsStatus;
  config: SheetsConfig;
}

export function sheetsStatus({ status, config }: SheetsData): IntegrationStatus {
  if (!status.server_configured) {
    return { kind: 'unavailable', detail: "Google Sheets isn't configured on this server" };
  }
  if (!config.configured) return { kind: 'not_connected' };
  const tabs = config.assigned_tab_count ?? 0;
  const groups = config.group_count ?? 0;
  if (tabs === 0) return { kind: 'attention', detail: 'No tabs are assigned to a group' };
  const threshold = config.auto_post_threshold ?? DEFAULT_AUTO_POST_THRESHOLD;
  const summary = `${tabs} tab${tabs === 1 ? '' : 's'} in ${groups} group${groups === 1 ? '' : 's'} · score ≥ ${threshold}`;
  if (config.is_enabled === false) return { kind: 'off', detail: `Auto-post paused · ${summary}` };
  return { kind: 'connected', detail: summary };
}

export interface PumbleData {
  status: PumbleStatus;
  config: PumbleConfig;
}

export function pumbleStatus({ status, config }: PumbleData): IntegrationStatus {
  if (status.integration_available === false) {
    return { kind: 'unavailable', detail: 'Pumble integration is currently unavailable' };
  }
  const list = config.integrations ?? [];
  if (list.length === 0) return { kind: 'not_connected' };
  const threshold = config.auto_post_threshold ?? DEFAULT_AUTO_POST_THRESHOLD;
  const summary = `${list.length} destination${list.length === 1 ? '' : 's'} · score ≥ ${threshold}`;
  if (!list.some((i) => i.is_enabled !== false)) return { kind: 'off', detail: `Auto-post paused · ${summary}` };
  return { kind: 'connected', detail: summary };
}

export function primaryActionLabel(kind: StatusKind): string {
  if (kind === 'unavailable') return 'Why not?';
  if (kind === 'not_connected') return 'Connect';
  return 'Manage';
}
