import { apiClient } from './client';
import type {
  ResumeTemplateBlueprint,
  ResumeTemplateRequirements,
  ResumeTemplateStatusPayload,
  ResumeTemplateAiValidation,
  TemplateVariableDefinition,
} from '../types/resumeTemplate';

function normalizeAiValidation(
  data: Partial<ResumeTemplateAiValidation> | null | undefined,
): ResumeTemplateAiValidation | null {
  if (!data || typeof data !== 'object') return null;
  return {
    passed: Boolean(data.passed),
    template_type: (data.template_type as ResumeTemplateAiValidation['template_type']) ?? 'unknown',
    summary: String(data.summary ?? ''),
    errors: Array.isArray(data.errors) ? data.errors.map(String) : [],
    warnings: Array.isArray(data.warnings) ? data.warnings.map(String) : [],
    suggestions: Array.isArray(data.suggestions) ? data.suggestions.map(String) : [],
    detected_required_tags: Array.isArray(data.detected_required_tags)
      ? data.detected_required_tags.map(String)
      : [],
    missing_required_tags: Array.isArray(data.missing_required_tags)
      ? data.missing_required_tags.map(String)
      : [],
    validated_at: (data.validated_at as string | null | undefined) ?? null,
  };
}

function normalizeRequirements(
  data: Partial<ResumeTemplateRequirements> | null | undefined,
): ResumeTemplateRequirements | null {
  if (!data || typeof data !== 'object') return null;
  return {
    file_format: {
      extension: String(data.file_format?.extension ?? '.docx'),
      mime_type: String(data.file_format?.mime_type ?? ''),
      max_bytes: Number(data.file_format?.max_bytes ?? 5_000_000),
      notes: String(data.file_format?.notes ?? ''),
    },
    resume_style_title: String(data.resume_style_title ?? 'Résumé layout your template should follow'),
    resume_style_intro: String(data.resume_style_intro ?? ''),
    resume_style_sections: Array.isArray(data.resume_style_sections) ? data.resume_style_sections : [],
    template_types: Array.isArray(data.template_types) ? data.template_types : [],
    validation_notes: Array.isArray(data.validation_notes) ? data.validation_notes.map(String) : [],
    profile_work_count: Number(data.profile_work_count ?? 0),
  };
}

function normalizeStatus(data: Partial<ResumeTemplateStatusPayload>): ResumeTemplateStatusPayload {
  return {
    resume_template_status: (data.resume_template_status as ResumeTemplateStatusPayload['resume_template_status']) ?? 'missing',
    resume_template_source_filename: data.resume_template_source_filename ?? null,
    resume_template_error: data.resume_template_error ?? null,
    resume_template_profile_work_count: data.resume_template_profile_work_count ?? null,
    resume_template_analyzed_at: data.resume_template_analyzed_at ?? null,
    resume_template_ready: Boolean(data.resume_template_ready),
    sections: Array.isArray(data.sections) ? data.sections : [],
    detected_tags: Array.isArray(data.detected_tags) ? data.detected_tags : [],
    warnings: Array.isArray(data.warnings) ? data.warnings : [],
    profile_work_count: Number(data.profile_work_count ?? 0),
    validation_errors: Array.isArray(data.validation_errors) ? data.validation_errors.map(String) : [],
    detected_template_type: (data.detected_template_type as ResumeTemplateStatusPayload['detected_template_type']) ?? null,
    ai_validation: normalizeAiValidation(data.ai_validation),
    requirements: normalizeRequirements(data.requirements),
  };
}

export async function fetchResumeTemplateRequirements(): Promise<ResumeTemplateRequirements> {
  const { data } = await apiClient.get<Partial<ResumeTemplateRequirements>>(
    '/settings/resume-template/requirements',
  );
  return normalizeRequirements(data) ?? {
    file_format: {
      extension: '.docx',
      mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      max_bytes: 5_000_000,
      notes: '',
    },
    resume_style_title: 'Résumé layout your template should follow',
    resume_style_intro: '',
    resume_style_sections: [],
    template_types: [],
    validation_notes: [],
    profile_work_count: 0,
  };
}

export async function fetchResumeTemplateStatus(): Promise<ResumeTemplateStatusPayload> {
  const { data } = await apiClient.get<Partial<ResumeTemplateStatusPayload>>('/settings/resume-template');
  return normalizeStatus(data);
}

export async function uploadResumeTemplate(file: File): Promise<ResumeTemplateStatusPayload> {
  const form = new FormData();
  form.append('file', file);
  const { data } = await apiClient.post<Partial<ResumeTemplateStatusPayload>>(
    '/settings/resume-template/upload',
    form,
    { headers: { 'Content-Type': 'multipart/form-data' } },
  );
  return normalizeStatus(data);
}

export async function saveResumeTemplateBlueprint(
  blueprint: ResumeTemplateBlueprint,
): Promise<ResumeTemplateStatusPayload> {
  const { data } = await apiClient.put<Partial<ResumeTemplateStatusPayload>>(
    '/settings/resume-template/blueprint',
    { blueprint },
  );
  return normalizeStatus(data);
}

export async function reanalyzeResumeTemplate(): Promise<ResumeTemplateStatusPayload> {
  const { data } = await apiClient.post<Partial<ResumeTemplateStatusPayload>>(
    '/settings/resume-template/reanalyze',
  );
  return normalizeStatus(data);
}

export async function fetchResumeTemplateVariables(): Promise<TemplateVariableDefinition[]> {
  const { data } = await apiClient.get<{ variables: TemplateVariableDefinition[] }>(
    '/settings/resume-template/variables',
  );
  return Array.isArray(data.variables) ? data.variables : [];
}

export async function downloadResumeTemplatePreview(): Promise<Blob> {
  const { data } = await apiClient.post<Blob>(
    '/settings/resume-template/preview',
    {},
    { responseType: 'blob' },
  );
  return data;
}
