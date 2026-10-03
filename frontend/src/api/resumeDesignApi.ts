import { apiClient } from './client';
import type {
  ResumeDesign,
  ResumeDesignResponse,
  ResumeThemeCatalog,
  ThemePreset,
} from '../types/resumeDesign';
import type { ResumeTemplateStatusPayload } from '../types/resumeTemplate';

export async function fetchResumeThemeCatalog(): Promise<ResumeThemeCatalog> {
  const { data } = await apiClient.get<ResumeThemeCatalog>('/settings/resume-template/themes');
  return data;
}

export async function saveCustomResumeTheme(
  name: string,
  design: ResumeDesign,
): Promise<{ theme: ThemePreset; themes: ThemePreset[] }> {
  const { data } = await apiClient.post<{ theme: ThemePreset; themes: ThemePreset[] }>(
    '/resume-builder/themes',
    { name, design },
  );
  return data;
}

export async function toggleResumeThemeLove(
  themeId: string,
): Promise<{ theme_id: string; is_loved: boolean; themes: ThemePreset[] }> {
  const { data } = await apiClient.post<{
    theme_id: string;
    is_loved: boolean;
    themes: ThemePreset[];
  }>(`/resume-builder/themes/${encodeURIComponent(themeId)}/love`);
  return data;
}

export async function deleteCustomResumeTheme(
  themeId: string,
): Promise<{ themes: ThemePreset[] }> {
  const { data } = await apiClient.delete<{ themes: ThemePreset[] }>(
    `/resume-builder/themes/${encodeURIComponent(themeId)}`,
  );
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
