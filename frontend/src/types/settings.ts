export type SettingsMode = 'default' | 'custom';

export type JobShareDefault = 'private' | 'team' | 'all' | 'ask';
export type JobShareScope = 'private' | 'team' | 'all' | 'users';
export type ResumeFilenameMode = 'pattern' | 'static';
export type ApplicationResumeSource = 'original' | 'tailored';
/** When the paid AI check reviews a free score: never, on re-run, or also on strong new matches. */
export type MatchQualityCheckMode = 'off' | 'rescore' | 'auto';
export const MATCH_QUALITY_CHECK_MODES: MatchQualityCheckMode[] = ['off', 'rescore', 'auto'];
export const DEFAULT_RESUME_FILENAME_PATTERN = '{firstname}_{lastname}_{kind}';

export type LlmProvider = 'openai' | 'anthropic' | 'gemini';

export const LLM_PROVIDERS: LlmProvider[] = ['openai', 'anthropic', 'gemini'];

export const LLM_PROVIDER_LABELS: Record<LlmProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
};

export interface CountryOption {
  code: string;
  name: string;
}

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
  /** Résumé used for applications: tailored per job, or the original as-is (score only). */
  application_resume_source: ApplicationResumeSource;
  match_quality_check: MatchQualityCheckMode;
  /** With ``auto``: only free scores at or above this get the AI check. */
  match_quality_check_min_score: number;
  /** Depth for URL/paste submits: extract | match | full */
  manual_submit_pipeline: 'extract' | 'match' | 'full';
  /** Starting share for jobs this user adds: private | team | all | ask */
  job_share_default: JobShareDefault;
  resume_filename_mode: ResumeFilenameMode;
  resume_filename_value: string;
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
  /** Preferred job countries (ISO alpha-2). Empty = no location filtering. */
  country_preferences: string[];
  /** How the preferences were set: unset | auto (resume) | manual. */
  country_preferences_source: 'unset' | 'auto' | 'manual';
  /** Full country list for the preferences dropdown. */
  available_countries: CountryOption[];
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
  application_resume_source?: ApplicationResumeSource;
  match_quality_check?: MatchQualityCheckMode;
  match_quality_check_min_score?: number;
  manual_submit_pipeline?: 'extract' | 'match' | 'full';
  job_share_default?: JobShareDefault;
  resume_filename_mode?: ResumeFilenameMode;
  resume_filename_value?: string;
  resume_tailoring_prompt_mode?: SettingsMode;
  resume_tailoring_prompt_custom?: string;
  cover_letter_prompt_mode?: SettingsMode;
  cover_letter_prompt_custom?: string;
  job_match_preferences?: string;
  clear_job_match_preferences?: boolean;
  /** ISO alpha-2 codes; empty array disables location filtering. */
  country_preferences?: string[];
}

export const RESUME_TAILORING_PROMPT_MIN_LENGTH = 50;
export const COVER_LETTER_PROMPT_MIN_LENGTH = 50;
