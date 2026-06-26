import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FileUp,
  Info,
  Loader2,
  RefreshCw,
  Sparkles,
  Wrench,
} from 'lucide-react';
import {
  fetchResumeTemplateStatus,
  reanalyzeResumeTemplate,
  uploadResumeTemplate,
} from '../../api/resumeTemplateApi';
import type {
  DetectedTemplateType,
  ResumeTemplateAiValidation,
  ResumeTemplateRequirements,
  ResumeTemplateStatus,
  ResumeTemplateStatusPayload,
  ResumeStyleSection,
  TemplateTypeSpec,
} from '../../types/resumeTemplate';

const POLL_MS = 4000;

function statusBadge(status: ResumeTemplateStatus) {
  const styles: Record<ResumeTemplateStatus, string> = {
    missing: 'bg-slate-100 text-slate-700',
    processing: 'bg-blue-100 text-blue-800',
    ready: 'bg-emerald-100 text-emerald-800',
    stale: 'bg-amber-100 text-amber-900',
    failed: 'bg-rose-100 text-rose-800',
  };
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${styles[status]}`}>
      {status}
    </span>
  );
}

function templateTypeLabel(type: DetectedTemplateType | null | undefined): string {
  switch (type) {
    case 'dynamic':
      return 'Repeat-block layout (advanced alternate)';
    case 'legacy_exp_n':
      return 'Fixed slot layout (recommended)';
    default:
      return 'Fixed slot layout (expected)';
  }
}

function formatMaxBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function ResumeStyleSectionCard({ section, defaultOpen }: { section: ResumeStyleSection; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? section.required);

  return (
    <div
      className={`rounded-lg border ${
        section.required ? 'border-violet-200 bg-white' : 'border-slate-200 bg-slate-50/80'
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start justify-between gap-3 px-3 py-2.5 text-left"
      >
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-slate-900">{section.heading}</span>
            {section.required ? (
              <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-800">
                Required
              </span>
            ) : (
              <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                Optional
              </span>
            )}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-slate-600">{section.description}</p>
        </div>
        {open ? <ChevronUp size={16} className="shrink-0 text-slate-500" /> : <ChevronDown size={16} className="shrink-0 text-slate-500" />}
      </button>

      {open && (
        <div className="space-y-3 border-t border-slate-100 px-3 py-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Example layout</p>
            <pre className="mt-1.5 overflow-x-auto rounded-md bg-slate-900 px-3 py-2 text-[11px] leading-relaxed text-slate-100 whitespace-pre-wrap">
              {section.layout_example}
            </pre>
          </div>
          {section.placeholders.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Placeholders to insert</p>
              <ul className="mt-1.5 space-y-1.5">
                {section.placeholders.map((p) => (
                  <li key={p.tag} className="text-xs text-slate-700">
                    <code className="rounded bg-violet-50 px-1 py-0.5 font-semibold text-violet-900 ring-1 ring-violet-100">
                      {p.tag}
                    </code>{' '}
                    <span className="text-slate-500">{p.description}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LegacyTemplateNote({ spec }: { spec: TemplateTypeSpec }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/80">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-semibold text-slate-700"
      >
        {spec.label}
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open && (
        <div className="border-t border-slate-200 px-3 py-2 text-xs text-slate-600 space-y-2">
          <p>{spec.description}</p>
          {spec.example_snippet && (
            <pre className="overflow-x-auto rounded bg-slate-900 px-2 py-1.5 text-[10px] text-slate-100 whitespace-pre-wrap">
              {spec.example_snippet}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function RequirementsPanel({ requirements }: { requirements: ResumeTemplateRequirements }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-violet-100 bg-violet-50/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Info size={15} className="shrink-0 text-violet-700" />
          <span className="truncate text-xs font-semibold text-violet-950">
            {requirements.resume_style_title}
          </span>
          <span className="hidden shrink-0 text-[11px] text-violet-800/70 sm:inline">
            · {requirements.file_format.extension} · max {formatMaxBytes(requirements.file_format.max_bytes)}
          </span>
        </div>
        {open ? (
          <ChevronUp size={15} className="shrink-0 text-violet-700" />
        ) : (
          <ChevronDown size={15} className="shrink-0 text-violet-700" />
        )}
      </button>

      {open && (
        <div className="space-y-3 border-t border-violet-100 px-3 py-3">
          <p className="text-xs leading-relaxed text-violet-900/80">{requirements.resume_style_intro}</p>

          <div className="space-y-2">
            {requirements.resume_style_sections.map((section, i) => (
              <ResumeStyleSectionCard key={section.id} section={section} defaultOpen={i < 2} />
            ))}
          </div>

          {requirements.template_types.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Alternate layout</p>
              {requirements.template_types.map((spec) => (
                <LegacyTemplateNote key={spec.id} spec={spec} />
              ))}
            </div>
          )}

          {requirements.validation_notes.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-xs text-violet-900/90">
              {requirements.validation_notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function ValidationResultPanel({
  validation,
  detectedType,
}: {
  validation: ResumeTemplateAiValidation;
  detectedType?: DetectedTemplateType | null;
}) {
  const typeLabel = templateTypeLabel(validation.template_type || detectedType);

  return (
    <div
      className={`rounded-xl border px-4 py-3 ${
        validation.passed
          ? 'border-emerald-200 bg-emerald-50/60'
          : 'border-rose-200 bg-rose-50/60'
      }`}
    >
      <div className="flex items-start gap-2.5">
        {validation.passed ? (
          <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-emerald-700" />
        ) : (
          <AlertCircle size={18} className="mt-0.5 shrink-0 text-rose-700" />
        )}
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <p className={`text-sm font-semibold ${validation.passed ? 'text-emerald-900' : 'text-rose-900'}`}>
              {validation.passed ? 'OpenAI validation passed' : 'OpenAI validation failed'}
            </p>
            <p className="mt-0.5 text-xs text-slate-600">
              Detected type: <span className="font-medium text-slate-800">{typeLabel}</span>
            </p>
            {validation.summary && (
              <p className={`mt-1.5 text-sm leading-relaxed ${validation.passed ? 'text-emerald-900' : 'text-rose-900'}`}>
                {validation.summary}
              </p>
            )}
          </div>

          {validation.errors.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-rose-900">Blocking issues</p>
              <ul className="mt-1 list-disc pl-4 text-xs text-rose-800 space-y-1">
                {validation.errors.map((err) => (
                  <li key={err}>{err}</li>
                ))}
              </ul>
            </div>
          )}

          {validation.missing_required_tags.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-rose-900">Missing required tags</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {validation.missing_required_tags.map((tag) => (
                  <code key={tag} className="rounded bg-white px-1.5 py-0.5 text-[10px] text-rose-800 ring-1 ring-rose-200">
                    {tag}
                  </code>
                ))}
              </div>
            </div>
          )}

          {validation.warnings.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-amber-900">Warnings</p>
              <ul className="mt-1 list-disc pl-4 text-xs text-amber-900 space-y-1">
                {validation.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {validation.suggestions.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-700">Suggestions</p>
              <ul className="mt-1 list-disc pl-4 text-xs text-slate-700 space-y-1">
                {validation.suggestions.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          )}

          {validation.detected_required_tags.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-600">Tags found</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {validation.detected_required_tags.slice(0, 12).map((tag) => (
                  <code key={tag} className="rounded bg-white px-1.5 py-0.5 text-[10px] text-slate-700 ring-1 ring-slate-200">
                    {tag}
                  </code>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface ResumeTemplateSectionProps {
  onStatusChange?: (status: ResumeTemplateStatusPayload) => void;
}

export function ResumeTemplateSection({ onStatusChange }: ResumeTemplateSectionProps) {
  const [statusData, setStatusData] = useState<ResumeTemplateStatusPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [message, setMessage] = useState('');
  const [messageOk, setMessageOk] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const applyStatus = useCallback(
    (data: ResumeTemplateStatusPayload) => {
      setStatusData(data);
      onStatusChange?.(data);
    },
    [onStatusChange],
  );

  const refresh = useCallback(async () => {
    try {
      const data = await fetchResumeTemplateStatus();
      applyStatus(data);
    } catch {
      setMessage('Failed to load template status.');
      setMessageOk(false);
    } finally {
      setLoading(false);
    }
  }, [applyStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (statusData?.resume_template_status !== 'processing') {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    pollRef.current = setInterval(() => void refresh(), POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [statusData?.resume_template_status, refresh]);

  const handleUpload = async (file: File | null) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.docx')) {
      setMessage('Only .docx files are supported.');
      setMessageOk(false);
      return;
    }
    const maxBytes = statusData?.requirements?.file_format.max_bytes ?? 5_000_000;
    if (file.size > maxBytes) {
      setMessage(`File exceeds maximum size of ${formatMaxBytes(maxBytes)}.`);
      setMessageOk(false);
      return;
    }
    setUploading(true);
    setMessage('');
    try {
      const data = await uploadResumeTemplate(file);
      applyStatus(data);
      setMessage('Template uploaded - OpenAI analysis and validation started.');
      setMessageOk(true);
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

  const handleReanalyze = async () => {
    setReanalyzing(true);
    setMessage('');
    try {
      const data = await reanalyzeResumeTemplate();
      applyStatus(data);
      setMessage('Re-analysis and OpenAI validation started.');
      setMessageOk(true);
    } catch (err: unknown) {
      const detail =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : null;
      setMessage(typeof detail === 'string' ? detail : 'Re-analysis failed.');
      setMessageOk(false);
    } finally {
      setReanalyzing(false);
    }
  };

  const status = statusData?.resume_template_status ?? 'missing';
  const requirements = statusData?.requirements;
  const aiValidation = statusData?.ai_validation;
  const showValidation =
    aiValidation &&
    status !== 'processing' &&
    (status === 'ready' || status === 'failed' || status === 'stale');

  return (
    <section className="h-full rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 text-white">
          <FileUp size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-base font-bold text-slate-900">Résumé template</h2>
              <p className="mt-0.5 text-sm leading-snug text-slate-500">
                Word template AI fills per job. Expand requirements below.
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

              {statusData?.resume_template_source_filename && (
                <p className="text-sm text-slate-700">
                  Current file:{' '}
                  <span className="font-medium">{statusData.resume_template_source_filename}</span>
                  {statusData.detected_template_type && (
                    <span className="ml-2 text-xs text-slate-500">
                      ({templateTypeLabel(statusData.detected_template_type)})
                    </span>
                  )}
                </p>
              )}

              {showValidation && (
                <ValidationResultPanel
                  validation={aiValidation}
                  detectedType={statusData?.detected_template_type}
                />
              )}

              {!showValidation &&
                statusData?.validation_errors &&
                statusData.validation_errors.length > 0 && (
                  <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5">
                    <p className="text-xs font-semibold text-rose-900">Validation issues</p>
                    <ul className="mt-1.5 list-disc pl-4 text-xs text-rose-800 space-y-1">
                      {statusData.validation_errors.map((err) => (
                        <li key={err}>{err}</li>
                      ))}
                    </ul>
                  </div>
                )}

              {statusData?.resume_template_error && status !== 'ready' && !showValidation && (
                <p className="text-sm text-rose-700">{statusData.resume_template_error}</p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  className="hidden"
                  onChange={(e) => void handleUpload(e.target.files?.[0] ?? null)}
                />
                <Link
                  to="/resume-builder"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-blue-700"
                >
                  <Wrench size={14} />
                  Open Resume Builder
                </Link>
                <button
                  type="button"
                  disabled={uploading || status === 'processing'}
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {uploading ? <Loader2 size={14} className="animate-spin" /> : <FileUp size={14} />}
                  {statusData?.resume_template_source_filename ? 'Replace template' : 'Upload your own'}
                </button>

                {statusData?.resume_template_source_filename && (
                  <button
                    type="button"
                    disabled={reanalyzing || status === 'processing'}
                    onClick={() => void handleReanalyze()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {reanalyzing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                    Re-validate
                  </button>
                )}

                {statusData?.sections && statusData.sections.length > 0 && (
                  <Link
                    to="/settings/resume-template"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-xs font-semibold text-violet-800 transition hover:bg-violet-100"
                  >
                    <Wrench size={14} />
                    Edit blueprint
                  </Link>
                )}
              </div>

              {status === 'processing' && (
                <p className="flex items-center gap-1.5 text-xs text-blue-700">
                  <Sparkles size={14} className="animate-spin" />
                  OpenAI is analyzing structure and validating placeholders…
                </p>
              )}

              {message && (
                <p
                  className={`flex items-center gap-1.5 text-sm font-medium ${
                    messageOk ? 'text-emerald-700' : 'text-rose-700'
                  }`}
                >
                  {messageOk ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
                  {message}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
