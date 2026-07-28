import { apiClient } from './client';
import type {
  ResumeDesign,
  ResumeDesignResponse,
  ResumeThemeCatalog,
  ThemePreset,
} from '../types/resumeDesign';
import type { ResumeTemplateStatusPayload } from '../types/resumeTemplate';
import { filenameFromContentDisposition, namedPdfFile } from '../utils/resumeFileName';

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

export type ResumeDesignPreview = {
  /** Same-origin URL ending in ``Name_resume.pdf`` (preferred for the PDF iframe title). */
  url: string;
  filename: string;
};
let previewAbort: AbortController | null = null;

/** Drop in-flight preview requests after a design save or explicit reset. */
export function invalidateResumeDesignPreviewCache(): void {
  previewAbort?.abort();
  previewAbort = null;
}

/** Accurate builder preview: the real dxpdf PDF (same bytes as export). */
export async function previewResumeDesignPdf(design: ResumeDesign): Promise<ResumeDesignPreview> {
  // Always POST: server PDF cache is cheap on repeat designs, and each response mints a
  // fresh short-lived token URL (stale tokens 404 after TTL).
  previewAbort?.abort();
  const controller = new AbortController();
  previewAbort = controller;

  try {
    const res = await apiClient.post('/settings/resume-template/design/preview', { design }, {
      responseType: 'blob',
      signal: controller.signal,
    });
    const filename = filenameFromContentDisposition(
      res.headers?.['content-disposition'] as string | undefined,
      'Resume_resume.pdf',
    );
    const previewPath = (res.headers?.['x-resume-preview-path'] as string | undefined) || '';
    // Prefer the named HTTP path so Chromium's PDF chrome shows ``Name_resume.pdf``
    // instead of a blob UUID. Fall back to a named File object URL.
    const url = previewPath
      ? previewPath
      : URL.createObjectURL(namedPdfFile(res.data, filename));
    return { url, filename };
  } catch (err: unknown) {
    if (controller.signal.aborted) {
      throw new DOMException('Preview request aborted', 'AbortError');
    }
    throw err;
  } finally {
    if (previewAbort === controller) previewAbort = null;
  }
}
