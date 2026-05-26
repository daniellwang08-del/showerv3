import { apiClient } from './client';
import type {
  ProfileSourceDocument,
  ProfileSourceDocumentListResponse,
  ProfileSourceDocumentUploadResponse,
} from '../types/profileSourceDocument';

export async function listProfileSourceDocuments(): Promise<ProfileSourceDocument[]> {
  const res = await apiClient.get<ProfileSourceDocumentListResponse>('/profile/source-documents');
  return res.data.documents ?? [];
}

export async function uploadProfileSourceDocument(
  file: File,
  companyName?: string,
): Promise<ProfileSourceDocumentUploadResponse> {
  const fd = new FormData();
  fd.append('file', file);
  const params = companyName?.trim() ? { company_name: companyName.trim() } : undefined;
  const res = await apiClient.post<ProfileSourceDocumentUploadResponse>(
    '/profile/source-documents',
    fd,
    { params },
  );
  return res.data;
}

export async function updateProfileSourceDocumentCompany(
  docId: string,
  companyName: string,
): Promise<ProfileSourceDocument> {
  const res = await apiClient.patch<ProfileSourceDocument>(`/profile/source-documents/${docId}`, {
    company_name: companyName,
  });
  return res.data;
}

export async function reparseProfileSourceDocument(docId: string): Promise<ProfileSourceDocument> {
  const res = await apiClient.post<ProfileSourceDocument>(`/profile/source-documents/${docId}/reparse`);
  return res.data;
}

export async function deleteProfileSourceDocument(docId: string): Promise<void> {
  await apiClient.delete(`/profile/source-documents/${docId}`);
}

export function formatDocSize(charCount: number): string {
  if (charCount >= 1_000_000) return `${(charCount / 1_000_000).toFixed(1)}M chars`;
  if (charCount >= 1000) return `${Math.round(charCount / 1000)}k chars`;
  return `${charCount} chars`;
}

export function parseStatusLabel(status: string): string {
  switch (status) {
    case 'completed':
      return 'Ready';
    case 'parsing':
      return 'Parsing…';
    case 'failed':
      return 'Failed';
    case 'pending':
      return 'Pending';
    default:
      return status;
  }
}
