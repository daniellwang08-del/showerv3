import { apiClient } from './client';
import type {
  ScrapedJob,
  ScrapedJobsPage,
  ScrapedJobUpdatePayload,
  ScraperStats,
  ScrapeRun,
  SyncStatus,
  SpiderInfo,
  RerunExtractionResponse,
  DeleteScrapedJobResponse,
  DashboardJobsPage,
} from '../types/scraper';

export async function fetchScrapedJobs(params: {
  page?: number;
  per_page?: number;
  source?: string;
  q?: string;
  remote_only?: boolean;
  sort?: string;
  order?: string;
}): Promise<ScrapedJobsPage> {
  const { data } = await apiClient.get('/scraper/jobs', { params });
  return data;
}

export async function fetchDashboardJobs(params: {
  page?: number;
  per_page?: number;
  source?: string;
  q?: string;
  remote_only?: boolean;
  sort?: string;
  order?: string;
}): Promise<DashboardJobsPage> {
  const { data } = await apiClient.get('/jobs/dashboard', { params });
  return data;
}

export async function fetchScrapedJob(id: string) {
  const { data } = await apiClient.get(`/scraper/jobs/${id}`);
  return data;
}

export async function fetchScraperStats(): Promise<ScraperStats> {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { data } = await apiClient.get('/scraper/stats', { params: { timezone } });
  return data;
}

export async function fetchSources(): Promise<string[]> {
  const { data } = await apiClient.get('/scraper/sources');
  return data;
}

export async function fetchScrapeRuns(limit = 20): Promise<ScrapeRun[]> {
  const { data } = await apiClient.get('/scraper/runs', { params: { limit } });
  return data;
}

export async function triggerSync(spiderName = 'all'): Promise<SyncStatus> {
  const { data } = await apiClient.post('/scraper/sync', { spider_name: spiderName });
  return data;
}

export async function fetchSyncStatus(): Promise<SyncStatus> {
  const { data } = await apiClient.get('/scraper/sync/status');
  return data;
}

export async function fetchSpiders(): Promise<SpiderInfo[]> {
  const { data } = await apiClient.get('/scraper/spiders');
  return data;
}

export interface AuthPlatformStatus {
  platform: string;
  label: string;
  exists: boolean;
  corrupt: boolean;
  saved_at: string | null;
  cookie_count: number;
  setup_command: string;
}

export async function fetchAuthStatus(): Promise<AuthPlatformStatus[]> {
  const { data } = await apiClient.get('/scraper/auth/status');
  return data;
}

export async function clearAuthSession(platform: string): Promise<{ status: string; message: string }> {
  const { data } = await apiClient.post(`/scraper/auth/clear/${platform}`);
  return data;
}

export async function rerunScrapedJob(jobId: string): Promise<RerunExtractionResponse> {
  const { data } = await apiClient.post(`/scraper/jobs/${jobId}/rerun-extraction`);
  return data;
}

export async function updateScrapedJob(
  jobId: string,
  payload: ScrapedJobUpdatePayload,
): Promise<ScrapedJob> {
  const { data } = await apiClient.patch(`/scraper/jobs/${jobId}`, payload);
  return data;
}

export async function deleteScrapedJob(jobId: string): Promise<DeleteScrapedJobResponse> {
  const { data } = await apiClient.delete(`/scraper/jobs/${jobId}`);
  return data;
}

// ---------------------------------------------------------------------------
// AI search
// ---------------------------------------------------------------------------

export interface ScraperAiSearchResponse {
  matching_jobs: Record<string, unknown>[];
  query: {
    rationale?: string | null;
    sort_by?: string;
    sort_order?: string;
    [key: string]: unknown;
  };
  total_matching: number;
}

export async function scraperAiSearch(prompt: string): Promise<ScraperAiSearchResponse> {
  const { data } = await apiClient.post<ScraperAiSearchResponse>('/jobs/valid/ai-search', {
    prompt,
  });
  return data;
}

// ---------------------------------------------------------------------------
// Batch operations
// ---------------------------------------------------------------------------

export interface BatchOperationResponse {
  succeeded: string[];
  failed: string[];
  message: string;
}

export async function batchDeleteScrapedJobs(jobIds: string[]): Promise<BatchOperationResponse> {
  const { data } = await apiClient.post<BatchOperationResponse>('/scraper/jobs/batch-delete', {
    job_ids: jobIds,
  });
  return data;
}

export async function batchRerunScrapedJobs(jobIds: string[]): Promise<BatchOperationResponse> {
  const { data } = await apiClient.post<BatchOperationResponse>('/scraper/jobs/batch-rerun', {
    job_ids: jobIds,
  });
  return data;
}
