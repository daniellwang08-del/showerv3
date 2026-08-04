export interface AdminUser {
  id: string;
  email: string;
  name?: string | null;
  display_name: string;
  is_active: boolean;
  is_admin: boolean;
  created_at: string;
}

export interface SystemSettingItem {
  key: string;
  value: string | number | boolean;
  env_default: string | number | boolean;
  overridden: boolean;
}

export interface SystemSettingsResponse {
  settings: SystemSettingItem[];
  secrets_presence: Record<string, boolean>;
}

export interface QueueInfo {
  id: string;
  name: string;
  label: string;
  description: string;
  pending: number | null;
  reachable: boolean;
}

export interface OpsOverview {
  health: {
    status: string;
    version: string;
    database_connected: boolean;
    redis_connected: boolean;
    browser_pool_available: number;
  };
  scrape: {
    status: string;
    spider_name?: string;
    items_scraped?: number;
    items_new?: number;
    items_updated?: number;
    started_at?: string;
    elapsed_seconds?: number | null;
  };
  recent_scrape_runs: Array<{
    id: string;
    spider_name: string;
    status: string;
    items_scraped?: number;
    items_new?: number;
    items_updated?: number;
    started_at?: string;
    finished_at?: string | null;
  }>;
  analysis_worker_max_jobs: number;
  tailoring_worker_max_jobs?: number;
  queues?: QueueInfo[];
  healed?: {
    failed_content: number;
    cleared_progress: number;
    processing_max_age_seconds: number;
    progress_max_age_seconds: number;
  } | null;
}

export interface BlockedDomain {
  domain: string;
  reason: string;
  created_at?: string | null;
}

export interface JobCleanupSample {
  job_id: string;
  title: string | null;
  company: string;
  domain: string;
  source_url: string;
  created_at: string | null;
}

export type JobCleanupMatchField =
  | 'company'
  | 'domain'
  | 'source_url'
  | 'normalized_url'
  | 'title';

export type JobCleanupMode = 'age' | 'pattern' | 'combined';

export interface JobCleanupRequest {
  older_than_days?: number | null;
  pattern?: string | null;
  match_fields?: JobCleanupMatchField[];
  case_insensitive?: boolean;
  confirm?: boolean;
  preview_only?: boolean;
  sample_limit?: number;
}

export interface JobCleanupResult {
  preview: boolean;
  mode: JobCleanupMode;
  older_than_days: number | null;
  pattern: string | null;
  match_fields: JobCleanupMatchField[];
  case_insensitive: boolean | null;
  cutoff: string | null;
  matching_jobs: number;
  deleted: number;
  sample: JobCleanupSample[];
}

export type LlmProvider = 'openai' | 'anthropic' | 'gemini';

export interface LlmProviderKey {
  id: string;
  provider: LlmProvider | string;
  label: string;
  key_hint?: string | null;
  is_enabled: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface LlmJobBinding {
  job_type: string;
  label: string;
  description: string;
  provider_key_id: string | null;
  provider: string | null;
  /** Gateway / provider model id selected for this job (nullable = system default). */
  model: string | null;
}

export interface LlmDiscoveredModel {
  id: string;
  owned_by?: string | null;
  usable_for_chat: boolean;
}

export interface LlmModelsResponse {
  provider: string;
  base_url?: string | null;
  models: LlmDiscoveredModel[];
  chat_models: LlmDiscoveredModel[];
  count: number;
  message?: string | null;
}

export interface LlmKeysResponse {
  keys: LlmProviderKey[];
  bindings: LlmJobBinding[];
  job_types: Record<string, { label: string; description: string }>;
}

export interface LlmBenchmarkTarget {
  provider: LlmProvider | string;
  model: string;
  provider_key_id?: string | null;
}

export interface LlmBenchmarkResult {
  provider: string;
  model: string;
  provider_key_id?: string | null;
  ok: boolean;
  latency_ms: number | null;
  error: string | null;
  ran_at: string;
  response_preview?: string | null;
}

export interface LlmBenchmarkResponse {
  results: LlmBenchmarkResult[];
  summary: {
    total: number;
    ok: number;
    failed: number;
    runs: number;
  };
}
