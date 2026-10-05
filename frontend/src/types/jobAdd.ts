import type { JobShareScope } from './settings';

export type JobAddSource = 'manual' | 'paste' | 'attachment' | 'extension' | 'site';

export interface JobAddShareUser {
  id: string;
  name: string;
  email: string;
}

export interface JobAddBatch {
  id: string;
  source: JobAddSource | string;
  job_count: number;
  share_scope: JobShareScope;
  created_at: string | null;
  updated_at: string | null;
  share_users: JobAddShareUser[];
}
