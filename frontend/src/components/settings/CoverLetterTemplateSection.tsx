import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Download,
  FileUp,
  Loader2,
  Mail,
  RefreshCw,
} from 'lucide-react';
import {
  downloadCoverLetterTemplatePreview,
  fetchCoverLetterTemplateStatus,
  revalidateCoverLetterTemplate,
  uploadCoverLetterTemplate,
} from '../../api/coverLetterTemplateApi';
import type {
  CoverLetterTemplateRequirements,
  CoverLetterTemplateStatus,
  CoverLetterTemplateStatusPayload,
} from '../../types/coverLetterTemplate';

function statusBadge(status: CoverLetterTemplateStatus) {
  const styles: Record<CoverLetterTemplateStatus, string> = {
    missing: 'bg-slate-100 text-slate-700',
    processing: 'bg-blue-100 text-blue-800',
    ready: 'bg-emerald-100 text-emerald-800',
    failed: 'bg-rose-100 text-rose-800',
  };
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${styles[status]}`}>
      {status}
    </span>
  );
}

function formatMaxBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function RequirementsPanel({ requirements }: { requirements: CoverLetterTemplateRequirements }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/80">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500"
      >
        Required placeholder
        {open ? <ChevronUp size={15} className="text-slate-500" /> : <ChevronDown size={15} className="text-slate-500" />}
      </button>
      {open && (
        <div className="border-t border-slate-200 px-3 py-3 text-sm">
          <ul className="space-y-1.5">
            {requirements.required_tags.map((p) => (
              <li key={p.tag} className="text-xs text-slate-800">
                <code className="rounded bg-emerald-50 px-1 py-0.5 font-semibold text-emerald-900 ring-1 ring-emerald-100">
                  {p.tag}
                </code>{' '}
                <span className="text-slate-600">{p.description}</span>
              </li>
            ))}
          </ul>
          {requirements.layout_example && (
            <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-md bg-slate-900 px-3 py-2 text-[11px] leading-relaxed text-slate-100">
              {requirements.layout_example}
            </pre>
          )}
          {requirements.notes.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-slate-600">
              {requirements.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

interface CoverLetterTemplateSectionProps {
  onStatusChange?: (status: CoverLetterTemplateStatusPayload) => void;
}

export function CoverLetterTemplateSection({ onStatusChange }: CoverLetterTemplateSectionProps) {
  const [statusData, setStatusData] = useState<CoverLetterTemplateStatusPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [revalidating, setRevalidating] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [message, setMessage] = useState('');
  const [messageOk, setMessageOk] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const applyStatus = useCallback(
    (data: CoverLetterTemplateStatusPayload) => {
      setStatusData(data);
      onStatusChange?.(data);
    },
    [onStatusChange],
  );

  const refresh = useCallback(async () => {
    try {
      const data = await fetchCoverLetterTemplateStatus();
      applyStatus(data);
    } catch {
      setMessage('Failed to load cover letter template status.');
      setMessageOk(false);
    } finally {
      setLoading(false);
    }
  }, [applyStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleUpload = async (file: File | null) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.docx')) {
      setMessage('Only .docx files are supported.');
      setMessageOk(false);
      return;
    }
    const maxBytes = statusData?.requirements?.max_bytes ?? 5_000_000;
    if (file.size > maxBytes) {
      setMessage(`File exceeds maximum size of ${formatMaxBytes(maxBytes)}.`);
      setMessageOk(false);
      return;
    }
    setUploading(true);
    setMessage('');
    try {
      const data = await uploadCoverLetterTemplate(file);
      applyStatus(data);
      setMessage(
        data.cover_letter_template_status === 'ready'
          ? 'Cover letter template uploaded and validated.'
          : 'Upload received - fix validation issues and re-upload.',
      );
      setMessageOk(data.cover_letter_template_status === 'ready');
    } catch (err: unknown) {
      const detail =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : null;
      setMessage(typeof detail === 'string' ? detail : 'Upload failed.');
      setMessageOk(false);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRevalidate = async () => {
    setRevalidating(true);
    setMessage('');
    try {
      const data = await revalidateCoverLetterTemplate();
      applyStatus(data);
      setMessage(
        data.cover_letter_template_status === 'ready'
          ? 'Template re-validated successfully.'
          : 'Validation failed - see errors below.',
      );
      setMessageOk(data.cover_letter_template_status === 'ready');
    } catch (err: unknown) {
      const detail =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : null;
      setMessage(typeof detail === 'string' ? detail : 'Re-validation failed.');
      setMessageOk(false);
    } finally {
      setRevalidating(false);
    }
  };

  const handlePreview = async () => {
    setPreviewing(true);
    setMessage('');
    try {
      const blob = await downloadCoverLetterTemplatePreview();
      downloadBlob(blob, 'cover-letter-template-preview.docx');
      setMessage('Preview downloaded.');
      setMessageOk(true);
    } catch (err: unknown) {
      const detail =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : null;
      setMessage(typeof detail === 'string' ? detail : 'Preview failed.');
      setMessageOk(false);
    } finally {
      setPreviewing(false);
    }
  };

  const status = statusData?.cover_letter_template_status ?? 'missing';
  const requirements = statusData?.requirements;

  return (
    <section id="cover-letter-template" className="h-full scroll-mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-teal-500 to-cyan-600 text-white">
          <Mail size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-base font-bold text-slate-900">Cover letter template</h2>
              <p className="mt-0.5 text-sm leading-snug text-slate-500">
                AI fills <code className="rounded bg-slate-100 px-1 text-[11px]">{'{{COVER_LETTER_BODY}}'}</code> per job.
              </p>
            </div>
            {!loading && statusBadge(status)}
          </div>

          {loading ? (
            <div className="mt-4 flex items-center gap-2 text-sm text-slate-500">
              <Loader2 size={16} className="animate-spin" />
              Loading template status…
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              {requirements && <RequirementsPanel requirements={requirements} />}

              {statusData?.cover_letter_template_source_filename && (
                <p className="text-sm text-slate-700">
                  Current file:{' '}
                  <span className="font-medium">{statusData.cover_letter_template_source_filename}</span>
                </p>
              )}

              {status === 'missing' && (
                <p className="text-xs text-slate-500">
                  Upload a .docx with <code className="rounded bg-slate-100 px-1">{'{{COVER_LETTER_BODY}}'}</code>{' '}
                  before cover letter documents can be generated for jobs.
                </p>
              )}

              {statusData?.validation_errors && statusData.validation_errors.length > 0 && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5">
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-rose-900">
                    <AlertCircle size={14} />
                    Validation issues
                  </p>
                  <ul className="mt-1.5 list-disc pl-4 text-xs text-rose-800 space-y-1">
                    {statusData.validation_errors.map((err) => (
                      <li key={err}>{err}</li>
                    ))}
                  </ul>
                </div>
              )}

              {statusData?.validation_warnings && statusData.validation_warnings.length > 0 && status === 'ready' && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
                  {statusData.validation_warnings.map((w) => (
                    <p key={w}>{w}</p>
                  ))}
                </div>
              )}

              {status === 'ready' && (
                <p className="flex items-center gap-1.5 text-sm text-emerald-700">
                  <CheckCircle2 size={16} />
                  Template ready for job-specific cover letters.
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  className="hidden"
                  onChange={(e) => void handleUpload(e.target.files?.[0] ?? null)}
                />
                <button
                  type="button"
                  disabled={uploading}
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {uploading ? <Loader2 size={14} className="animate-spin" /> : <FileUp size={14} />}
                  {statusData?.cover_letter_template_source_filename ? 'Replace template' : 'Upload template'}
                </button>

                {statusData?.cover_letter_template_source_filename && (
                  <button
                    type="button"
                    disabled={revalidating}
                    onClick={() => void handleRevalidate()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {revalidating ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                    Re-validate
                  </button>
                )}

                {status === 'ready' && (
                  <button
                    type="button"
                    disabled={previewing || !statusData?.cover_letter_template_ready}
                    onClick={() => void handlePreview()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {previewing ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                    Preview
                  </button>
                )}
              </div>

              {message && (
                <p className={`text-sm ${messageOk ? 'text-emerald-700' : 'text-rose-700'}`}>{message}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
