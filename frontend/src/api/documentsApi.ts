import { API_BASE_URL, apiClient } from './client';
import type { ResumeDesign } from '../types/resumeDesign';
import type { ResumeLibraryItem } from '../types/resumeLibrary';
import { filenameFromContentDisposition } from '../utils/resumeFileName';

export type DocumentFileType = 'resume_pdf' | 'resume_docx' | 'cover_letter_pdf' | 'cover_letter_docx';
export type BuildFileStatus = 'pending' | 'processing' | 'completed' | 'failed' | string;

export interface LibraryDocument {
  id: string;
  name: string;
  status: 'draft' | 'completed';
  source: 'manual' | 'tailored';
  job_title: string | null;
  company: string | null;
  is_active: boolean;
  has_cover_letter: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface JobBuildDocument {
  id: string;
  job_id: string;
  job_title: string | null;
  company: string | null;
  job_url: string | null;
  content_status: string;
  content_error: string | null;
  files: Record<DocumentFileType, BuildFileStatus>;
  created_at: string | null;
  updated_at: string | null;
}

export interface DocumentsResponse {
  library: LibraryDocument[];
  builds: JobBuildDocument[];
  active_id: string | null;
}

export async function fetchDocuments(): Promise<DocumentsResponse> {
  const { data } = await apiClient.get<DocumentsResponse>('/documents');
  return data;
}

export interface RenderedFile {
  file: File;
  pageCount: number | null;
}

const MIME: Record<'pdf' | 'docx', string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function toFile(data: BlobPart, disposition: string | undefined, fallback: string, kind: 'pdf' | 'docx'): File {
  return new File([data], filenameFromContentDisposition(disposition, fallback), { type: MIME[kind] });
}

/** Print a (possibly unsaved) design with the server renderer, the same file a download gets. */
export async function renderDesign(
  design: ResumeDesign,
  kind: 'pdf' | 'docx',
  opts: { coverLetter?: string | null; signal?: AbortSignal } = {},
): Promise<RenderedFile> {
  const res = await apiClient.post(
    `/documents/render/${kind}`,
    { design, cover_letter: opts.coverLetter ?? null },
    { responseType: 'blob', signal: opts.signal },
  );
  const pages = Number(res.headers?.['x-page-count']);
  return {
    file: toFile(res.data, res.headers?.['content-disposition'] as string | undefined, `Resume.${kind}`, kind),
    pageCount: Number.isFinite(pages) && pages > 0 ? pages : null,
  };
}

function kindOf(fileType: DocumentFileType): 'pdf' | 'docx' {
  return fileType.endsWith('_pdf') ? 'pdf' : 'docx';
}

export async function fetchLibraryDocument(resumeId: string, fileType: DocumentFileType): Promise<File> {
  const res = await apiClient.get(
    `/documents/resumes/${encodeURIComponent(resumeId)}/download/${fileType}`,
    { responseType: 'blob' },
  );
  const kind = kindOf(fileType);
  return toFile(res.data, res.headers?.['content-disposition'] as string | undefined, `${fileType}.${kind}`, kind);
}

export async function fetchJobBuildDocument(jobId: string, fileType: DocumentFileType): Promise<File> {
  const res = await apiClient.get(
    `/jobs/valid/${encodeURIComponent(jobId)}/resume-build/download/${fileType}`,
    { responseType: 'blob' },
  );
  const kind = kindOf(fileType);
  return toFile(res.data, res.headers?.['content-disposition'] as string | undefined, `${fileType}.${kind}`, kind);
}

export async function fetchLibraryCoverLetter(resumeId: string): Promise<string | null> {
  const { data } = await apiClient.get<{ cover_letter: string | null }>(
    `/documents/resumes/${encodeURIComponent(resumeId)}/cover-letter`,
  );
  return data.cover_letter;
}

export async function saveLibraryCoverLetter(resumeId: string, coverLetter: string | null): Promise<string | null> {
  const { data } = await apiClient.put<{ cover_letter: string | null }>(
    `/documents/resumes/${encodeURIComponent(resumeId)}/cover-letter`,
    { cover_letter: coverLetter },
  );
  return data.cover_letter;
}

/** Save a File through the browser's download flow. */
export function saveFile(file: File): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export interface TailorStage {
  stage: string;
  label?: string;
}

export interface TailorResult {
  resume: ResumeLibraryItem | null;
  match: { score?: number; summary?: string } | null;
  has_cover_letter: boolean;
}

/** Tailor a resume and cover letter to a pasted job description; both are saved to the
 *  library. Streams progress through `onStage`. */
export async function tailorFromJobDescription(
  jobDescription: string,
  instructions: string,
  onStage: (ev: TailorStage) => void,
  signal?: AbortSignal,
): Promise<TailorResult> {
  const res = await fetch(`${API_BASE_URL}/documents/tailor`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ job_description: jobDescription, instructions }),
    signal,
  });
  if (!res.ok || !res.body) {
    if (res.status === 422) throw new Error('Paste the full job description (at least a few sentences).');
    throw new Error('Tailoring failed. Please try again.');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: TailorResult | null = null;
  let errorMessage: string | null = null;

  const handleFrame = (raw: string) => {
    const data = raw
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('\n');
    if (!data) return;
    let parsed: TailorStage & Partial<TailorResult> & { message?: string };
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (parsed.stage === 'done') {
      result = {
        resume: parsed.resume ?? null,
        match: parsed.match ?? null,
        has_cover_letter: Boolean(parsed.has_cover_letter),
      };
    } else if (parsed.stage === 'error') {
      errorMessage = parsed.message || 'Tailoring failed. Please try again.';
    } else if (parsed.stage) {
      onStage({ stage: parsed.stage, label: parsed.label });
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      handleFrame(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
    }
  }
  if (buffer.trim()) handleFrame(buffer);

  if (errorMessage) throw new Error(errorMessage);
  if (!result) throw new Error('Tailoring returned no result.');
  return result;
}
