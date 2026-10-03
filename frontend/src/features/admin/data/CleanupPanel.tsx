import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, Loader2, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { cleanupJobs } from '@/api/adminApi';
import { SectionCard } from '@/components/app/PageLayout';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { jobKeys } from '@/features/jobs/queries';
import { cn } from '@/lib/utils';
import type { JobCleanupMatchField, JobCleanupRequest, JobCleanupResult } from '@/types/admin';
import {
  criteriaSummary,
  extractErrorMessage,
  fmt,
  formatCreated,
  MATCH_FIELD_OPTIONS,
  PATTERN_EXAMPLES,
  plural,
} from './dataUtils';
import { adminDataKeys } from './queries';

const SAMPLE_LIMIT = 20;
const MIN_DAYS = 1;
const MAX_DAYS = 3650;

type Criteria = Omit<JobCleanupRequest, 'confirm' | 'preview_only'>;
type Outcome = { ok: boolean; message: string };

function validRegex(pattern: string, caseInsensitive: boolean): string | null {
  try {
    new RegExp(pattern, caseInsensitive ? 'i' : undefined);
    return null;
  } catch {
    return 'This pattern may not be a valid regular expression; the server will validate it.';
  }
}

export function CleanupPanel() {
  const qc = useQueryClient();
  const [useAge, setUseAge] = useState(true);
  const [usePattern, setUsePattern] = useState(false);
  const [daysText, setDaysText] = useState('60');
  const [pattern, setPattern] = useState('');
  const [matchFields, setMatchFields] = useState<JobCleanupMatchField[]>(['company', 'domain']);
  const [caseInsensitive, setCaseInsensitive] = useState(true);

  const [preview, setPreview] = useState<{ criteria: Criteria; result: JobCleanupResult } | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const days = Number(daysText);
  const daysError =
    useAge && !(Number.isInteger(days) && days >= MIN_DAYS && days <= MAX_DAYS)
      ? `Enter a whole number of days between ${MIN_DAYS} and ${fmt(MAX_DAYS)}.`
      : null;
  const patternError = usePattern && !pattern.trim() ? 'Enter a pattern to match.' : null;
  const fieldsError = usePattern && matchFields.length === 0 ? 'Pick at least one field.' : null;
  const regexWarning = usePattern && pattern.trim() ? validRegex(pattern.trim(), caseInsensitive) : null;
  const canPreview = (useAge || usePattern) && !daysError && !patternError && !fieldsError;

  const criteria = (): Criteria => ({
    older_than_days: useAge ? days : null,
    pattern: usePattern ? pattern.trim() || null : null,
    match_fields: usePattern ? matchFields : [],
    case_insensitive: usePattern ? caseInsensitive : true,
    sample_limit: SAMPLE_LIMIT,
  });

  const invalidate = () => {
    setPreview(null);
    setOutcome(null);
  };

  const previewMutation = useMutation({
    mutationFn: (c: Criteria) => cleanupJobs({ ...c, preview_only: true }).then((result) => ({ criteria: c, result })),
    onSuccess: (data) => {
      setPreview(data);
      const n = data.result.matching_jobs;
      setOutcome({ ok: true, message: n === 0 ? 'No jobs matched these criteria.' : `Matched ${plural(n, 'job')}.` });
    },
    onError: (err) => {
      setPreview(null);
      setOutcome({ ok: false, message: extractErrorMessage(err, 'Cleanup preview failed.') });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (c: Criteria) => cleanupJobs({ ...c, confirm: true }),
    onSuccess: (result) => {
      setPreview(null);
      const message = `Deleted ${fmt(result.deleted)} of ${plural(result.matching_jobs, 'matching job')}.`;
      setOutcome({ ok: true, message });
      toast.success(message);
      void qc.invalidateQueries({ queryKey: jobKeys.all });
      void qc.invalidateQueries({ queryKey: adminDataKeys.all });
    },
    onError: (err) => {
      const message = extractErrorMessage(err, 'Cleanup failed.');
      setOutcome({ ok: false, message });
      toast.error(message);
    },
  });

  const busy = previewMutation.isPending || deleteMutation.isPending;
  const matches = preview?.result.matching_jobs ?? 0;
  const canDelete = preview != null && preview.result.preview && matches > 0 && !busy;

  const runDelete = () => {
    if (!preview) return;
    setConfirmOpen(false);
    deleteMutation.mutate(preview.criteria);
  };

  return (
    <div className="space-y-6">
      <SectionCard
        title="Job cleanup"
        description="Admin cascade purge by age and/or regex against company, domain, or job site URLs. Preview first. Deletes cannot be undone."
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <div className={cn('rounded-xl border p-4 transition-colors', useAge && 'bg-muted/40')}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p id="cleanup-age-title" className="text-sm font-medium">
                  Age-based cleanup
                </p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Delete jobs whose database created date is older than the threshold.
                </p>
              </div>
              <Switch
                aria-labelledby="cleanup-age-title"
                checked={useAge}
                disabled={busy}
                onCheckedChange={(v) => {
                  setUseAge(v);
                  invalidate();
                }}
              />
            </div>
            <Field className="mt-4" data-disabled={!useAge || undefined}>
              <FieldLabel htmlFor="cleanup-days">Older than (days)</FieldLabel>
              <Input
                id="cleanup-days"
                type="number"
                inputMode="numeric"
                min={MIN_DAYS}
                max={MAX_DAYS}
                className="w-32 tabular-nums"
                disabled={!useAge || busy}
                value={daysText}
                aria-invalid={daysError ? true : undefined}
                onChange={(e) => {
                  setDaysText(e.target.value);
                  invalidate();
                }}
              />
              {daysError ? <FieldError>{daysError}</FieldError> : null}
            </Field>
          </div>

          <div className={cn('rounded-xl border p-4 transition-colors', usePattern && 'bg-muted/40')}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p id="cleanup-pattern-title" className="text-sm font-medium">
                  Pattern-based cleanup
                </p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Match a regex against selected fields (company names, domains, job sites).
                </p>
              </div>
              <Switch
                aria-labelledby="cleanup-pattern-title"
                checked={usePattern}
                disabled={busy}
                onCheckedChange={(v) => {
                  setUsePattern(v);
                  invalidate();
                }}
              />
            </div>

            <div className={cn('mt-4 space-y-4', !usePattern && 'opacity-50')}>
              <Field data-disabled={!usePattern || undefined}>
                <FieldLabel htmlFor="cleanup-pattern">Regex pattern</FieldLabel>
                <Input
                  id="cleanup-pattern"
                  className="font-mono"
                  disabled={!usePattern || busy}
                  value={pattern}
                  placeholder={String.raw`e.g. linkedin\.com`}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => {
                    setPattern(e.target.value);
                    invalidate();
                  }}
                />
                {patternError ? <FieldError>{patternError}</FieldError> : null}
                {regexWarning ? <FieldDescription className="text-xs">{regexWarning}</FieldDescription> : null}
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">Examples</span>
                  {PATTERN_EXAMPLES.map((ex) => (
                    <Button
                      key={ex.label}
                      type="button"
                      variant="outline"
                      size="xs"
                      className="font-mono"
                      title={ex.value}
                      disabled={!usePattern || busy}
                      onClick={() => {
                        setPattern(ex.value);
                        invalidate();
                      }}
                    >
                      {ex.label}
                    </Button>
                  ))}
                </div>
              </Field>

              <fieldset disabled={!usePattern || busy}>
                <legend className="mb-1.5 text-sm font-medium">Match fields</legend>
                <div className="flex flex-wrap gap-1.5">
                  {MATCH_FIELD_OPTIONS.map((opt) => {
                    const active = matchFields.includes(opt.id);
                    return (
                      <Button
                        key={opt.id}
                        type="button"
                        size="sm"
                        variant={active ? 'secondary' : 'outline'}
                        aria-pressed={active}
                        className={cn(active && 'border-foreground/20')}
                        onClick={() => {
                          setMatchFields((prev) =>
                            prev.includes(opt.id) ? prev.filter((f) => f !== opt.id) : [...prev, opt.id],
                          );
                          invalidate();
                        }}
                      >
                        {active ? <CheckCircle2 aria-hidden /> : null}
                        {opt.label}
                      </Button>
                    );
                  })}
                </div>
                {usePattern && fieldsError ? <FieldError className="mt-1.5">{fieldsError}</FieldError> : null}
              </fieldset>

              <label className="flex w-fit cursor-pointer items-center gap-2 text-sm">
                <Checkbox
                  checked={caseInsensitive}
                  disabled={!usePattern || busy}
                  onCheckedChange={(v) => {
                    setCaseInsensitive(v === true);
                    invalidate();
                  }}
                />
                Case-insensitive
              </label>
            </div>
          </div>
        </div>

        {!useAge && !usePattern ? (
          <p className="mt-4 text-sm text-muted-foreground">
            Enable age-based and/or pattern-based cleanup to preview matches.
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap gap-2">
          <Button disabled={!canPreview || busy} onClick={() => previewMutation.mutate(criteria())}>
            {previewMutation.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Search aria-hidden />}
            {previewMutation.isPending ? 'Previewing…' : 'Preview matches'}
          </Button>
          <Button variant="destructive" disabled={!canDelete} onClick={() => setConfirmOpen(true)}>
            <Trash2 aria-hidden />
            Delete matching jobs
          </Button>
        </div>

        <div aria-live="polite" className="mt-4 space-y-3 empty:hidden">
          {deleteMutation.isPending && deleteMutation.variables ? (
            <div className="rounded-lg border bg-muted/40 p-3">
              <Progress value={null} aria-label="Deleting jobs">
                <span className="flex items-center gap-2 text-sm">
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  Deleting jobs matching {criteriaSummary(deleteMutation.variables)}…
                </span>
              </Progress>
            </div>
          ) : null}
          {outcome && !busy ? (
            <p
              role={outcome.ok ? 'status' : 'alert'}
              className={cn('flex items-center gap-1.5 text-sm', outcome.ok ? 'text-foreground' : 'text-destructive')}
            >
              {outcome.ok ? (
                <CheckCircle2 className="size-4 text-match-strong" aria-hidden />
              ) : (
                <AlertCircle className="size-4" aria-hidden />
              )}
              {outcome.message}
            </p>
          ) : null}
        </div>
      </SectionCard>

      {preview ? <PreviewCard result={preview.result} /> : null}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {plural(matches, 'job')}?</AlertDialogTitle>
            <AlertDialogDescription>
              {preview ? (
                <>
                  Permanently delete <strong className="text-foreground tabular-nums">{fmt(matches)}</strong>{' '}
                  {matches === 1 ? 'job' : 'jobs'} matching {criteriaSummary(preview.result)}, including related match,
                  application, and extraction rows. This cannot be undone.
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={runDelete}>
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function PreviewCard({ result }: { result: JobCleanupResult }) {
  const more = result.matching_jobs - result.sample.length;
  return (
    <SectionCard
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="tabular-nums">{plural(result.matching_jobs, 'match', 'es')}</span>
          <Badge variant="outline" className="capitalize">
            {result.mode}
          </Badge>
          {result.cutoff ? (
            <span className="text-xs font-normal text-muted-foreground">cutoff {formatCreated(result.cutoff)}</span>
          ) : null}
        </span>
      }
      description={criteriaSummary(result)}
    >
      {result.sample.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">No sample rows to show.</p>
      ) : (
        <div className="-mx-5 -my-4 overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm" aria-label="Matching jobs sample">
            <thead className="sticky top-0 bg-muted/60 text-xs text-muted-foreground">
              <tr>
                <th className="px-5 py-2 font-medium">Title</th>
                <th className="px-3 py-2 font-medium">Company</th>
                <th className="px-3 py-2 font-medium">Domain</th>
                <th className="px-5 py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {result.sample.map((row) => (
                <tr key={row.job_id} className="border-t">
                  <td className="max-w-[260px] truncate px-5 py-2" title={row.title ?? undefined}>
                    {row.title || '-'}
                  </td>
                  <td className="max-w-[180px] truncate px-3 py-2 text-muted-foreground">{row.company || '-'}</td>
                  <td className="max-w-[180px] truncate px-3 py-2 font-mono text-xs text-muted-foreground">
                    {row.domain || '-'}
                  </td>
                  <td className="px-5 py-2 whitespace-nowrap text-muted-foreground tabular-nums">
                    {formatCreated(row.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {more > 0 ? (
            <p className="border-t px-5 py-2 text-xs text-muted-foreground tabular-nums">
              Showing {fmt(result.sample.length)} of {fmt(result.matching_jobs)} matches.
            </p>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}
