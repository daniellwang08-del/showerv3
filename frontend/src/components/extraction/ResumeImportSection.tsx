import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileUp, Loader2, RefreshCw, ShieldCheck, Trash2, FolderOpen } from 'lucide-react';
import { apiClient } from '../../api/client';
import type { UserProfile } from '../../types/profile';
import type { ProfileFormData } from '../../types/profile';
import type { ProfileSourceDocument } from '../../types/profileSourceDocument';
import {
  deleteProfileSourceDocument,
  formatDocSize,
  listProfileSourceDocuments,
  parseStatusLabel,
  reparseProfileSourceDocument,
  updateProfileSourceDocumentCompany,
  uploadProfileSourceDocument,
} from '../../api/profileSourceDocumentsApi';
import {
  detectResumeConflicts,
  draftToFormPartial,
  mergeResumeImport,
  type ResumeDraft,
} from '../../utils/resumeMerge';
import { profileToForm } from './ProfileForm';

type Props = {
  profile: UserProfile | null;
  accountEmail: string | undefined;
  applyProfile: (data: ProfileFormData) => Promise<void>;
  disabled?: boolean;
};

type ParseResponse = {
  draft: ResumeDraft;
  source_kind: string;
  warnings: string[];
};

function profileCompanies(profile: UserProfile | null): string[] {
  const rows = profile?.work_experience ?? [];
  const names: string[] = [];
  for (const row of rows) {
    const co = typeof row === 'object' && row && 'company_name' in row ? String(row.company_name || '').trim() : '';
    if (co) names.push(co);
  }
  return names;
}

