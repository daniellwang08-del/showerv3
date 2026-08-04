import { useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Eraser,
  Loader2,
  Search,
  Trash2,
} from 'lucide-react';
import { cleanupJobs } from '../../api/adminApi';
import type {
  JobCleanupMatchField,
  JobCleanupRequest,
  JobCleanupResult,
} from '../../types/admin';
import { ConfirmDialog } from '../extraction/ConfirmDialog';

const MATCH_FIELD_OPTIONS: Array<{ id: JobCleanupMatchField; label: string }> = [
  { id: 'company', label: 'Company' },
  { id: 'domain', label: 'Domain' },
  { id: 'source_url', label: 'Source URL' },
  { id: 'normalized_url', label: 'Normalized URL' },
  { id: 'title', label: 'Title' },
];

const PATTERN_EXAMPLES = [
  { label: 'LinkedIn', value: String.raw`linkedin\.com` },
  { label: 'Companies', value: 'acme|globex' },
  { label: 'Lever', value: String.raw`jobs\.lever\.co` },
];

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const detail = (err as { response?: { data?: { detail?: unknown } } }).response?.data
      ?.detail;
    if (typeof detail === 'string' && detail.trim()) return detail;
    if (Array.isArray(detail)) {
      return detail
        .map((d) =>
          typeof d === 'object' && d && 'msg' in d
            ? String((d as { msg: unknown }).msg)
            : String(d),
        )
        .join('; ');
    }
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

