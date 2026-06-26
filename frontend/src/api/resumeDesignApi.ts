import { apiClient } from './client';
import type {
  ResumeDesign,
  ResumeDesignResponse,
  ResumeThemeCatalog,
} from '../types/resumeDesign';
import type { ResumeTemplateStatusPayload } from '../types/resumeTemplate';

export async function fetchResumeThemeCatalog(): Promise<ResumeThemeCatalog> {
  const { data } = await apiClient.get<ResumeThemeCatalog>('/settings/resume-template/themes');
  return data;
}

export async function fetchResumeDesign(): Promise<ResumeDesignResponse> {
  const { data } = await apiClient.get<ResumeDesignResponse>('/settings/resume-template/design');
  return data;
}

export async function saveResumeDesign(design: ResumeDesign): Promise<ResumeTemplateStatusPayload> {
  const { data } = await apiClient.put<ResumeTemplateStatusPayload>(
    '/settings/resume-template/design',
    { design },
  );
  return data;
}

export async function previewResumeDesignPdf(design: ResumeDesign): Promise<Blob> {
  const res = await apiClient.post('/settings/resume-template/design/preview', { design }, {
    responseType: 'blob',
  });
  return new Blob([res.data], { type: 'application/pdf' });
}
