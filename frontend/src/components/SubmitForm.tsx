import type { FormEvent } from 'react';
import { useMemo, useRef, useState } from 'react';
import { FileText, Loader2, Paperclip, Send, X } from 'lucide-react';
import type { AttachmentFlowStatus } from '../types/ui';
import { AttachmentJobProgress } from './AttachmentJobProgress';

type Props = {
  url: string;
  onUrlChange: (next: string) => void;
  loading: boolean;
  onSubmit: (e: FormEvent) => void;
  submitNotice: string;
  submitNoticeKind: 'success' | 'warning';
  submitError: string;
  attachmentFlow: AttachmentFlowStatus;
  onSubmitAttachment: (files: File[]) => Promise<void>;
};

const ACCEPT =
  '.docx,.xlsx,.txt,.text,.md,.markdown,.html,.htm,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,text/markdown,text/html';

export function SubmitForm({
  url,
  onUrlChange,
  loading,
  onSubmit,
  submitNotice,
  submitNoticeKind,
  submitError,
  attachmentFlow,
  onSubmitAttachment,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);

  const busy = loading || !!attachmentFlow;
  const hasPendingAttachment = pendingFiles.length > 0;

  const attachmentLabel = useMemo(() => {
    if (pendingFiles.length === 0) return '';
    if (pendingFiles.length === 1) return pendingFiles[0].name;
    return `${pendingFiles[0].name} +${pendingFiles.length - 1} more`;
  }, [pendingFiles]);

  const attachmentTitle = useMemo(
    () => pendingFiles.map((f) => f.name).join('\n'),
    [pendingFiles],
  );

  const handleFormSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (hasPendingAttachment) {
      try {
        await onSubmitAttachment(pendingFiles);
        setPendingFiles([]);
      } catch {
        // errors shown via submitError from parent
      }
      return;
    }
    onSubmit(e);
  };

  const clearPendingAttachment = () => {
    if (busy) return;
    setPendingFiles([]);
  };

  return (
    <div className="glass-card min-w-0 rounded-2xl border border-blue-200/60 bg-gradient-to-br from-white/90 to-blue-50/50 p-5 shadow-sm">
      <form onSubmit={handleFormSubmit} className="min-w-0">
        <div className="flex min-w-0 flex-col gap-0 sm:flex-row sm:items-stretch">
          <input
            ref={fileRef}
            type="file"
            className="sr-only"
            multiple
            accept={ACCEPT}
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              const list = e.target.files;
              if (list?.length) setPendingFiles(Array.from(list));
              e.target.value = '';
            }}
          />
          {/* Single bordered field: attach | URL or attachment summary */}
          <div className="flex min-h-11 min-w-0 flex-1 overflow-hidden rounded-t-lg border border-[rgba(147,197,253,0.8)] bg-[rgba(255,255,255,0.92)] shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] transition-[border-color,box-shadow,background-color] duration-[180ms] focus-within:border-[rgba(59,130,246,0.95)] focus-within:bg-white focus-within:shadow-[0_0_0_3px_rgba(59,130,246,0.2),inset_0_1px_0_rgba(255,255,255,0.85)] sm:rounded-l-lg sm:rounded-r-none">
            <button
              type="button"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
              title="Attach Word, Excel, Markdown, text, or HTML — URLs will be detected with AI"
              aria-label="Attach documents to import job URLs"
              className={[
                'flex w-11 shrink-0 items-center justify-center border-r border-[rgba(147,197,253,0.65)] bg-gradient-to-b from-white to-slate-50/90 text-slate-500',
                'shadow-[inset_-1px_0_0_rgba(255,255,255,0.9)] transition-colors duration-150',
                'hover:bg-blue-50/80 hover:text-blue-700',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/35',
                'disabled:cursor-not-allowed disabled:opacity-50',
                attachmentFlow ? 'bg-blue-50/70 text-blue-700' : '',
              ].join(' ')}
            >
              {attachmentFlow ? (
                <Loader2 className="h-5 w-5 shrink-0 animate-spin text-blue-600" aria-hidden />
              ) : (
                <Paperclip className="h-5 w-5 shrink-0" strokeWidth={2} aria-hidden />
              )}
            </button>

            {attachmentFlow ? (
              <AttachmentJobProgress status={attachmentFlow} />
            ) : hasPendingAttachment ? (
              <div
                className="flex min-w-0 flex-1 items-center gap-2 bg-gradient-to-r from-blue-50/95 via-sky-50/60 to-white py-2 pl-2 pr-1"
                title={attachmentTitle}
              >
                <FileText className="h-4 w-4 shrink-0 text-blue-600" strokeWidth={2} aria-hidden />
                <span className="min-w-0 flex-1 truncate text-left text-sm font-medium text-slate-800">
                  {attachmentLabel}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={clearPendingAttachment}
                  aria-label="Remove attachment"
                  title="Remove attachment"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-500 transition hover:bg-red-100 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <X className="h-4 w-4" strokeWidth={2.5} aria-hidden />
                </button>
              </div>
            ) : (
              <input
                type="url"
                id="url"
                value={url}
                onChange={(e) => onUrlChange(e.target.value)}
                disabled={busy}
                className="min-w-0 flex-1 border-0 bg-transparent py-2.5 pl-2 pr-3 text-sm text-slate-900 outline-none ring-0 placeholder:text-slate-500 focus:ring-0 disabled:cursor-not-allowed disabled:opacity-60"
                placeholder="https://boards.greenhouse.io/..."
                required
                autoComplete="off"
                inputMode="url"
              />
            )}
          </div>

          <button
            type="submit"
            disabled={busy}
            aria-busy={busy}
            aria-label={
              busy
                ? 'Working…'
                : hasPendingAttachment
                  ? 'Submit attachment and import job URLs'
                  : 'Submit job URL'
            }
            title={busy ? 'Working…' : hasPendingAttachment ? 'Submit attachment' : 'Submit'}
            className="btn-blue-neon btn-submit-icon inline-flex h-11 w-full shrink-0 items-center justify-center rounded-b-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:cursor-not-allowed disabled:opacity-70 sm:w-[3.25rem] sm:min-w-[4.25rem] sm:max-w-[3.25rem] sm:rounded-l-none sm:rounded-r-lg"
          >
            {busy ? (
              <Loader2 className="h-5 w-5 shrink-0 animate-spin" strokeWidth={2.25} aria-hidden />
            ) : (
              <Send className="h-5 w-5 shrink-0" strokeWidth={2.25} aria-hidden />
            )}
          </button>
        </div>

        {submitNotice && submitNoticeKind === 'warning' && (
          <div className="mt-3 text-sm font-medium text-amber-700">
            ⚠ {submitNotice}
          </div>
        )}

        {submitError && <div className="mt-3 text-sm font-medium text-red-700">✕ {submitError}</div>}
      </form>
    </div>
  );
}
