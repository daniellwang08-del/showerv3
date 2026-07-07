import { apiClient } from './client';
import type {
  CoverLetterTemplateRequirements,
  CoverLetterTemplateStatusPayload,
} from '../types/coverLetterTemplate';

function normalizeStatus(
  data: Partial<CoverLetterTemplateStatusPayload>,
): CoverLetterTemplateStatusPayload {
  return {
    cover_letter_template_status:
      (data.cover_letter_template_status as CoverLetterTemplateStatusPayload['cover_letter_template_status']) ??
      'missing',
    cover_letter_template_source_filename:
      (data.cover_letter_template_source_filename as string | null | undefined) ?? null,
    cover_letter_template_error: (data.cover_letter_template_error as string | null | undefined) ?? null,
    cover_letter_template_analyzed_at:
      (data.cover_letter_template_analyzed_at as string | null | undefined) ?? null,
    cover_letter_template_ready: Boolean(data.cover_letter_template_ready),
    detected_tags: Array.isArray(data.detected_tags) ? (data.detected_tags as string[]) : [],
    validation_errors: Array.isArray(data.validation_errors) ? (data.validation_errors as string[]) : [],
    validation_warnings: Array.isArray(data.validation_warnings) ? (data.validation_warnings as string[]) : [],
    requirements: (data.requirements as CoverLetterTemplateRequirements | null | undefined) ?? null,
  };
}

/** Compile the cover letter template from the user's saved Resume Builder design. */
export async function generateCoverLetterFromResumeDesign(): Promise<CoverLetterTemplateStatusPayload> {
  const { data } = await apiClient.post<Partial<CoverLetterTemplateStatusPayload>>(
    '/settings/cover-letter-template/from-resume-design',
  );
  return normalizeStatus(data);
}