export function ResumeImportSection({ profile, accountEmail, applyProfile, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const sourceInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [docsLoading, setDocsLoading] = useState(true);
  const [localError, setLocalError] = useState('');
  const [sourceError, setSourceError] = useState('');
  const [sourceDocs, setSourceDocs] = useState<ProfileSourceDocument[]>([]);
  const [pendingDraft, setPendingDraft] = useState<ResumeDraft | null>(null);
  const [parseMeta, setParseMeta] = useState<{ warnings: string[]; source: string } | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [conflicts, setConflicts] = useState<ReturnType<typeof detectResumeConflicts>>([]);
  const [agreedReplace, setAgreedReplace] = useState(false);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);

  const companies = useMemo(() => profileCompanies(profile), [profile]);

  const loadSourceDocs = useCallback(async () => {
    setDocsLoading(true);
    try {
      const docs = await listProfileSourceDocuments();
      setSourceDocs(docs);
    } catch {
      setSourceError('Could not load project source documents.');
    } finally {
      setDocsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSourceDocs();
  }, [loadSourceDocs]);

  const resetModal = useCallback(() => {
    setModalOpen(false);
    setPendingDraft(null);
    setParseMeta(null);
    setConflicts([]);
    setAgreedReplace(false);
  }, []);

  useEffect(() => {
    if (!modalOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [modalOpen]);

  const runApply = useCallback(
    async (draft: ResumeDraft, mode: 'empty_only' | 'replace') => {
      setLocalError('');
      const merged = mergeResumeImport(profile, draft, accountEmail, mode);
      await applyProfile(merged);
      resetModal();
      if (inputRef.current) inputRef.current.value = '';
    },
    [accountEmail, applyProfile, profile, resetModal],
  );

  const afterParse = useCallback(
    async (draft: ResumeDraft, warnings: string[], source: string) => {
      const base = profileToForm(profile);
      const partial = draftToFormPartial(draft, accountEmail);
      const c = detectResumeConflicts(base, partial);
      if (c.length === 0) {
        try {
          await runApply(draft, 'empty_only');
        } catch {
          /* Error banner set by applyProfile / handleSubmit */
        }
        return;
      }
      setPendingDraft(draft);
      setParseMeta({ warnings, source });
      setConflicts(c);
      setAgreedReplace(false);
      setModalOpen(true);
    },
    [accountEmail, profile, runApply],
  );

  const onFile = useCallback(
    async (file: File | null) => {
      if (!file || disabled) return;
      const lower = file.name.toLowerCase();
      if (!lower.endsWith('.pdf') && !lower.endsWith('.docx')) {
        setLocalError('Please choose a PDF or DOCX file.');
        return;
      }
      if (file.size > 6 * 1024 * 1024) {
        setLocalError('File must be 6 MB or smaller.');
        return;
      }
      setBusy(true);
      setLocalError('');
      try {
        const fd = new FormData();
        fd.append('file', file);
        const res = await apiClient.post<ParseResponse>('/profile/resume-parse', fd);
        const data = res.data;
        if (!data?.draft) {
          setLocalError('No data returned from parser.');
          return;
        }
        await afterParse(data.draft, data.warnings ?? [], data.source_kind ?? 'unknown');
      } catch (err: unknown) {
        const detail =
          err && typeof err === 'object' && 'response' in err
            ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
            : undefined;
        setLocalError(typeof detail === 'string' ? detail : 'Could not parse résumé.');
      } finally {
        setBusy(false);
      }
    },
    [afterParse, disabled],
  );

  const onSourceFile = useCallback(
    async (file: File | null) => {
      if (!file || disabled) return;
      const lower = file.name.toLowerCase();
      if (!lower.endsWith('.pdf') && !lower.endsWith('.docx')) {
        setSourceError('Please choose a PDF or DOCX file.');
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        setSourceError('Project source file must be 10 MB or smaller.');
        return;
      }
      setSourceBusy(true);
      setSourceError('');
      try {
        await uploadProfileSourceDocument(file);
        await loadSourceDocs();
        if (sourceInputRef.current) sourceInputRef.current.value = '';
      } catch (err: unknown) {
        const detail =
          err && typeof err === 'object' && 'response' in err
            ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
            : undefined;
        setSourceError(typeof detail === 'string' ? detail : 'Could not upload project source document.');
      } finally {
        setSourceBusy(false);
      }
    },
    [disabled, loadSourceDocs],
  );

  const onCompanyChange = useCallback(async (docId: string, companyName: string) => {
    if (!companyName.trim()) return;
    setRowBusyId(docId);
    setSourceError('');
    try {
      const updated = await updateProfileSourceDocumentCompany(docId, companyName);
      setSourceDocs((prev) => prev.map((d) => (d.id === docId ? updated : d)));
    } catch {
      setSourceError('Could not update company link.');
    } finally {
      setRowBusyId(null);
    }
  }, []);

  const onReparse = useCallback(async (docId: string) => {
    setRowBusyId(docId);
    setSourceError('');
    try {
      const updated = await reparseProfileSourceDocument(docId);
      setSourceDocs((prev) => prev.map((d) => (d.id === docId ? updated : d)));
    } catch {
      setSourceError('Re-parse failed.');
    } finally {
      setRowBusyId(null);
    }
  }, []);

  const onDelete = useCallback(async (docId: string) => {
    setRowBusyId(docId);
    setSourceError('');
    try {
      await deleteProfileSourceDocument(docId);
      setSourceDocs((prev) => prev.filter((d) => d.id !== docId));
    } catch {
      setSourceError('Could not delete document.');
    } finally {
      setRowBusyId(null);
    }
  }, []);

  return (
    <>
      <div className="h-full rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Import from résumé</h2>
            <p className="mt-1 text-sm text-slate-600">
              Upload a <strong>PDF</strong> (analyzed as page images) or <strong>DOCX</strong> (text). We use AI to map
              fields to your profile. Empty fields are filled automatically. Replacing existing data requires your
              confirmation.
            </p>
          </div>
          <div className="shrink-0">
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              className="hidden"
              disabled={disabled || busy}
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                void onFile(f);
              }}
            />
            <button
              type="button"
              disabled={disabled || busy}
              onClick={() => inputRef.current?.click()}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-indigo-200/80 bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white shadow-md transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}
              {busy ? 'Parsing…' : 'Choose PDF or DOCX'}
            </button>
          </div>
        </div>
        {localError ? (
          <p className="mt-3 text-sm font-medium text-rose-600" role="alert">
            {localError}
          </p>
        ) : null}

        <div className="mt-6 border-t border-slate-200 pt-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h3 className="text-base font-bold text-slate-900">Project source documents</h3>
              <p className="mt-1 text-sm text-slate-600">
                Upload detailed per-company project write-ups (PDF or DOCX). These are parsed once and used when tailoring
                résumés for each job - stronger bullets with real metrics and project depth.
              </p>
            </div>
            <div className="shrink-0">
              <input
                ref={sourceInputRef}
                type="file"
                accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                className="hidden"
                disabled={disabled || sourceBusy}
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  void onSourceFile(f);
                }}
              />
              <button
                type="button"
                disabled={disabled || sourceBusy}
                onClick={() => sourceInputRef.current?.click()}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm font-bold text-emerald-900 shadow-sm transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
              >
                {sourceBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderOpen className="h-4 w-4" />}
                {sourceBusy ? 'Uploading…' : 'Add project doc'}
              </button>
            </div>
          </div>

          {sourceError ? (
            <p className="mt-3 text-sm font-medium text-rose-600" role="alert">
              {sourceError}
            </p>
          ) : null}

          <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-3 py-2.5 text-left text-xs font-bold uppercase tracking-wide text-slate-500">File</th>
                  <th className="px-3 py-2.5 text-left text-xs font-bold uppercase tracking-wide text-slate-500">Company</th>
                  <th className="px-3 py-2.5 text-left text-xs font-bold uppercase tracking-wide text-slate-500">Projects</th>
                  <th className="px-3 py-2.5 text-left text-xs font-bold uppercase tracking-wide text-slate-500">Size</th>
                  <th className="px-3 py-2.5 text-left text-xs font-bold uppercase tracking-wide text-slate-500">Status</th>
                  <th className="px-3 py-2.5 text-right text-xs font-bold uppercase tracking-wide text-slate-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {docsLoading ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-slate-500">
                      <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                    </td>
                  </tr>
                ) : sourceDocs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-slate-500">
                      No project source documents yet. Upload one per company for richer tailored résumés.
                    </td>
                  </tr>
                ) : (
                  sourceDocs.map((doc) => {
                    const rowBusy = rowBusyId === doc.id;
                    const statusClass =
                      doc.parse_status === 'completed'
                        ? 'text-emerald-700 bg-emerald-50'
                        : doc.parse_status === 'failed'
                          ? 'text-rose-700 bg-rose-50'
                          : 'text-amber-700 bg-amber-50';
                    return (
                      <tr key={doc.id} className="hover:bg-slate-50/80">
                        <td className="max-w-[180px] truncate px-3 py-2.5 font-medium text-slate-900" title={doc.filename}>
                          {doc.filename}
                        </td>
                        <td className="px-3 py-2.5">
                          <select
                            className="w-full min-w-[140px] rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-800 disabled:opacity-60"
                            value={doc.company_name ?? ''}
                            disabled={rowBusy || disabled || companies.length === 0}
                            onChange={(e) => {
                              void onCompanyChange(doc.id, e.target.value);
                            }}
                          >
                            <option value="">{companies.length ? 'Select company…' : 'Add work history first'}</option>
                            {doc.company_name && !companies.includes(doc.company_name) ? (
                              <option value={doc.company_name}>{doc.company_name}</option>
                            ) : null}
                            {companies.map((co) => (
                              <option key={co} value={co}>
                                {co}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-3 py-2.5 text-slate-700">{doc.project_count}</td>
                        <td className="px-3 py-2.5 text-slate-600">{formatDocSize(doc.char_count)}</td>
                        <td className="px-3 py-2.5">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${statusClass}`}
                            title={doc.parse_error ?? undefined}
                          >
                            {parseStatusLabel(doc.parse_status)}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              type="button"
                              disabled={rowBusy || disabled}
                              onClick={() => void onReparse(doc.id)}
                              className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-indigo-600 disabled:opacity-50"
                              title="Re-parse document"
                            >
                              <RefreshCw className={`h-4 w-4 ${rowBusy ? 'animate-spin' : ''}`} />
                            </button>
                            <button
                              type="button"
                              disabled={rowBusy || disabled}
                              onClick={() => void onDelete(doc.id)}
                              className="rounded-lg p-1.5 text-slate-500 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
                              title="Delete document"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {modalOpen && pendingDraft
        ? createPortal(
            <div
              className="fixed inset-0 z-[9999] flex items-center justify-center overflow-y-auto overscroll-contain bg-slate-900/45 p-4 backdrop-blur-sm sm:p-6"
              role="dialog"
              aria-modal="true"
              aria-labelledby="resume-import-title"
            >
              <div className="my-auto max-h-[min(90dvh,90vh)] w-full max-w-lg overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
                <ShieldCheck className="h-6 w-6" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 id="resume-import-title" className="text-lg font-bold text-slate-900">
                  Résumé overlaps your saved profile
                </h3>
                <p className="mt-1 text-sm text-slate-600">
                  {parseMeta?.source === 'pdf'
                    ? 'Parsed from PDF (vision).'
                    : 'Parsed from DOCX (text).'}{' '}
                  Some fields already have values. Choose how to apply the extracted data.
                </p>
              </div>
            </div>

            {parseMeta?.warnings?.length ? (
              <ul className="mt-3 list-inside list-disc text-xs text-slate-500">
                {parseMeta.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            ) : null}

            <div className="mt-4 max-h-48 overflow-y-auto rounded-xl border border-slate-200/90 bg-slate-50/80 p-3 text-xs">
              <p className="font-bold uppercase tracking-wide text-slate-500">Would change</p>
              <ul className="mt-2 space-y-2">
                {conflicts.map((c) => (
                  <li key={c.id} className="text-slate-700">
                    <span className="font-semibold text-slate-900">{c.label}</span>
                    <div className="mt-0.5 text-slate-600">
                      <span className="text-rose-700">Current:</span> {c.currentPreview}
                    </div>
                    <div className="text-slate-600">
                      <span className="text-emerald-700">From résumé:</span> {c.proposedPreview}
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            <label className="mt-4 flex cursor-pointer items-start gap-2 rounded-xl border border-slate-200 bg-white/80 p-3 text-sm text-slate-700">
              <input
                type="checkbox"
                className="mt-1 rounded border-slate-300"
                checked={agreedReplace}
                onChange={(e) => setAgreedReplace(e.target.checked)}
              />
              <span>
                I agree to <strong>replace</strong> my existing values in the fields above with the résumé versions when
                I choose “Replace with résumé”.
              </span>
            </label>

            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={resetModal}
                className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void runApply(pendingDraft, 'empty_only').catch(() => {});
                }}
                className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm font-bold text-blue-900 shadow-sm hover:bg-blue-100"
              >
                Fill empty fields only
              </button>
              <button
                type="button"
                disabled={!agreedReplace}
                onClick={() => {
                  void runApply(pendingDraft, 'replace').catch(() => {});
                }}
                className="rounded-xl bg-gradient-to-r from-indigo-600 to-blue-600 px-4 py-2.5 text-sm font-bold text-white shadow-md hover:from-indigo-500 hover:to-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Replace with résumé
              </button>
            </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
