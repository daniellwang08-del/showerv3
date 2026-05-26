import { apiClient } from './client';
import type {
  SheetsAutoPostThresholdResult,
  SheetsConfig,
  SheetsConfigSaveBody,
  SheetsConfigSaveResult,
  SheetsStatus,
  SheetsVerifyResult,
} from '../types/googleSheets';

export async function fetchSheetsStatus(): Promise<SheetsStatus> {
  const { data } = await apiClient.get<SheetsStatus>('/sheets/status');
  return data;
}

export async function fetchSheetsConfig(): Promise<SheetsConfig> {
  const { data } = await apiClient.get<SheetsConfig>('/sheets/config');
  return data;
}

export async function verifySpreadsheet(url: string): Promise<SheetsVerifyResult> {
  const { data } = await apiClient.get<SheetsVerifyResult>('/sheets/tabs', {
    params: { url: url.trim() },
  });
  return data;
}

export async function saveSheetsConfig(body: SheetsConfigSaveBody): Promise<SheetsConfigSaveResult> {
  const { data } = await apiClient.post<SheetsConfigSaveResult>('/sheets/config', body);
  return data;
}

export async function saveAutoPostThreshold(
  auto_post_threshold: number,
): Promise<SheetsAutoPostThresholdResult> {
  const { data } = await apiClient.patch<SheetsAutoPostThresholdResult>(
    '/sheets/config/auto-post-threshold',
    { auto_post_threshold },
  );
  return data;
}

export async function disconnectSheets(): Promise<{ success: boolean; removed: boolean }> {
  const { data } = await apiClient.delete<{ success: boolean; removed: boolean }>('/sheets/config');
  return data;
}
