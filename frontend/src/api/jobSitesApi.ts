import { apiClient } from './client';

export type JobSiteAuthType = 'none' | 'api_key' | 'session' | 'unavailable';

export interface JobSiteCredentialField {
  key: string;
  label: string;
  placeholder: string;
  help_url: string | null;
  secret: boolean;
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
  cookie_domains: string[];
  host_origins: string[];
  credential_fields: JobSiteCredentialField[];
}

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
  body: { credentials?: Record<string, string>; cookies?: unknown[] },
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
