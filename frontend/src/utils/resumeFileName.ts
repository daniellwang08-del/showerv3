/** Parse a Content-Disposition header into a download filename. */
export function filenameFromContentDisposition(
  header: string | undefined | null,
  fallback: string,
): string {
  if (!header) return fallback;
  const utf = /filename\*=(?:UTF-8''|utf-8'')([^;]+)/i.exec(header);
  if (utf?.[1]) {
    try {
      return decodeURIComponent(utf[1].trim().replace(/^"+|"+$/g, ''));
    } catch {
      /* fall through */
    }
  }
  const quoted = /filename="([^"]+)"/i.exec(header);
  if (quoted?.[1]) return quoted[1].trim();
  const plain = /filename=([^;]+)/i.exec(header);
  if (plain?.[1]) return plain[1].trim().replace(/^"+|"+$/g, '');
  return fallback;
}

/** Build a filesystem-ish ``First_Last_resume.pdf`` from profile-ish name parts. */
export function personResumePdfName(
  first?: string | null,
  last?: string | null,
  kind: 'resume' | 'cover_letter' = 'resume',
): string {
  const raw = [first, last].map((p) => (p || '').trim()).filter(Boolean).join(' ');
  const slug =
    raw
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'Resume';
  const suffix = kind === 'cover_letter' ? 'cover_letter' : 'resume';
  return `${slug}_${suffix}.pdf`;
}

/** Named File so Chrome's PDF viewer shows a real title instead of a blob UUID. */
export function namedPdfFile(data: BlobPart, filename: string): File {
  const safe = filename.toLowerCase().endsWith('.pdf') ? filename : `${filename}.pdf`;
  return new File([data], safe, { type: 'application/pdf' });
}

/** Named download File (PDF or DOCX) using the server Content-Disposition when present. */
export function namedDownloadFile(
  data: BlobPart,
  contentDisposition: string | undefined | null,
  fallback: string,
  mime: string,
): File {
  const name = filenameFromContentDisposition(contentDisposition, fallback);
  return new File([data], name, { type: mime });
}
