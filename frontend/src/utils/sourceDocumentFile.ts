/** Keep in sync with backend `detect_source_document_kind` / `MAX_SOURCE_BYTES`. */
export const SOURCE_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

export const SOURCE_DOCUMENT_ACCEPT = [
  '.pdf',
  '.docx',
  '.md',
  '.markdown',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/markdown',
  'text/x-markdown',
].join(',');

const SOURCE_DOCUMENT_EXTENSIONS = ['.pdf', '.docx', '.md', '.markdown'] as const;

export function isAllowedSourceDocumentFilename(name: string): boolean {
  const lower = (name || '').replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  return SOURCE_DOCUMENT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function sourceDocumentFileError(file: File): string | null {
  if (!isAllowedSourceDocumentFilename(file.name)) {
    return 'Please choose a PDF, DOCX, or Markdown (.md) file.';
  }
  if (file.size > SOURCE_DOCUMENT_MAX_BYTES) {
    return 'Project source file must be 10 MB or smaller.';
  }
  return null;
}

export function sourceKindLabel(kind: string): string {
  switch ((kind || '').toLowerCase()) {
    case 'markdown':
      return 'MD';
    case 'docx':
      return 'DOCX';
    case 'pdf':
      return 'PDF';
    default:
      return (kind || '').toUpperCase() || 'FILE';
  }
}
