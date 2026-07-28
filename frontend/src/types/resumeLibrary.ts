import type { ResumeDesign } from './resumeDesign';

export type ResumeStatus = 'draft' | 'completed';
export type ResumeSource = 'manual' | 'tailored' | 'job_workflow';

export interface ResumeLibraryItem {
  id: string;
  name: string;
  status: ResumeStatus | string;
  source: ResumeSource | string;
  job_title: string | null;
  company: string | null;
  design: ResumeDesign;
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface ResumeLibraryResponse {
  resumes: ResumeLibraryItem[];
  active_id: string | null;
  /** Present on single-item mutations (create/update/duplicate/activate). */
  resume?: ResumeLibraryItem | null;
}

/** Unified search hit: builder library row or completed job-workflow build. */
export type ResumeSearchKind = 'library' | 'job_build';

export interface ResumeSearchHit {
  kind: ResumeSearchKind;
  /** Library resume id, or job-build id when kind === 'job_build'. */
  id: string;
  build_id: string | null;
  job_id: string | null;
  name: string;
  status: string;
  source: string;
  job_title: string | null;
  company: string | null;
  is_active: boolean;
  content_ready: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface ResumeLibrarySearchResponse {
  resumes: ResumeSearchHit[];
  active_id: string | null;
  count: number;
  query: {
    company: string | null;
    job_title: string | null;
  };
}
