import { apiClient } from './client';
import type {
  PumbleAutoPostThresholdResult,
  PumbleChannelsResult,
  PumbleConfig,
  PumbleConfigSaveBody,
  PumbleConfigSaveResult,
  PumbleIntegration,
  PumbleStatus,
  PumbleVerifyResult,
  PostJobsToPumbleResult,
} from '../types/pumble';

export async function fetchPumbleStatus(): Promise<PumbleStatus> {
  const { data } = await apiClient.get<PumbleStatus>('/pumble/status');
  return data;
}

export async function fetchPumbleConfig(): Promise<PumbleConfig> {
  const { data } = await apiClient.get<PumbleConfig>('/pumble/config');
  return data;
}

export async function verifyPumbleApiKey(apiKey: string): Promise<PumbleVerifyResult> {
  const { data } = await apiClient.post<PumbleVerifyResult>('/pumble/verify', {
    api_key: apiKey.trim(),
  });
  return data;
}

export async function fetchPumbleChannels(
  apiKey?: string,
  integrationId?: string,
): Promise<PumbleChannelsResult> {
  const { data } = await apiClient.post<PumbleChannelsResult>('/pumble/channels', {
    api_key: apiKey?.trim() || undefined,
    integration_id: integrationId || undefined,
  });
  return data;
}

export async function savePumbleConfig(body: PumbleConfigSaveBody): Promise<PumbleConfigSaveResult> {
  const { data } = await apiClient.post<PumbleConfigSaveResult>('/pumble/config', body);
  return data;
}

export async function savePumbleAutoPostThreshold(
  auto_post_threshold: number,
): Promise<PumbleAutoPostThresholdResult> {
  const { data } = await apiClient.patch<PumbleAutoPostThresholdResult>(
    '/pumble/config/auto-post-threshold',
    { auto_post_threshold },
  );
  return data;
}

export async function savePumbleAutoPostSettings(body: {
  auto_post_threshold: number;
  auto_post_filters: import('../types/autoPostFilters').AutoPostFilters;
}): Promise<PumbleAutoPostThresholdResult> {
  const { data } = await apiClient.patch<PumbleAutoPostThresholdResult>(
    '/pumble/config/auto-post-settings',
    body,
  );
  return data;
}

export async function setPumbleAllEnabled(is_enabled: boolean): Promise<PumbleConfig & { success: boolean; is_enabled: boolean }> {
  const { data } = await apiClient.patch<PumbleConfig & { success: boolean; is_enabled: boolean }>(
    '/pumble/config/enabled',
    { is_enabled },
  );
  return data;
}

export async function setPumbleIntegrationEnabled(
  integrationId: string,
  is_enabled: boolean,
): Promise<{ success: boolean; integration: PumbleIntegration }> {
  const { data } = await apiClient.patch<{ success: boolean; integration: PumbleIntegration }>(
    `/pumble/config/${integrationId}/enabled`,
    { is_enabled },
  );
  return data;
}

export async function disconnectPumble(): Promise<{ success: boolean; removed: boolean }> {
  const { data } = await apiClient.delete<{ success: boolean; removed: boolean }>('/pumble/config');
  return data;
}

export async function deletePumbleIntegration(
  integrationId: string,
): Promise<{ success: boolean; removed: boolean }> {
  const { data } = await apiClient.delete<{ success: boolean; removed: boolean }>(
    `/pumble/config/${integrationId}`,
  );
  return data;
}

export async function postJobsToPumble(
  jobIds: string[],
  integrationIds?: string[],
): Promise<PostJobsToPumbleResult> {
  const { data } = await apiClient.post<PostJobsToPumbleResult>('/pumble/post-jobs', {
    job_ids: jobIds,
    integration_ids: integrationIds?.length ? integrationIds : undefined,
  });
  return data;
}
