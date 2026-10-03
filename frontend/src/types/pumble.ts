export interface PumbleStatus {
  integration_available: boolean;
}

export interface PumbleChannel {
  id: string;
  name: string;
  channel_type: string;
  is_private: boolean;
}

export interface PumbleVerifyResult {
  valid: boolean;
  workspace_id?: string | null;
  user_name?: string | null;
  api_key_hint?: string | null;
}

export interface PumbleChannelsResult {
  channels: PumbleChannel[];
  channel_count: number;
}

export interface PumbleIntegration {
  id: string;
  label: string;
  channel_id: string;
  channel_name: string;
  workspace_id?: string | null;
  api_key_hint?: string | null;
  is_enabled: boolean;
  auto_post_threshold?: number;
  auto_post_filters?: import('./autoPostFilters').AutoPostFilters;
  parent_posted_date?: string | null;
}

export interface PumbleConfig {
  configured: boolean;
  integration_count?: number;
  integrations?: PumbleIntegration[];
  auto_post_threshold?: number;
  auto_post_filters?: import('./autoPostFilters').AutoPostFilters;
  /** @deprecated Use integrations[], kept for backward compatibility */
  channel_id?: string;
  channel_name?: string;
  workspace_id?: string | null;
  api_key_hint?: string | null;
  parent_posted_date?: string | null;
}

export interface PumbleConfigSaveBody {
  api_key: string;
  channel_id: string;
  channel_name: string;
  workspace_id?: string | null;
  label?: string | null;
  auto_post_threshold: number;
}

export interface PumbleConfigSaveResult {
  success: boolean;
  integration: PumbleIntegration;
}

export interface PumbleAutoPostThresholdResult {
  success: boolean;
  auto_post_threshold: number;
  auto_post_filters?: import('./autoPostFilters').AutoPostFilters;
  integration_count: number;
}

export interface PostJobsToPumbleResult {
  success: boolean;
  posted_count: number;
  failed_count?: number;
  skipped_already_in_thread: number;
  skipped_not_found: number;
  destination_count?: number;
  results: Array<Record<string, unknown>>;
  failed_results?: Array<Record<string, unknown>>;
  integrations?: Array<Record<string, unknown>>;
}
