/** Types for the admin system logs dashboard. */

export interface SystemLogEvent {
  id: string;
  created_at: string | null;
  level: string;
  event: string;
  logger_name?: string | null;
  category: string;
  service: string;
  request_id?: string | null;
  user_id?: string | null;
  job_id?: string | null;
  extraction_id?: string | null;
  worker_job_type?: string | null;
  method?: string | null;
  path?: string | null;
  status_code?: number | null;
  duration_ms?: number | null;
  client_ip?: string | null;
  message?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface SystemLogListResponse {
  items: SystemLogEvent[];
  total: number;
  page: number;
  per_page: number;
  pages: number;
}

export interface SystemLogStats {
  window_hours: number;
  total: number;
  by_level: Record<string, number>;
  by_category: Record<string, number>;
  by_service: Record<string, number>;
  error_rate: number;
  top_paths: { path: string; count: number }[];
  retention_days: number;
}

export interface SystemLogQuery {
  page?: number;
  per_page?: number;
  level?: string;
  category?: string;
  service?: string;
  request_id?: string;
  path_contains?: string;
  event_contains?: string;
  user_id?: string;
  hours?: number;
  since?: string;
}
