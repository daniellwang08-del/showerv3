export type CoverLetterTemplateStatus = 'missing' | 'processing' | 'ready' | 'failed';

export interface CoverLetterPlaceholderSpec {
  tag: string;
  description: string;
  required?: boolean;
}

export interface CoverLetterTemplateRequirements {
  max_bytes: number;
  required_tags: CoverLetterPlaceholderSpec[];
  optional_tags: CoverLetterPlaceholderSpec[];
  layout_example: string;
  notes: string[];
}

export interface CoverLetterTemplateStatusPayload {
  cover_letter_template_status: CoverLetterTemplateStatus;
  cover_letter_template_source_filename: string | null;
  cover_letter_template_error: string | null;
  cover_letter_template_analyzed_at: string | null;
  cover_letter_template_ready: boolean;
  detected_tags: string[];
  validation_errors: string[];
  validation_warnings: string[];
  requirements?: CoverLetterTemplateRequirements | null;
}
