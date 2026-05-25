export type AttachmentFlowStatus =
  | null
  | {
      phase: 'upload_extract' | 'submitting';
      message: string;
      submitted: number;
      total: number;
    };

export type ExtractionStatusLabel = 'pending' | 'processing' | 'extracted' | 'completed' | 'failed';

export type SubmittedUrlItem = {
  id: string;
  url: string;
  message: string;
  job_id: string | null;
  duplicate_job_id: string | null;
  created_at_ms: number;
  scraped_at_ms?: number;
  extraction_id?: string | null;
  extraction_status?: ExtractionStatusLabel | null;
  is_job_posting?: boolean | null;
  match_overall_score?: number | null;
  match_status?: string | null;
  click_count?: number;
  appliedAt?: number;
  /** Full name stored when marked applied (server: profile name → account name → email). */
  appliedBy?: string;
  posted_date_ms?: number;
  sheet_posted_at?: number | null;
  table?: 'active' | 'duplicated';
  /** Duplication / exclusion metadata (populated for duplicated-table items) */
  duplication_reason?: string | null;
  similarity_score?: number | null;
  /** Exclusion type */
  exclusion_type?: import('./index').ExclusionType;
  /** Job ID used for restore (always available for duplicated items) */
  valid_job_id_for_restore?: string | null;
  company?: string | null;
  title?: string | null;
};

export type ModalState =
  | null
  | {
      kind: 'edit';
      table: 'active' | 'duplicated';
      id: string;
      currentUrl: string;
    }
  | {
      kind: 'reportInvalid';
      table: 'active' | 'duplicated';
      id: string;
      currentUrl: string;
    }
  | {
      kind: 'reportDuplicate';
      table: 'active' | 'duplicated';
      id: string;
      currentUrl: string;
    }
  | {
      kind: 'replaceJob';
      invalidJobId: string;
      invalidUrl: string;
      validJobId: string;
      validUrl: string;
    }
  | {
      kind: 'delete';
      table: 'active' | 'duplicated';
      id: string;
      currentUrl: string;
    }
  | {
      kind: 'promoteInvalidToValid';
      id: string;
      currentUrl: string;
    };
