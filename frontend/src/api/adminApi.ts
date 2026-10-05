import { apiClient } from './client';
import type {
  AdminUser,
  BlockedDomain,
  IssuedAccessKey,
  JobCleanupRequest,
  JobCleanupResult,
  LlmBenchmarkResponse,
  LlmJobBinding,
  LlmKeysResponse,
  LlmModelsResponse,
  LlmProviderKey,
  OpsOverview,
  SignupRequest,
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

export async function fetchSignupRequests(): Promise<SignupRequest[]> {
  const { data } = await apiClient.get<SignupRequest[]>('/admin/signup-requests');
  return data;
}

export async function approveSignup(userId: string): Promise<AdminUser> {
  const { data } = await apiClient.post<AdminUser>(`/admin/users/${userId}/approve`);
  return data;
}

export async function rejectSignup(userId: string): Promise<AdminUser> {
  const { data } = await apiClient.post<AdminUser>(`/admin/users/${userId}/reject`);
  return data;
}

/** The plaintext key is only ever returned by this call. */
export async function issueSignupAccessKey(userId: string, expiresAt: Date): Promise<IssuedAccessKey> {
  const { data } = await apiClient.post<IssuedAccessKey>(`/admin/users/${userId}/access-key`, {
    expires_at: expiresAt.toISOString(),
  });
  return data;
}

export async function revokeSignupAccessKey(userId: string): Promise<void> {
  await apiClient.delete(`/admin/users/${userId}/access-key`);
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

export interface MatchEngineShadowStats {
  match_engine: string;
  window_days: number;
  comparisons: number;
  mean_delta: number | null;
  mean_absolute_error: number | null;
  max_absolute_error: number | null;
  abs_delta_histogram: Record<string, number>;
  jobs_encoded: number;
  users_encoded: number;
  recent: {
    job_id: string;
    user_id: string;
    llm: number;
    vector: number;
    delta: number;
    at: string | null;
  }[];
}

export async function triggerMatchEngineBackfill(): Promise<{
  enqueued: boolean;
  already_running: boolean;
}> {
  const { data } = await apiClient.post<{ enqueued: boolean; already_running: boolean }>(
    '/admin/match-engine/backfill',
  );
  return data;
}

export async function fetchMatchEngineShadowStats(days = 30): Promise<MatchEngineShadowStats> {
  const { data } = await apiClient.get<MatchEngineShadowStats>(
    `/admin/match-engine/shadow-stats?days=${days}`,
  );
  return data;
}

export interface MatchDiagnoseStep {
  step: string;
  duration_ms: number;
  detail?: Record<string, unknown>;
}

export interface MatchDiagnoseResult {
  ok: boolean;
  job_id: string;
  user_id: string;
  match_engine_setting?: string;
  errors: string[];
  warnings: string[];
  job?: Record<string, unknown> | null;
  extraction?: Record<string, unknown> | null;
  profile?: { has_profile: boolean; profile_chars: number };
  encodings?: Record<string, unknown>;
  clearance_gate?: { hit: boolean; phrase?: string | null };
  stored_match?: Record<string, unknown> | null;
  vector_result?: {
    overall_score: number;
    dimension_scores: Record<string, number>;
    summary?: string;
    strengths?: string[];
    gaps?: string[];
    recommendation?: string;
    requires_security_clearance?: boolean;
    explain?: Record<string, unknown>;
  } | null;
  timing?: { total_ms: number; steps: MatchDiagnoseStep[] };
  recent_logs?: Array<{
    created_at: string | null;
    level: string;
    event: string;
    service: string;
    duration_ms?: number | null;
    message?: string | null;
    user_id?: string | null;
    payload?: Record<string, unknown> | null;
  }>;
  persisted_analysis?: Record<string, unknown>;
  job_text_chars?: number;
  inline_encode?: { job_ok: boolean; user_ok: boolean };
}

export async function diagnoseMatchEngine(body: {
  job_id: string;
  user_id?: string;
  encode_if_missing?: boolean;
  include_logs?: boolean;
  log_hours?: number;
  persist?: boolean;
}): Promise<MatchDiagnoseResult> {
  const { data } = await apiClient.post<MatchDiagnoseResult>(
    '/admin/match-engine/diagnose',
    body,
  );
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
