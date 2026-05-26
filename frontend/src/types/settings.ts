export type SettingsMode = 'default' | 'custom';

export type ResumeTemplateStatus = 'missing' | 'processing' | 'ready' | 'stale' | 'failed';

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
  resume_tailoring_prompt_mode: SettingsMode;
  resume_tailoring_prompt_instructions: string;
  resume_tailoring_prompt_instructions_custom: string;
  default_resume_tailoring_prompt_instructions: string;
  resume_tailoring_output_contract: string;
  resume_tailoring_prompt_max_length: number;
  resume_template_status: ResumeTemplateStatus;
  resume_template_source_filename: string | null;
  resume_template_error: string | null;
  resume_template_profile_work_count: number | null;
  resume_template_analyzed_at: string | null;
  resume_template_ready: boolean;
  profile_work_count: number;
  validation_errors: string[];
}

export interface UserSettingsUpdate {
  openai_key_mode?: SettingsMode;
  openai_api_key?: string;
  clear_openai_api_key?: boolean;
  dedup_recycle_mode?: SettingsMode;
  dedup_recycle_days?: number;
  min_match_score_mode?: SettingsMode;
  min_match_score?: number;
  resume_tailoring_prompt_mode?: SettingsMode;
  resume_tailoring_prompt_custom?: string;
}

export const RESUME_TAILORING_PROMPT_MIN_LENGTH = 50;
