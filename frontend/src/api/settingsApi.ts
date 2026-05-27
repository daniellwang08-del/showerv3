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

function normalizeUserSettings(data: Partial<UserSettings>): UserSettings {
  return {
    openai_key_mode: (data.openai_key_mode as SettingsMode) ?? 'default',
    openai_key_configured: Boolean(data.openai_key_configured),
    openai_key_hint: (data.openai_key_hint as string | null | undefined) ?? null,
    system_openai_available: Boolean(data.system_openai_available),
    dedup_recycle_mode: (data.dedup_recycle_mode as SettingsMode) ?? 'default',
    dedup_recycle_days: Number(data.dedup_recycle_days ?? 60),
    dedup_recycle_days_custom: Number(data.dedup_recycle_days_custom ?? 60),
    default_dedup_recycle_days: Number(data.default_dedup_recycle_days ?? 60),
    min_match_score_mode: (data.min_match_score_mode as SettingsMode) ?? 'default',
    min_match_score: Number(data.min_match_score ?? 0),
    min_match_score_custom: Number(data.min_match_score_custom ?? 0),
    default_min_match_score: Number(data.default_min_match_score ?? 0),
    resume_tailoring_prompt_mode: (data.resume_tailoring_prompt_mode as SettingsMode) ?? 'default',
    resume_tailoring_prompt_instructions: String(data.resume_tailoring_prompt_instructions ?? ''),
    resume_tailoring_prompt_instructions_custom: String(data.resume_tailoring_prompt_instructions_custom ?? ''),
    default_resume_tailoring_prompt_instructions: String(
      data.default_resume_tailoring_prompt_instructions ?? '',
    ),
    resume_tailoring_output_contract: String(data.resume_tailoring_output_contract ?? ''),
    resume_tailoring_prompt_max_length: Number(data.resume_tailoring_prompt_max_length ?? 12000),
    cover_letter_prompt_mode: (data.cover_letter_prompt_mode as SettingsMode) ?? 'default',
    cover_letter_prompt_instructions: String(data.cover_letter_prompt_instructions ?? ''),
    cover_letter_prompt_instructions_custom: String(data.cover_letter_prompt_instructions_custom ?? ''),
    default_cover_letter_prompt_instructions: String(
      data.default_cover_letter_prompt_instructions ?? '',
    ),
    cover_letter_prompt_max_length: Number(data.cover_letter_prompt_max_length ?? 12000),
    resume_template_status: (data.resume_template_status as UserSettings['resume_template_status']) ?? 'missing',
    resume_template_source_filename: (data.resume_template_source_filename as string | null | undefined) ?? null,
    resume_template_error: (data.resume_template_error as string | null | undefined) ?? null,
    resume_template_profile_work_count:
      data.resume_template_profile_work_count != null
        ? Number(data.resume_template_profile_work_count)
        : null,
    resume_template_analyzed_at: (data.resume_template_analyzed_at as string | null | undefined) ?? null,
    resume_template_ready: Boolean(data.resume_template_ready),
    cover_letter_template_status:
      (data.cover_letter_template_status as UserSettings['cover_letter_template_status']) ?? 'missing',
    cover_letter_template_source_filename:
      (data.cover_letter_template_source_filename as string | null | undefined) ?? null,
    cover_letter_template_error: (data.cover_letter_template_error as string | null | undefined) ?? null,
    cover_letter_template_analyzed_at:
      (data.cover_letter_template_analyzed_at as string | null | undefined) ?? null,
    cover_letter_template_ready: Boolean(data.cover_letter_template_ready),
    profile_work_count: Number(data.profile_work_count ?? 0),
    validation_errors: Array.isArray(data.validation_errors)
      ? (data.validation_errors as string[])
      : [],
  };
}

export async function fetchUserSettings(): Promise<UserSettings> {
  const { data } = await apiClient.get<Partial<UserSettings>>('/settings');
  return normalizeUserSettings(data);
}

export async function updateUserSettings(body: UserSettingsUpdate): Promise<UserSettings> {
  const { data } = await apiClient.put<Partial<UserSettings>>('/settings', body);
  return normalizeUserSettings(data);
}

export async function testOpenAiKey(openaiApiKey?: string): Promise<OpenAiKeyTestResult> {
  const { data } = await apiClient.post<OpenAiKeyTestResult>('/settings/openai/test', {
    openai_api_key: openaiApiKey?.trim() || undefined,
  });
  return data;
}

export async function saveOpenAiSettings(
  body: Pick<UserSettingsUpdate, 'openai_key_mode' | 'openai_api_key' | 'clear_openai_api_key'>,
) {
  return updateUserSettings(body);
}

export async function saveDedupSettings(
  body: Pick<UserSettingsUpdate, 'dedup_recycle_mode' | 'dedup_recycle_days'>,
) {
  return updateUserSettings(body);
}

export async function saveMinMatchScoreSettings(
  body: Pick<UserSettingsUpdate, 'min_match_score_mode' | 'min_match_score'>,
) {
  return updateUserSettings(body);
}

export async function saveResumeTailoringPromptSettings(
  body: Pick<UserSettingsUpdate, 'resume_tailoring_prompt_mode' | 'resume_tailoring_prompt_custom'>,
) {
  return updateUserSettings(body);
}

export async function saveCoverLetterPromptSettings(
  body: Pick<UserSettingsUpdate, 'cover_letter_prompt_mode' | 'cover_letter_prompt_custom'>,
) {
  return updateUserSettings(body);
}

export interface CoverLetterPromptDefaults {
  default_instructions: string;
  max_length: number;
  min_length: number;
}

export async function fetchCoverLetterPromptDefaults(): Promise<CoverLetterPromptDefaults> {
  const { data } = await apiClient.get<CoverLetterPromptDefaults>('/settings/cover-letter-prompt/defaults');
  return {
    default_instructions: String(data.default_instructions ?? ''),
    max_length: Number(data.max_length ?? 12000),
    min_length: Number(data.min_length ?? 50),
  };
}

export async function previewMinMatchScore(body: MinMatchScoreDraft): Promise<MinMatchScorePreview> {
  const { data } = await apiClient.post<MinMatchScorePreview>('/settings/min-match-score/preview', body);
  return data;
}

export async function applyMinMatchScore(body: MinMatchScoreDraft): Promise<MinMatchScoreApplyResult> {
  const { data } = await apiClient.post<MinMatchScoreApplyResult>('/settings/min-match-score/apply', body);
  return {
    ...data,
    settings: normalizeUserSettings(data.settings ?? {}),
  };
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
