import { apiClient } from './client';

export interface JobSource {
  id: string;
  url: string;
  name: string;
  ats_type: string;
  board_token: string;
  enabled: boolean;
  last_synced_at: string | null;
  last_error: string | null;
  last_listing_count: number | null;
  last_new_jobs: number | null;
  created_at: string | null;
}

export interface JobSourceList {
  sources: JobSource[];
  supported_ats: string[];
  max_sources: number;
}

export async function fetchJobSources(): Promise<JobSourceList> {
  const { data } = await apiClient.get<JobSourceList>('/job-sources');
  return data;
}

export async function createJobSource(url: string, name?: string): Promise<JobSource> {
  const { data } = await apiClient.post<JobSource>('/job-sources', {
    url,
    ...(name ? { name } : {}),
  });
  return data;
}

export async function updateJobSource(
  id: string,
  patch: { enabled?: boolean; name?: string },
): Promise<JobSource> {
  const { data } = await apiClient.patch<JobSource>(`/job-sources/${id}`, patch);
  return data;
}

export async function deleteJobSource(id: string): Promise<void> {
  await apiClient.delete(`/job-sources/${id}`);
}

export async function syncJobSourceNow(id: string): Promise<void> {
  await apiClient.post(`/job-sources/${id}/sync`);
}
