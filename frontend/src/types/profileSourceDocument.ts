export type ProfileSourceDocument = {
  id: string;
  filename: string;
  source_kind: string;
  company_name: string | null;
  char_count: number;
  project_count: number;
  parse_status: 'pending' | 'parsing' | 'completed' | 'failed' | string;
  parse_error: string | null;
  created_at: string;
  updated_at: string;
};

export type ProfileSourceDocumentListResponse = {
  documents: ProfileSourceDocument[];
};

export type ProfileSourceDocumentUploadResponse = {
  document: ProfileSourceDocument;
  warnings: string[];
};
