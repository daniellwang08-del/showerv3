import { apiClient } from './client';
import type { SettingsMode, UserSettings, UserSettingsUpdate } from '../types/settings';

export interface OpenAiKeyTestResult {
  ok: boolean;
  message: string;
}

export interface MinMatchScorePreviewSample {
  job_id: string;
  title?: string | null;
  company?: string | null;
  match_score: number;
}

export interface MinMatchScorePreview {
  threshold: number;
  threshold_mode: string;
  analyzed_visible_count: number;
  would_hide_count: number;
  meeting_threshold_count: number;
  already_hidden_count: number;
  would_restore_count: number;
  samples: MinMatchScorePreviewSample[];
}

export interface MinMatchScoreApplyResult {
  success: boolean;
  min_match_score: number;
  hidden: number;
  restored: number;
  settings: UserSettings;
}

export type MinMatchScoreDraft = {
  min_match_score_mode: SettingsMode;
  min_match_score?: number;
};

export async function fetchUserSettings(): Promise<UserSettings> {
  const { data } = await apiClient.get<UserSettings>('/settings');
  return data;
}

export async function updateUserSettings(body: UserSettingsUpdate): Promise<UserSettings> {
  const { data } = await apiClient.put<UserSettings>('/settings', body);
  return data;
}

export async function testOpenAiKey(openaiApiKey?: string): Promise<OpenAiKeyTestResult> {
  const { data } = await apiClient.post<OpenAiKeyTestResult>('/settings/openai/test', {
    openai_api_key: openaiApiKey?.trim() || undefined,
  });
  return data;
}

export async function saveOpenAiSettings(body: Pick<UserSettingsUpdate, 'openai_key_mode' | 'openai_api_key' | 'clear_openai_api_key'>) {
  return updateUserSettings(body);
}

export async function saveDedupSettings(body: Pick<UserSettingsUpdate, 'dedup_recycle_mode' | 'dedup_recycle_days'>) {
  return updateUserSettings(body);
}

export async function saveMinMatchScoreSettings(
  body: Pick<UserSettingsUpdate, 'min_match_score_mode' | 'min_match_score'>,
) {
  return updateUserSettings(body);
}

export async function previewMinMatchScore(body: MinMatchScoreDraft): Promise<MinMatchScorePreview> {
  const { data } = await apiClient.post<MinMatchScorePreview>('/settings/min-match-score/preview', body);
  return data;
}

export async function applyMinMatchScore(body: MinMatchScoreDraft): Promise<MinMatchScoreApplyResult> {
  const { data } = await apiClient.post<MinMatchScoreApplyResult>('/settings/min-match-score/apply', body);
  return data;
}

export async function reconcileMinMatchScore(): Promise<{
  success: boolean;
  min_match_score: number;
  hidden: number;
  restored: number;
}> {
  const { data } = await apiClient.post('/jobs/valid/reconcile-min-match-score');
  return data;
}
