export type ExtractionStatusLabel = 'pending' | 'processing' | 'completed' | 'failed';

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
  match_overall_score?: number | null;
  match_status?: string | null;
  click_count?: number;
  appliedAt?: number;
  appliedBy?: string;
  posted_date_ms?: number; // new field for optional sort by job posted date
  table?: 'valid' | 'invalid';
};

export type ModalState =
  | null
  | {
      kind: 'edit';
      table: 'valid' | 'invalid';
      id: string;
      currentUrl: string;
    }
  | {
      kind: 'reportInvalid';
      table: 'valid' | 'invalid';
      id: string;
      currentUrl: string;
    }
  | {
      kind: 'reportDuplicate';
      table: 'valid' | 'invalid';
      id: string;
      currentUrl: string;
    }
  | {
      kind: 'replaceInvalid';
      invalidJobId: string;
      invalidUrl: string;
      validJobId: string;
      validUrl: string;
    }
  | {
      kind: 'delete';
      table: 'valid' | 'invalid';
      id: string;
      currentUrl: string;
    };
