import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
  Save,
} from 'lucide-react';
import { PageScrollArea } from '../components/layout/PageScrollArea';
import {
  downloadResumeTemplatePreview,
  fetchResumeTemplateStatus,
  fetchResumeTemplateVariables,
  reanalyzeResumeTemplate,
  saveResumeTemplateBlueprint,
} from '../api/resumeTemplateApi';
import type {
  ResumeSection,
  ResumeTemplateBlueprint,
  ResumeTemplateStatusPayload,
  TemplateVariableDefinition,
} from '../types/resumeTemplate';

const POLL_MS = 4000;

function defaultTemplateEngine(tags: string[]): 'legacy_exp_n' | 'blueprint' {
  const hasExp = tags.some((t) => /\{\{EXP_\d+\}\}/.test(t));
  const hasLoop = tags.some((t) => t.includes('#work_experience'));
  if (hasExp || !hasLoop) return 'legacy_exp_n';
  return 'blueprint';
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ResumeTemplateBuilderPage() {
  const [statusData, setStatusData] = useState<ResumeTemplateStatusPayload | null>(null);
  const [blueprint, setBlueprint] = useState<ResumeTemplateBlueprint | null>(null);
  const [variables, setVariables] = useState<TemplateVariableDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [message, setMessage] = useState('');
  const [messageOk, setMessageOk] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [status, vars] = await Promise.all([
        fetchResumeTemplateStatus(),
        fetchResumeTemplateVariables(),
      ]);
      setStatusData(status);
      setVariables(vars);
      if (status.sections.length > 0) {
        setBlueprint({
          engine: defaultTemplateEngine(status.detected_tags),
          sections: status.sections,
          detected_tags: status.detected_tags,
          warnings: status.warnings,
        });
      }
    } catch {
      setMessage('Failed to load template builder.');
      setMessageOk(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (statusData?.resume_template_status !== 'processing') {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    pollRef.current = setInterval(() => void load(), POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [statusData?.resume_template_status, load]);

  const groupedVariables = useMemo(() => {
    const groups = new Map<string, TemplateVariableDefinition[]>();
    for (const v of variables) {
      const list = groups.get(v.group) ?? [];
      list.push(v);
      groups.set(v.group, list);
    }
    return Array.from(groups.entries());
  }, [variables]);

  const updateSection = (index: number, patch: Partial<ResumeSection>) => {
    if (!blueprint) return;
    const sections = blueprint.sections.map((s, i) => (i === index ? { ...s, ...patch } : s));
    setBlueprint({ ...blueprint, sections });
  };

  const updateBinding = (sectionIndex: number, bindingIndex: number, path: string) => {
    if (!blueprint) return;
    const sections = blueprint.sections.map((section, si) => {
      if (si !== sectionIndex) return section;
      const bindings = section.bindings.map((b, bi) =>
        bi === bindingIndex ? { ...b, path } : b,
      );
      return { ...section, bindings };
    });
    setBlueprint({ ...blueprint, sections });
  };

  const handleSave = async () => {
    if (!blueprint) return;
    setSaving(true);
    setMessage('');
    try {
      const data = await saveResumeTemplateBlueprint(blueprint);
      setStatusData(data);
      setMessage('Blueprint saved.');
      setMessageOk(true);
    } catch (err: unknown) {
      const detail =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : null;
      setMessage(typeof detail === 'string' ? detail : 'Save failed.');
      setMessageOk(false);
    } finally {
      setSaving(false);
    }
  };

  const handlePreview = async () => {
    setPreviewing(true);
    setMessage('');
    try {
      const blob = await downloadResumeTemplatePreview();
      downloadBlob(blob, 'resume-template-preview.docx');
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

  const handleReanalyze = async () => {
    setReanalyzing(true);
    setMessage('');
    try {
      const data = await reanalyzeResumeTemplate();
      setStatusData(data);
      if (data.sections.length > 0) {
        setBlueprint({
          engine: defaultTemplateEngine(data.detected_tags),
          sections: data.sections,
          detected_tags: data.detected_tags,
          warnings: data.warnings,
        });
      }
      setMessage('Re-analysis started.');
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

  return (
    <PageScrollArea className="h-full">
      <div className="flex min-h-full w-full flex-col gap-5 px-5 py-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Link
              to="/settings"
              className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-800 mb-2"
            >
              <ArrowLeft size={14} />
              Back to settings
            </Link>
            <h1 className="text-xl font-bold text-slate-800">Résumé template builder</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              Review detected placeholders, adjust bindings, validate, and preview output.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={reanalyzing || status === 'processing'}
              onClick={() => void handleReanalyze()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {reanalyzing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Re-analyze
            </button>
            <button
              type="button"
              disabled={previewing || !statusData?.resume_template_ready}
              onClick={() => void handlePreview()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {previewing ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              Preview DOCX
            </button>
            <button
              type="button"
              disabled={saving || !blueprint}
              onClick={() => void handleSave()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Save blueprint
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500 py-8">
            <Loader2 size={18} className="animate-spin" />
            Loading builder…
          </div>
        ) : !blueprint || blueprint.sections.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
            No template blueprint yet. Upload a DOCX template from{' '}
            <Link to="/settings" className="font-semibold text-violet-700 hover:underline">
              Settings
            </Link>{' '}
            first.
          </div>
        ) : (
          <>
            {statusData?.ai_validation && (
              <div
                className={`rounded-xl border px-4 py-3 ${
                  statusData.ai_validation.passed
                    ? 'border-emerald-200 bg-emerald-50'
                    : 'border-rose-200 bg-rose-50'
                }`}
              >
                <p className="text-sm font-semibold text-slate-900">
                  OpenAI validation: {statusData.ai_validation.passed ? 'Passed' : 'Failed'}
                </p>
                {statusData.ai_validation.summary && (
                  <p className="mt-1 text-sm text-slate-700">{statusData.ai_validation.summary}</p>
                )}
              </div>
            )}

            {statusData?.validation_errors && statusData.validation_errors.length > 0 && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3">
                <p className="text-sm font-semibold text-rose-900">Validation errors</p>
                <ul className="mt-2 list-disc pl-5 text-sm text-rose-800 space-y-1">
                  {statusData.validation_errors.map((err) => (
                    <li key={err}>{err}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="grid min-h-0 w-full grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
              <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
                <h2 className="text-sm font-bold text-slate-900">Template sections</h2>
                {blueprint.sections.map((section, sectionIndex) => (
                  <div key={section.id} className="rounded-lg border border-slate-100 bg-slate-50 p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <input
                        value={section.label}
                        onChange={(e) => updateSection(sectionIndex, { label: e.target.value })}
                        className="flex-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-sm font-medium"
                      />
                      <span className="text-[10px] uppercase tracking-wide text-slate-500">{section.type}</span>
                    </div>
                    {section.bindings.map((binding, bindingIndex) => (
                      <div key={`${binding.tag}-${bindingIndex}`} className="grid grid-cols-1 gap-1">
                        <label className="text-[11px] font-semibold text-slate-500">{binding.tag}</label>
                        <input
                          value={binding.path}
                          onChange={(e) => updateBinding(sectionIndex, bindingIndex, e.target.value)}
                          className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-mono"
                        />
                      </div>
                    ))}
                  </div>
                ))}
              </section>

              <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
                <h2 className="text-sm font-bold text-slate-900">Variable registry</h2>
                <p className="text-xs text-slate-500">
                  Copy tags into your DOCX template. Bindings map tags to profile, tailored, or job data.
                </p>
                {groupedVariables.map(([group, items]) => (
                  <div key={group}>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">{group}</p>
                    <ul className="space-y-2">
                      {items.map((v) => (
                        <li key={v.tag} className="rounded-md border border-slate-100 px-2.5 py-2">
                          <code className="text-xs font-semibold text-violet-800">{v.tag}</code>
                          <p className="text-xs text-slate-600 mt-0.5">{v.description}</p>
                          <p className="text-[10px] text-slate-400 mt-0.5">path: {v.path || '(loop marker)'}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}

                {statusData?.detected_tags && statusData.detected_tags.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Detected in upload</p>
                    <div className="flex flex-wrap gap-1.5">
                      {statusData.detected_tags.map((tag) => (
                        <code key={tag} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-700">
                          {tag}
                        </code>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            </div>
          </>
        )}

        {message && (
          <p className={`flex items-center gap-1.5 text-sm font-medium ${messageOk ? 'text-emerald-700' : 'text-rose-700'}`}>
            {messageOk ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
            {message}
          </p>
        )}
      </div>
    </PageScrollArea>
  );
}
