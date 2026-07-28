import type { FormEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ClipboardPaste,
  FileText,
  FolderOpen,
  Loader2,
  Paperclip,
  Send,
  X,
} from 'lucide-react';
import { AttachmentJobProgress } from './AttachmentJobProgress';
import { useJobsStore } from '../../stores/jobsStore';
import { extractHttpUrlsFromText } from '../../utils/extractHttpUrls';

const ACCEPT =
  '.docx,.xlsx,.txt,.text,.md,.markdown,.html,.htm,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,text/markdown,text/html';

interface SubmitFormProps {
  /** When true, render without the standalone glass card so it can sit inside a toolbar. */
  inline?: boolean;
}

function PasteUrlsModal({
  open,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [localError, setLocalError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    setText('');
    setLocalError('');
    setSubmitting(false);
    const t = window.setTimeout(() => textareaRef.current?.focus(), 40);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  const urlCount = extractHttpUrlsFromText(text).length;
  const blocked = busy || submitting;

  const handleClean = () => {
    if (blocked) return;
    setText('');
    setLocalError('');
    textareaRef.current?.focus();
  };

  const handleSubmit = async () => {
    if (blocked) return;
    const urls = extractHttpUrlsFromText(text);
    if (!urls.length) {
      setLocalError('Paste at least one http(s) job URL.');
      return;
    }
    setLocalError('');
    setSubmitting(true);
    try {
      await onSubmit(text);
      onClose();
    } catch {
      // Error is surfaced via store submitError; keep modal open so the user can edit.
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-900/55 p-3 backdrop-blur-sm sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="paste-urls-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !blocked) onClose();
      }}
    >
      {/* ~2.5× prior max-w-lg (32rem) → ~80rem / 88vh so paste room dominates the viewport.
          Use inverted-slate semantic colors (slate-900 = brightest text in .dark). */}
      <div className="flex h-[min(88dvh,52rem)] w-full max-w-[80rem] flex-col rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl sm:w-[min(92vw,80rem)] sm:p-6 md:p-8">
        <div className="flex shrink-0 items-start justify-between gap-3 sm:gap-4">
          <div className="min-w-0">
            <h3 id="paste-urls-title" className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
              Paste job URLs
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-600 sm:text-base">
              Paste one or more links (any text). We’ll pick out the http(s) URLs and submit them.
            </p>
          </div>
          <button
            type="button"
            disabled={blocked}
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-40"
          >
            <X size={20} strokeWidth={2.25} />
          </button>
        </div>

        <textarea
          ref={textareaRef}
          value={text}
          disabled={blocked}
          onChange={(e) => {
            setText(e.target.value);
            if (localError) setLocalError('');
          }}
          placeholder={'https://boards.greenhouse.io/...\nhttps://jobs.lever.co/...'}
          className="mt-5 min-h-0 w-full flex-1 resize-none rounded-2xl border-2 border-slate-200 bg-slate-50 px-5 py-4 text-base leading-relaxed text-slate-900 outline-none ring-0 placeholder:text-slate-500 focus:border-blue-500 focus:bg-white focus:ring-4 focus:ring-blue-200/60 disabled:opacity-60"
        />

        <div className="mt-3 flex shrink-0 items-center justify-between gap-3 text-sm text-slate-600">
          <span>
            {urlCount > 0 ? (
              <>
                <strong className="text-slate-900">{urlCount}</strong> URL
                {urlCount === 1 ? '' : 's'} detected
              </>
            ) : (
              'No URLs detected yet'
            )}
          </span>
          {localError && <span className="font-semibold text-rose-600">{localError}</span>}
        </div>

        <div className="mt-5 flex shrink-0 flex-wrap items-center justify-end gap-3">
          <button
            type="button"
            disabled={blocked || !text}
            onClick={handleClean}
            className="rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-800 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Clean
          </button>
          <button
            type="button"
            disabled={blocked}
            onClick={onClose}
            className="rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-800 transition hover:bg-slate-50 disabled:opacity-40"
          >
            Close
          </button>
          <button
            type="button"
            disabled={blocked || urlCount === 0}
            onClick={() => void handleSubmit()}
            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            {submitting ? 'Submitting…' : 'Submit'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function SubmitForm({ inline = false }: SubmitFormProps = {}) {
  const url = useJobsStore((s) => s.url);
  const setUrl = useJobsStore((s) => s.setUrl);
  const loading = useJobsStore((s) => s.loading);
  const submitNotice = useJobsStore((s) => s.submitNotice);
  const submitNoticeKind = useJobsStore((s) => s.submitNoticeKind);
  const submitError = useJobsStore((s) => s.submitError);
  const attachmentFlow = useJobsStore((s) => s.attachmentFlow);
  const submitJob = useJobsStore((s) => s.submitJob);
  const submitAttachmentFiles = useJobsStore((s) => s.submitAttachmentFiles);
  const submitPastedText = useJobsStore((s) => s.submitPastedText);

  const fileRef = useRef<HTMLInputElement>(null);
  const attachBtnRef = useRef<HTMLButtonElement>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ bottom: number; left: number } | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);

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

  const updateMenuPos = () => {
    const el = attachBtnRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setMenuPos({
      bottom: window.innerHeight - rect.top + 6,
      left: Math.min(rect.left, window.innerWidth - 280),
    });
  };

  useEffect(() => {
    if (!menuOpen) {
      setMenuPos(null);
      return;
    }
    updateMenuPos();
    const onReposition = () => updateMenuPos();
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    return () => {
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [menuOpen]);

  const handleFormSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (hasPendingAttachment) {
      try {
        await submitAttachmentFiles(pendingFiles);
        setPendingFiles([]);
      } catch {
        // errors shown via submitError from store
      }
      return;
    }
    await submitJob(url.trim());
  };

  const clearPendingAttachment = () => {
    if (busy) return;
    setPendingFiles([]);
  };

  const openLocalUpload = () => {
    setMenuOpen(false);
    fileRef.current?.click();
  };

  const openPasteModal = () => {
    setMenuOpen(false);
    setPasteOpen(true);
  };

  const dropup =
    menuOpen && menuPos
      ? createPortal(
          <>
            <div className="fixed inset-0 z-[115]" onClick={() => setMenuOpen(false)} />
            <div
              className="fixed z-[116] w-64 overflow-hidden rounded-xl border border-slate-200 bg-white py-1.5 shadow-xl"
              style={{ bottom: menuPos.bottom, left: menuPos.left }}
              role="menu"
            >
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={openLocalUpload}
                className="flex w-full items-center gap-3 px-3.5 py-3 text-left text-sm font-semibold text-slate-800 transition hover:bg-blue-50 disabled:opacity-50"
              >
                <FolderOpen size={17} className="shrink-0 text-blue-600" strokeWidth={2.25} />
                Upload from local
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={openPasteModal}
                className="flex w-full items-center gap-3 px-3.5 py-3 text-left text-sm font-semibold text-slate-800 transition hover:bg-violet-50 disabled:opacity-50"
              >
                <ClipboardPaste size={17} className="shrink-0 text-violet-600" strokeWidth={2.25} />
                Paste in the text
              </button>
            </div>
          </>,
          document.body,
        )
      : null;

  const formBody = (
    <>
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
        <div className="flex h-11 min-w-0 flex-1 overflow-hidden rounded-t-lg border border-[rgba(147,197,253,0.8)] bg-[rgba(255,255,255,0.92)] shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] transition-[border-color,box-shadow,background-color] duration-[180ms] focus-within:border-[rgba(59,130,246,0.95)] focus-within:bg-white focus-within:shadow-[0_0_0_3px_rgba(59,130,246,0.2),inset_0_1px_0_rgba(255,255,255,0.85)] dark:border-[rgba(59,130,246,0.4)] dark:bg-[rgba(20,29,49,0.85)] dark:shadow-none dark:focus-within:bg-slate-900 sm:rounded-l-lg sm:rounded-r-none">
          <button
            ref={attachBtnRef}
            type="button"
            disabled={busy}
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            title="Import job URLs from a file or pasted text"
            aria-label="Import job URLs"
            className={[
              'flex h-full w-11 shrink-0 items-center justify-center border-r border-[rgba(147,197,253,0.65)] bg-gradient-to-b from-white to-slate-50/90 text-slate-500',
              'shadow-[inset_-1px_0_0_rgba(255,255,255,0.9)] transition-colors duration-150',
              'hover:bg-blue-50/80 hover:text-blue-700',
              'dark:border-[rgba(59,130,246,0.4)] dark:bg-none dark:bg-[rgba(20,29,49,0.85)] dark:text-slate-500 dark:shadow-none',
              'dark:hover:bg-slate-100 dark:hover:text-blue-600',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/35',
              'disabled:cursor-not-allowed disabled:opacity-50',
              attachmentFlow || menuOpen ? 'bg-blue-50/70 text-blue-700' : '',
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
              className="flex h-full min-w-0 flex-1 items-center gap-2 bg-gradient-to-r from-blue-50/95 via-sky-50/60 to-white pl-2 pr-1 dark:bg-none dark:from-transparent dark:via-transparent dark:to-transparent"
              title={attachmentTitle}
            >
              <FileText className="h-4 w-4 shrink-0 text-blue-600" strokeWidth={2} aria-hidden />
              <span className="min-w-0 flex-1 truncate text-left text-sm font-medium leading-none text-slate-800">
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
              onChange={(e) => setUrl(e.target.value)}
              disabled={busy}
              className="h-full min-w-0 flex-1 border-0 bg-transparent py-0 pl-2 pr-3 text-sm text-slate-900 outline-none ring-0 placeholder:text-slate-500 focus:ring-0 disabled:cursor-not-allowed disabled:opacity-60"
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
              ? 'Working\u2026'
              : hasPendingAttachment
                ? 'Submit attachment and import job URLs'
                : 'Submit job URL'
          }
          title={busy ? 'Working\u2026' : hasPendingAttachment ? 'Submit attachment' : 'Submit'}
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
        <div className="mt-2.5 text-sm font-medium text-amber-700">
          \u26A0 {submitNotice}
        </div>
      )}

      {submitError && <div className="mt-2.5 text-sm font-medium text-red-700">\u2715 {submitError}</div>}

      {dropup}

      <PasteUrlsModal
        open={pasteOpen}
        busy={busy}
        onClose={() => setPasteOpen(false)}
        onSubmit={submitPastedText}
      />
    </>
  );

  const form = (
    <form onSubmit={handleFormSubmit} className="min-w-0">
      {formBody}
    </form>
  );

  if (inline) return form;

  return (
    <div className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      {form}
    </div>
  );
}
