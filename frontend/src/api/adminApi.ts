import { apiClient } from './client';
import type {
  AdminUser,
  BlockedDomain,
  JobCleanupRequest,
  JobCleanupResult,
  LlmBenchmarkResponse,
  LlmJobBinding,
  LlmKeysResponse,
  LlmModelsResponse,
  LlmProviderKey,
  OpsOverview,
  SystemSettingsResponse,
} from '../types/admin';

export async function fetchAdminUsers(): Promise<AdminUser[]> {
  const { data } = await apiClient.get<AdminUser[]>('/admin/users');
  return data;
}

export async function patchAdminUser(
  userId: string,
  body: { is_admin?: boolean; is_active?: boolean },
): Promise<AdminUser> {
  const { data } = await apiClient.patch<AdminUser>(`/admin/users/${userId}`, body);
  return data;
}

export async function resetAdminUserPassword(userId: string, password: string): Promise<void> {
  await apiClient.post(`/admin/users/${userId}/reset-password`, { password });
}

export async function deleteAdminUser(userId: string): Promise<void> {
  await apiClient.delete(`/admin/users/${userId}`);
}

export async function fetchSystemSettings(): Promise<SystemSettingsResponse> {
  const { data } = await apiClient.get<SystemSettingsResponse>('/admin/system-settings');
  return data;
}

export async function updateSystemSettings(
  settings: Record<string, string | number | boolean>,
): Promise<SystemSettingsResponse> {
  const { data } = await apiClient.put<SystemSettingsResponse>('/admin/system-settings', {
    settings,
  });
  return data;
}

export async function clearSystemSetting(key: string): Promise<SystemSettingsResponse> {
  const { data } = await apiClient.delete<SystemSettingsResponse>(`/admin/system-settings/${key}`);
  return data;
}

export async function fetchOpsOverview(): Promise<OpsOverview> {
  const { data } = await apiClient.get<OpsOverview>('/admin/ops/overview');
  return data;
}

export async function interruptStaleScrapes(): Promise<{ interrupted_count: number }> {
  const { data } = await apiClient.post<{ interrupted_count: number }>(
    '/admin/ops/interrupt-stale-scrapes',
  );
  return data;
}

export async function clearQueue(queueId: string): Promise<{ keys_deleted: number }> {
  const { data } = await apiClient.post<{ keys_deleted: number }>('/admin/ops/queues/clear', {
    queue_id: queueId,
    confirm: true,
  });
  return data;
}

export async function fetchBlockedDomains(): Promise<BlockedDomain[]> {
  const { data } = await apiClient.get<{ domains: BlockedDomain[] }>('/admin/blocked-domains');
  return data.domains;
}

export async function addBlockedDomain(domain: string, reason: string): Promise<BlockedDomain> {
  const { data } = await apiClient.post<BlockedDomain>('/admin/blocked-domains', {
    domain,
    reason,
  });
  return data;
}

export async function removeBlockedDomain(domain: string): Promise<void> {
  await apiClient.delete(`/admin/blocked-domains/${encodeURIComponent(domain)}`);
}

export async function cleanupJobs(body: JobCleanupRequest): Promise<JobCleanupResult> {
  const { data } = await apiClient.post<JobCleanupResult>('/admin/jobs/cleanup', body);
  return data;
}

export async function fetchLlmKeys(): Promise<LlmKeysResponse> {
  const { data } = await apiClient.get<LlmKeysResponse>('/admin/llm-keys');
  return data;
}

export async function validateLlmKey(body: {
  provider: string;
  api_key: string;
}): Promise<{ ok: boolean; message: string; provider: string }> {
  const { data } = await apiClient.post<{ ok: boolean; message: string; provider: string }>(
    '/admin/llm-keys/validate',
    body,
  );
  return data;
}

export async function createLlmKey(body: {
  provider: string;
  label: string;
  api_key: string;
}): Promise<LlmProviderKey> {
  const { data } = await apiClient.post<LlmProviderKey>('/admin/llm-keys', body);
  return data;
}

export async function updateLlmKey(
  keyId: string,
  body: { label?: string; api_key?: string; is_enabled?: boolean },
): Promise<LlmProviderKey> {
  const { data } = await apiClient.patch<LlmProviderKey>(`/admin/llm-keys/${keyId}`, body);
  return data;
}

export async function deleteLlmKey(keyId: string): Promise<void> {
  await apiClient.delete(`/admin/llm-keys/${keyId}`);
}

export async function saveLlmJobBindings(
  bindings: Array<{
    job_type: string;
    provider_key_id: string | null;
    provider?: string | null;
    model?: string | null;
  }>,
): Promise<LlmJobBinding[]> {
  const { data } = await apiClient.put<{ bindings: LlmJobBinding[] }>('/admin/llm-job-bindings', {
    bindings,
  });
  return data.bindings;
}

export async function fetchLlmModelsForKey(keyId: string): Promise<LlmModelsResponse> {
  const { data } = await apiClient.get<LlmModelsResponse>(`/admin/llm-keys/${keyId}/models`);
  return data;
}

export async function fetchLlmModelsForEnv(
  provider: string = 'openai',
): Promise<LlmModelsResponse> {
  const { data } = await apiClient.get<LlmModelsResponse>('/admin/llm-models', {
    params: { provider },
  });
  return data;
}

export async function runLlmBenchmark(body: {
  models: Array<{ provider: string; model: string; provider_key_id?: string | null }>;
  runs?: number;
  concurrency?: number;
  prompt?: string;
}): Promise<LlmBenchmarkResponse> {
  const { data } = await apiClient.post<LlmBenchmarkResponse>('/admin/llm-benchmark', body, {
    // Benchmarks can take a while when many models × runs are selected.
    timeout: 300_000,
  });
  return data;
}
