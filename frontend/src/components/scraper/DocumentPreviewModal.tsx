import { useEffect, useState, useCallback } from 'react';
import { X, Download, ClipboardCopy, CheckCircle2, Loader2 } from 'lucide-react';
import { apiClient } from '../../api/client';

export type PreviewDocType = 'resume_pdf' | 'cover_letter_pdf';

interface DocumentPreviewModalProps {
  jobId: string;
  fileType: PreviewDocType;
  title: string;
  filePath: string | null;
  onClose: () => void;
}

async function fetchPdfBlob(jobId: string, fileType: PreviewDocType): Promise<Blob> {
  const res = await apiClient.get(`/jobs/valid/${jobId}/resume-build/download/${fileType}`, {
    responseType: 'blob',
  });
  return new Blob([res.data], { type: 'application/pdf' });
}

export function DocumentPreviewModal({
  jobId,
  fileType,
  title,
  filePath,
  onClose,
}: DocumentPreviewModalProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const blob = await fetchPdfBlob(jobId, fileType);
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setBlobUrl(url);
      } catch {
        if (!cancelled) setError('Could not load this document. Try downloading instead.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [jobId, fileType]);

  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  const handleDownload = useCallback(async () => {
    try {
      const blob = await fetchPdfBlob(jobId, fileType);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${fileType}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  }, [jobId, fileType]);

  const handleCopyPath = () => {
    if (!filePath) return;
    navigator.clipboard.writeText(filePath).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      className="fixed inset-0 z-[210] flex items-center justify-center p-4 animate-modal-backdrop-in"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="absolute inset-0 bg-slate-900/60 backdrop-blur-[3px]"
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        className="relative z-10 flex h-[90vh] w-[88vw] min-w-[640px] max-w-[1500px] animate-modal-in flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-900/10"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <h2 className="truncate text-sm font-semibold text-slate-800">{title}</h2>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => void handleDownload()}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-600 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700"
            >
              <Download size={14} />
              Download
            </button>
            {filePath && (
              <button
                type="button"
                onClick={handleCopyPath}
                className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition ${
                  copied
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50'
                }`}
              >
                {copied ? <CheckCircle2 size={14} /> : <ClipboardCopy size={14} />}
                {copied ? 'Copied' : 'Copy path'}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-red-50 hover:text-red-600 hover:border-red-200"
            >
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 bg-slate-100">
          {loading && (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-500">
              <Loader2 size={20} className="animate-spin text-blue-500" />
              Loading document…
            </div>
          )}
          {error && !loading && (
            <div className="flex h-full items-center justify-center px-6 text-sm text-red-600">
              {error}
            </div>
          )}
          {blobUrl && !loading && !error && (
            <iframe
              title={title}
              src={blobUrl}
              className="h-full w-full border-0 bg-white"
            />
          )}
        </div>
      </div>
    </div>
  );
}
