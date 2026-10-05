import { apiClient } from './client';
import type { JobAddBatch, JobAddShareUser, JobAddSource } from '@/types/jobAdd';
import type { JobShareScope } from '@/types/settings';

export async function fetchJobAddBatches(): Promise<JobAddBatch[]> {
  const { data } = await apiClient.get<JobAddBatch[]>('/job-add-batches');
  return Array.isArray(data) ? data : [];
}

export async function fetchJobAddShareTargets(): Promise<JobAddShareUser[]> {
  const { data } = await apiClient.get<JobAddShareUser[]>('/job-add-batches/share-targets');
  return Array.isArray(data) ? data : [];
}

export async function createJobAddBatch(body: {
  job_ids: string[];
  source?: JobAddSource;
  share_scope?: JobShareScope;
  user_ids?: string[];
}): Promise<JobAddBatch | null> {
  const { data } = await apiClient.post<JobAddBatch | null>('/job-add-batches', body);
  return data ?? null;
}

export async function updateJobAddBatchShare(
  batchId: string,
  body: { share_scope: JobShareScope; user_ids?: string[] },
): Promise<JobAddBatch> {
  const { data } = await apiClient.patch<JobAddBatch>(`/job-add-batches/${batchId}`, body);
  return data;
}
