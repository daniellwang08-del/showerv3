export interface SheetsStatus {
  server_configured: boolean;
  service_account_email: string | null;
}

export interface SheetsConfig {
  configured: boolean;
  spreadsheet_url?: string;
  tab_groups?: string[][];
  auto_post_threshold?: number;
  group_count?: number;
  assigned_tab_count?: number;
}

export interface SheetsVerifyResult {
  tabs: string[];
  tab_count: number;
  spreadsheet_id: string;
}

export interface SheetsConfigSaveBody {
  spreadsheet_url: string;
  tab_groups: string[][];
  auto_post_threshold: number;
}

export interface SheetsConfigSaveResult {
  success: boolean;
  spreadsheet_url: string;
  tab_groups: string[][];
  auto_post_threshold: number;
  group_count: number;
  assigned_tab_count: number;
}

export interface SheetsAutoPostThresholdResult {
  success: boolean;
  auto_post_threshold: number;
  spreadsheet_url: string;
  tab_groups: string[][];
  group_count: number;
  assigned_tab_count: number;
}

export interface PostJobsToSheetResult {
  success: boolean;
  posted_count: number;
  partial_count?: number;
  failed_count?: number;
  skipped_already_in_sheet: number;
  skipped_not_found: number;
  results: Array<Record<string, unknown>>;
  partial_results?: Array<Record<string, unknown>>;
  failed_results?: Array<Record<string, unknown>>;
}
