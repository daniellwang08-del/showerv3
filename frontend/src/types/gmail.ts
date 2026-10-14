export interface GmailStatus {
  server_configured: boolean;
  scopes?: string[];
}

export interface GmailConfig {
  configured: boolean;
  google_email?: string;
  is_enabled?: boolean;
  status?: 'connected' | 'needs_reauth' | string;
  last_error?: string | null;
  scopes?: string[];
  connected_at?: string | null;
}

export interface GmailMessageSummary {
  id: string;
  thread_id?: string;
  snippet: string;
  subject: string;
  from: string;
  to?: string;
  date?: string | null;
  label_ids?: string[];
  body_text?: string;
}

export interface GmailSearchResult {
  query: string;
  result_size_estimate: number;
  messages: GmailMessageSummary[];
}
