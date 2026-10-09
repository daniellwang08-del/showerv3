import { apiClient } from './client';

export type JobSiteAuthType = 'none' | 'api_key' | 'account' | 'unavailable';

export interface JobSiteCredentialField {
  key: string;
  label: string;
  placeholder: string;
  help_url: string | null;
  secret: boolean;
  /** Absent on older catalogs; treat as required. */
  required?: boolean;
  help_text?: string | null;
}

export interface JobSiteSessionCapture {
  cookie_domains: string[];
  /** Page the connect tab opens; the site's own redirect proves the login. */
  start_url: string;
  /** Protected page re-opened once when the landing URL is inconclusive. */
  verify_url: string;
  signed_in_url_patterns: string[];
  logged_out_url_patterns: string[];
  session_cookie_names: string[];
}

export interface JobSitePlugin {
  slug: string;
  name: string;
  blurb: string;
  homepage: string;
  signup_url: string | null;
  login_url: string | null;
  auth_type: JobSiteAuthType;
  connectable: boolean;
  unavailable_reason: string | null;
  logo_src: string;
  sort_order: number;
  credential_fields: JobSiteCredentialField[];
  session_capture: JobSiteSessionCapture | null;
  min_sync_hours?: number;
  /** Requests a key may ever make (Jooble free keys); null when uncapped. */
  lifetime_request_cap?: number | null;
}

export type JobSiteConnectionStatus =
  | 'connected'
  | 'needs_reauth'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'error';

export interface JobSiteConnection {
  id: string;
  plugin_slug: string;
  enabled: boolean;
  last_synced_at: string | null;
  last_error: string | null;
  last_listing_count: number | null;
  last_new_jobs: number | null;
  credential_hints: Record<string, string>;
  created_at: string | null;
  status?: JobSiteConnectionStatus;
  consecutive_failures?: number;
  /** Null while connected means "due now"; in any other status it means stopped. */
  next_sync_at?: string | null;
  last_success_at?: string | null;
  request_count?: number;
}

export interface JobSiteCatalog {
  plugins: JobSitePlugin[];
  connections: JobSiteConnection[];
}

export async function fetchJobSites(): Promise<JobSiteCatalog> {
  const { data } = await apiClient.get<JobSiteCatalog>('/job-sites');
  return data;
}

export async function connectJobSite(
  slug: string,
  body: {
    credentials?: Record<string, string>;
    cookies?: unknown[];
    storage?: {
      localStorage: Record<string, string>;
      sessionStorage: Record<string, string>;
    };
  },
): Promise<JobSiteConnection> {
  const { data } = await apiClient.post<JobSiteConnection>(`/job-sites/${slug}/connect`, body);
  return data;
}

export async function updateJobSite(
  slug: string,
  patch: { enabled?: boolean },
): Promise<JobSiteConnection> {
  const { data } = await apiClient.patch<JobSiteConnection>(`/job-sites/${slug}`, patch);
  return data;
}

export async function disconnectJobSite(slug: string): Promise<void> {
  await apiClient.delete(`/job-sites/${slug}`);
}

export async function syncJobSiteNow(slug: string): Promise<void> {
  await apiClient.post(`/job-sites/${slug}/sync`);
}
