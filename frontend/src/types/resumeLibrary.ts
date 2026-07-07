import type { ResumeDesign } from './resumeDesign';

export type ResumeStatus = 'draft' | 'completed';
export type ResumeSource = 'manual' | 'tailored';

export interface ResumeLibraryItem {
  id: string;
  name: string;
  status: ResumeStatus;
  source: ResumeSource;
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
