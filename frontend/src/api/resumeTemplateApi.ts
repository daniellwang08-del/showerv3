import { apiClient } from './client';

/** Download a .docx rendered from the user's saved Resume Builder design. */
export async function downloadResumeTemplatePreview(): Promise<Blob> {
  const { data } = await apiClient.post<Blob>(
    '/settings/resume-template/preview',
    {},
    { responseType: 'blob' },
  );
  return data;
}
