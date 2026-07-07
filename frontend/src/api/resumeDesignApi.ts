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

const PREVIEW_CACHE_MAX = 4;
const previewCache = new Map<string, Blob>();
let previewAbort: AbortController | null = null;

function previewCacheKey(design: ResumeDesign): string {
  return JSON.stringify(design);
}

/** Drop cached PDF previews after a design save or explicit reset. */
export function invalidateResumeDesignPreviewCache(): void {
  previewCache.clear();
  previewAbort?.abort();
  previewAbort = null;
}

export async function previewResumeDesignPdf(design: ResumeDesign): Promise<Blob> {
  const key = previewCacheKey(design);
  const cached = previewCache.get(key);
  if (cached) return cached;

  previewAbort?.abort();
  const controller = new AbortController();
  previewAbort = controller;

  try {
    const res = await apiClient.post('/settings/resume-template/design/preview', { design }, {
      responseType: 'blob',
      signal: controller.signal,
    });
    const blob = new Blob([res.data], { type: 'application/pdf' });
    previewCache.set(key, blob);
    while (previewCache.size > PREVIEW_CACHE_MAX) {
      const oldest = previewCache.keys().next().value;
      if (oldest == null) break;
      previewCache.delete(oldest);
    }
    return blob;
  } catch (err: unknown) {
    if (controller.signal.aborted) {
      throw new DOMException('Preview request aborted', 'AbortError');
    }
    throw err;
  } finally {
    if (previewAbort === controller) previewAbort = null;
  }
}
