export type SettingsMode = 'default' | 'custom';

export interface UserSettings {
  openai_key_mode: SettingsMode;
  openai_key_configured: boolean;
  openai_key_hint: string | null;
  system_openai_available: boolean;
  dedup_recycle_mode: SettingsMode;
  dedup_recycle_days: number;
  dedup_recycle_days_custom: number;
  default_dedup_recycle_days: number;
  min_match_score_mode: SettingsMode;
  min_match_score: number;
  min_match_score_custom: number;
  default_min_match_score: number;
}

export interface UserSettingsUpdate {
  openai_key_mode?: SettingsMode;
  openai_api_key?: string;
  clear_openai_api_key?: boolean;
  dedup_recycle_mode?: SettingsMode;
  dedup_recycle_days?: number;
  min_match_score_mode?: SettingsMode;
  min_match_score?: number;
}
