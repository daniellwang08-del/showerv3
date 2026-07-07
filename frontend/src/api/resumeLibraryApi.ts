import { apiClient } from './client';
import type { ResumeDesign } from '../types/resumeDesign';
import type { ResumeLibraryResponse, ResumeSource, ResumeStatus } from '../types/resumeLibrary';

export async function fetchResumeLibrary(): Promise<ResumeLibraryResponse> {
  const { data } = await apiClient.get<ResumeLibraryResponse>('/resume-builder/resumes');
  return data;
}

export interface CreateResumeArgs {
  name: string;
  design: ResumeDesign;
  source?: ResumeSource;
  status?: ResumeStatus;
  job_title?: string | null;
  company?: string | null;
  activate?: boolean;
}

export async function createResume(args: CreateResumeArgs): Promise<ResumeLibraryResponse> {
  const { data } = await apiClient.post<ResumeLibraryResponse>('/resume-builder/resumes', {
    name: args.name,
    design: args.design,
    source: args.source ?? 'manual',
    status: args.status ?? 'draft',
    job_title: args.job_title ?? null,
    company: args.company ?? null,
    activate: args.activate ?? true,
  });
  return data;
}

export async function updateResume(
  resumeId: string,
  patch: { name?: string; status?: ResumeStatus; design?: ResumeDesign },
): Promise<ResumeLibraryResponse> {
  const { data } = await apiClient.put<ResumeLibraryResponse>(`/resume-builder/resumes/${resumeId}`, patch);
  return data;
}

export async function deleteResume(resumeId: string): Promise<ResumeLibraryResponse> {
  const { data } = await apiClient.delete<ResumeLibraryResponse>(`/resume-builder/resumes/${resumeId}`);
  return data;
}

export async function duplicateResume(resumeId: string): Promise<ResumeLibraryResponse> {
  const { data } = await apiClient.post<ResumeLibraryResponse>(`/resume-builder/resumes/${resumeId}/duplicate`);
  return data;
}

export async function activateResume(resumeId: string): Promise<ResumeLibraryResponse> {
  const { data } = await apiClient.post<ResumeLibraryResponse>(`/resume-builder/resumes/${resumeId}/activate`);
  return data;
}
