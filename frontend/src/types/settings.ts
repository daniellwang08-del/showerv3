export type SettingsMode = 'default' | 'custom';

export type LlmProvider = 'openai' | 'anthropic' | 'gemini';

export const LLM_PROVIDERS: LlmProvider[] = ['openai', 'anthropic', 'gemini'];

export const LLM_PROVIDER_LABELS: Record<LlmProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
};

export type ResumeTemplateStatus = 'missing' | 'processing' | 'ready' | 'stale' | 'failed';
export type CoverLetterTemplateStatus = 'missing' | 'processing' | 'ready' | 'failed';

export interface UserSettings {
  openai_key_mode: SettingsMode;
  openai_key_configured: boolean;
  openai_key_hint: string | null;
  system_openai_available: boolean;
  llm_provider: LlmProvider;
  default_llm_provider: LlmProvider;
  available_providers: LlmProvider[];
  /** Preferred OpenAI-compatible gateway model id (null = system default). */
  llm_model: string | null;
  default_llm_model: string;
  anthropic_key_mode: SettingsMode;
  anthropic_key_configured: boolean;
  anthropic_key_hint: string | null;
  system_anthropic_available: boolean;
  gemini_key_mode: SettingsMode;
  gemini_key_configured: boolean;
  gemini_key_hint: string | null;
  system_gemini_available: boolean;
  dedup_recycle_mode: SettingsMode;
  dedup_recycle_days: number;
  dedup_recycle_days_custom: number;
  default_dedup_recycle_days: number;
  min_match_score_mode: SettingsMode;
  min_match_score: number;
  min_match_score_custom: number;
  default_min_match_score: number;
  dedup_applied_company_mode: SettingsMode;
  dedup_applied_company_enabled: boolean;
  dedup_applied_company_enabled_custom: boolean;
  default_dedup_applied_company_enabled: boolean;
  dedup_score_comparison_mode: SettingsMode;
  dedup_score_comparison_enabled: boolean;
  dedup_score_comparison_enabled_custom: boolean;
  default_dedup_score_comparison_enabled: boolean;
  auto_prepare_match: boolean;
  auto_prepare_full: boolean;
  /** Depth for URL/paste submits: extract | match | full */
  manual_submit_pipeline: 'extract' | 'match' | 'full';
  resume_tailoring_prompt_mode: SettingsMode;
  resume_tailoring_prompt_instructions: string;
  resume_tailoring_prompt_instructions_custom: string;
  default_resume_tailoring_prompt_instructions: string;
  resume_tailoring_output_contract: string;
  resume_tailoring_prompt_max_length: number;
  cover_letter_prompt_mode: SettingsMode;
  cover_letter_prompt_instructions: string;
  cover_letter_prompt_instructions_custom: string;
  default_cover_letter_prompt_instructions: string;
  cover_letter_prompt_max_length: number;
  job_match_preferences: string;
  job_match_preferences_max_length: number;
  resume_template_status: ResumeTemplateStatus;
  resume_template_source_filename: string | null;
  resume_template_error: string | null;
  resume_template_profile_work_count: number | null;
  resume_template_analyzed_at: string | null;
  resume_template_ready: boolean;
  cover_letter_template_status: CoverLetterTemplateStatus;
  cover_letter_template_source_filename: string | null;
  cover_letter_template_error: string | null;
  cover_letter_template_analyzed_at: string | null;
  cover_letter_template_ready: boolean;
  profile_work_count: number;
  validation_errors: string[];
}

export interface UserSettingsUpdate {
  openai_key_mode?: SettingsMode;
  openai_api_key?: string;
  clear_openai_api_key?: boolean;
  llm_provider?: LlmProvider;
  llm_model?: string | null;
  clear_llm_model?: boolean;
  anthropic_key_mode?: SettingsMode;
  anthropic_api_key?: string;
  clear_anthropic_api_key?: boolean;
  gemini_key_mode?: SettingsMode;
  gemini_api_key?: string;
  clear_gemini_api_key?: boolean;
  dedup_recycle_mode?: SettingsMode;
  dedup_recycle_days?: number;
  min_match_score_mode?: SettingsMode;
  min_match_score?: number;
  dedup_applied_company_mode?: SettingsMode;
  dedup_applied_company_enabled?: boolean;
  dedup_score_comparison_mode?: SettingsMode;
  dedup_score_comparison_enabled?: boolean;
  auto_prepare_match?: boolean;
  auto_prepare_full?: boolean;
  manual_submit_pipeline?: 'extract' | 'match' | 'full';
  resume_tailoring_prompt_mode?: SettingsMode;
  resume_tailoring_prompt_custom?: string;
  cover_letter_prompt_mode?: SettingsMode;
  cover_letter_prompt_custom?: string;
  job_match_preferences?: string;
  clear_job_match_preferences?: boolean;
}

export const RESUME_TAILORING_PROMPT_MIN_LENGTH = 50;
export const COVER_LETTER_PROMPT_MIN_LENGTH = 50;
