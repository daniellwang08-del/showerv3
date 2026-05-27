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

export async function fetchCoverLetterTemplateRequirements(): Promise<CoverLetterTemplateRequirements> {
  const { data } = await apiClient.get<Partial<CoverLetterTemplateRequirements>>(
    '/settings/cover-letter-template/requirements',
  );
  return {
    max_bytes: Number(data.max_bytes ?? 5_000_000),
    required_tags: Array.isArray(data.required_tags) ? data.required_tags : [],
    optional_tags: Array.isArray(data.optional_tags) ? data.optional_tags : [],
    layout_example: String(data.layout_example ?? ''),
    notes: Array.isArray(data.notes) ? (data.notes as string[]) : [],
  };
}

export async function fetchCoverLetterTemplateStatus(): Promise<CoverLetterTemplateStatusPayload> {
  const { data } = await apiClient.get<Partial<CoverLetterTemplateStatusPayload>>(
    '/settings/cover-letter-template',
  );
  return normalizeStatus(data);
}

export async function uploadCoverLetterTemplate(file: File): Promise<CoverLetterTemplateStatusPayload> {
  const form = new FormData();
  form.append('file', file);
  const { data } = await apiClient.post<Partial<CoverLetterTemplateStatusPayload>>(
    '/settings/cover-letter-template/upload',
    form,
    { headers: { 'Content-Type': 'multipart/form-data' } },
  );
  return normalizeStatus(data);
}

export async function revalidateCoverLetterTemplate(): Promise<CoverLetterTemplateStatusPayload> {
  const { data } = await apiClient.post<Partial<CoverLetterTemplateStatusPayload>>(
    '/settings/cover-letter-template/revalidate',
  );
  return normalizeStatus(data);
}

export async function downloadCoverLetterTemplatePreview(): Promise<Blob> {
  const { data } = await apiClient.post<Blob>(
    '/settings/cover-letter-template/preview',
    undefined,
    { responseType: 'blob' },
  );
  return data;
}