function formatCreated(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function criteriaSummary(preview: JobCleanupResult): string {
  const parts: string[] = [];
  if (preview.older_than_days != null) {
    parts.push(`older than ${preview.older_than_days} days`);
  }
  if (preview.pattern) {
    const fields =
      preview.match_fields?.length > 0
        ? preview.match_fields.join(', ')
        : 'selected fields';
    parts.push(`pattern /${preview.pattern}/ on ${fields}`);
  }
  return parts.join(' and ') || 'current criteria';
}

export function JobCleanupSection() {
  const [useAge, setUseAge] = useState(true);
  const [usePattern, setUsePattern] = useState(false);
  const [olderThanDays, setOlderThanDays] = useState(60);
  const [pattern, setPattern] = useState('');
  const [matchFields, setMatchFields] = useState<JobCleanupMatchField[]>([
    'company',
    'domain',
  ]);
  const [caseInsensitive, setCaseInsensitive] = useState(true);

  const [preview, setPreview] = useState<JobCleanupResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [msg, setMsg] = useState('');
  const [ok, setOk] = useState(false);

  const canPreview = useMemo(() => {
    if (useAge && !(olderThanDays >= 1 && olderThanDays <= 3650)) return false;
    if (usePattern && (!pattern.trim() || matchFields.length === 0)) return false;
    return useAge || usePattern;
  }, [useAge, usePattern, olderThanDays, pattern, matchFields]);

  const buildBody = (opts: {
    preview_only?: boolean;
    confirm?: boolean;
  }): JobCleanupRequest => ({
    older_than_days: useAge ? olderThanDays : null,
    pattern: usePattern ? pattern.trim() || null : null,
    match_fields: usePattern ? matchFields : [],
    case_insensitive: usePattern ? caseInsensitive : true,
    sample_limit: 20,
    ...opts,
  });

  const toggleField = (field: JobCleanupMatchField) => {
    setPreview(null);
    setMsg('');
    setMatchFields((prev) =>
      prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field],
    );
  };

  const handlePreview = async () => {
    if (!canPreview) return;
    setBusy(true);
    setMsg('');
    try {
      const result = await cleanupJobs(buildBody({ preview_only: true }));
      setPreview(result);
      setOk(true);
      setMsg(
        result.matching_jobs === 0
          ? 'No jobs matched these criteria.'
          : `Matched ${result.matching_jobs} job${result.matching_jobs === 1 ? '' : 's'}.`,
      );
    } catch (err: unknown) {
      setPreview(null);
      setOk(false);
      setMsg(extractErrorMessage(err, 'Cleanup preview failed.'));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!preview || preview.matching_jobs === 0) return;
    setBusy(true);
    setMsg('');
    try {
      const result = await cleanupJobs(buildBody({ confirm: true }));
      setPreview(result);
      setOk(true);
      setMsg(
        `Deleted ${result.deleted} of ${result.matching_jobs} matching job${
          result.matching_jobs === 1 ? '' : 's'
        }.`,
      );
    } catch (err: unknown) {
      setOk(false);
      setMsg(extractErrorMessage(err, 'Cleanup failed.'));
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  };

  return (
    <>
      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 md:p-6">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-rose-50 text-rose-700">
            <Eraser size={18} />
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-900">Job cleanup</h2>
            <p className="mt-0.5 text-sm text-slate-500">
              Admin cascade purge by age and/or regex against company, domain, or job site
              URLs. Preview first — deletes cannot be undone.
            </p>
          </div>
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          {/* Age-based */}
          <div
            className={`rounded-xl border p-4 transition-colors ${
              useAge ? 'border-slate-300 bg-slate-50/80' : 'border-slate-200 bg-white'
            }`}
          >
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={useAge}
                onChange={(e) => {
                  setUseAge(e.target.checked);
                  setPreview(null);
                  setMsg('');
                }}
                className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-900"
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-900">Age-based cleanup</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  Delete jobs whose database created date is older than the threshold.
                </p>
                <label className="mt-3 block text-xs font-semibold text-slate-700">
                  Older than (days)
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    disabled={!useAge || busy}
                    value={olderThanDays}
                    onChange={(e) => {
                      setOlderThanDays(Number(e.target.value) || 60);
                      setPreview(null);
                      setMsg('');
                    }}
                    className="mt-1 block w-32 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 disabled:opacity-50"
                  />
                </label>
              </div>
            </label>
          </div>

          {/* Pattern-based */}
          <div
            className={`rounded-xl border p-4 transition-colors ${
              usePattern ? 'border-slate-300 bg-slate-50/80' : 'border-slate-200 bg-white'
            }`}
          >
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={usePattern}
                onChange={(e) => {
                  setUsePattern(e.target.checked);
                  setPreview(null);
                  setMsg('');
                }}
                className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-900"
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-900">Pattern-based cleanup</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  Match a regex against selected fields (company names, domains, job sites).
                </p>
              </div>
            </label>

            <div className={`mt-3 space-y-3 ${usePattern ? '' : 'pointer-events-none opacity-50'}`}>
              <label className="block text-xs font-semibold text-slate-700">
                Regex pattern
                <input
                  type="text"
                  disabled={!usePattern || busy}
                  value={pattern}
                  onChange={(e) => {
                    setPattern(e.target.value);
                    setPreview(null);
                    setMsg('');
                  }}
                  placeholder={String.raw`e.g. linkedin\.com`}
                  spellCheck={false}
                  className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-800 disabled:opacity-50"
                />
              </label>

              <div>
                <p className="text-xs font-semibold text-slate-700">Match fields</p>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {MATCH_FIELD_OPTIONS.map((opt) => {
                    const active = matchFields.includes(opt.id);
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        disabled={!usePattern || busy}
                        onClick={() => toggleField(opt.id)}
                        className={`rounded-lg border px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-50 ${
                          active
                            ? 'border-slate-800 bg-slate-900 text-white'
                            : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <label className="flex items-center gap-2 text-xs font-medium text-slate-700">
                <input
                  type="checkbox"
                  checked={caseInsensitive}
                  disabled={!usePattern || busy}
                  onChange={(e) => {
                    setCaseInsensitive(e.target.checked);
                    setPreview(null);
                    setMsg('');
                  }}
                  className="h-4 w-4 rounded border-slate-300 text-slate-900"
                />
                Case-insensitive
              </label>

              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Examples
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {PATTERN_EXAMPLES.map((ex) => (
                    <button
                      key={ex.label}
                      type="button"
                      disabled={!usePattern || busy}
                      onClick={() => {
                        setPattern(ex.value);
                        setPreview(null);
                        setMsg('');
                      }}
                      className="rounded-md border border-slate-200 bg-white px-2 py-1 font-mono text-[11px] text-slate-600 hover:border-slate-300 disabled:opacity-50"
                      title={ex.value}
                    >
                      {ex.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {!useAge && !usePattern && (
          <p className="mt-4 text-sm text-amber-700">
            Enable age-based and/or pattern-based cleanup to preview matches.
          </p>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!canPreview || busy}
            onClick={() => void handlePreview()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {busy && !confirmOpen ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Search size={14} />
            )}
            {busy && !confirmOpen ? 'Previewing…' : 'Preview matches'}
          </button>
          <button
            type="button"
            disabled={
              !preview ||
              preview.matching_jobs === 0 ||
              busy ||
              !preview.preview
            }
            onClick={() => setConfirmOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800 hover:bg-rose-100 disabled:opacity-50"
          >
            <Trash2 size={14} />
            Delete matching jobs
          </button>
        </div>

        {preview && (
          <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-semibold text-slate-900">
                {preview.matching_jobs} match{preview.matching_jobs === 1 ? '' : 'es'}
                <span className="ml-2 text-xs font-medium text-slate-500">
                  ({preview.mode}
                  {preview.cutoff
                    ? ` · cutoff ${formatCreated(preview.cutoff)}`
                    : ''}
                  )
                </span>
              </p>
              <p className="text-xs text-slate-500">{criteriaSummary(preview)}</p>
            </div>

            {preview.sample.length > 0 && (
              <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white">
                <table className="min-w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-500">
                    <tr>
                      <th className="px-3 py-2 font-semibold">Title</th>
                      <th className="px-3 py-2 font-semibold">Company</th>
                      <th className="px-3 py-2 font-semibold">Domain</th>
                      <th className="px-3 py-2 font-semibold">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.sample.map((row) => (
                      <tr key={row.job_id} className="border-t border-slate-100">
                        <td className="max-w-[220px] truncate px-3 py-2 text-slate-800">
                          {row.title || '—'}
                        </td>
                        <td className="max-w-[160px] truncate px-3 py-2 text-slate-600">
                          {row.company || '—'}
                        </td>
                        <td className="max-w-[160px] truncate px-3 py-2 font-mono text-slate-600">
                          {row.domain || '—'}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-slate-600">
                          {formatCreated(row.created_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {preview.matching_jobs > preview.sample.length && (
                  <p className="border-t border-slate-100 px-3 py-2 text-[11px] text-slate-500">
                    Showing {preview.sample.length} of {preview.matching_jobs} matches.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {msg && (
          <p
            className={`mt-4 flex items-center gap-1.5 text-sm font-medium ${
              ok ? 'text-emerald-700' : 'text-rose-700'
            }`}
          >
            {ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
            {msg}
          </p>
        )}
      </section>

      <ConfirmDialog
        open={confirmOpen}
        title="Delete matching jobs?"
        description={
          preview ? (
            <p>
              Permanently delete <strong>{preview.matching_jobs}</strong> job
              {preview.matching_jobs === 1 ? '' : 's'} matching {criteriaSummary(preview)},
              including related match, application, and extraction rows. This cannot be
              undone.
            </p>
          ) : (
            ''
          )
        }
        confirmLabel="Delete permanently"
        cancelLabel="Cancel"
        variant="danger"
        loading={busy}
        onConfirm={() => void handleDelete()}
        onCancel={() => {
          if (!busy) setConfirmOpen(false);
        }}
      />
    </>
  );
}
