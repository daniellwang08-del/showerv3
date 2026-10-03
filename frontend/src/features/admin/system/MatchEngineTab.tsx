import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronDown, Database, FlaskConical, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { SectionCard } from '@/components/app/PageLayout';
import { SaveBar } from '@/components/app/SaveBar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  diagnoseMatchEngine,
  fetchMatchEngineShadowStats,
  triggerMatchEngineBackfill,
  updateSystemSettings,
  type MatchDiagnoseResult,
} from '@/api/adminApi';
import type { SystemSettingsResponse } from '@/types/admin';
import { ConfirmDialog, QueryError, SelectSetting, Stat } from './fields';
import { SHADOW_STATS_KEY, useSetSystemSettings } from './queries';
import { errDetail, MATCH_ENGINE_OPTIONS } from './settingsModel';
import { useReportDirty, useSettingsDraft } from './useSettingsDraft';

const DRAFT_KEYS = ['match_engine'];
/** How long stats keep polling after a backfill starts (no progress endpoint exists). */
const BACKFILL_WATCH_MS = 2 * 60 * 1000;

export function MatchEngineTab({
  settings,
  active,
  onDirtyChange,
}: {
  settings: SystemSettingsResponse;
  active: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const setSettings = useSetSystemSettings();
  const draft = useSettingsDraft(settings, DRAFT_KEYS);
  const [saving, setSaving] = useState(false);
  useReportDirty(draft.dirty, onDirtyChange);

  const handleSave = async () => {
    setSaving(true);
    try {
      setSettings(await updateSystemSettings(draft.payload()));
      draft.clear();
      toast.success('Match engine saved', { description: 'New analyses use the selected engine.' });
    } catch (err) {
      toast.error(errDetail(err, 'Failed to save match engine'));
    } finally {
      setSaving(false);
    }
  };

  const engine = draft.value('match_engine') || 'llm';

  return (
    <div className="space-y-6">
      <SectionCard
        title="Scoring engine"
        description="Vector never calls the LLM for Phase A. Shadow keeps LLM scores while logging vector comparisons. LLM is legacy-only."
      >
        <div className="max-w-sm">
          <SelectSetting draft={draft} k="match_engine" label="Engine" options={MATCH_ENGINE_OPTIONS} fallback="llm" />
        </div>
        <p className="mt-3 text-sm text-muted-foreground">{MATCH_ENGINE_OPTIONS.find((o) => o.value === engine)?.description}</p>
      </SectionCard>

      <EncodingsSection />
      <DiagnoseSection />

      <SaveBar
        dirty={draft.dirty && active}
        saving={saving}
        onSave={() => void handleSave()}
        onDiscard={() => draft.clear()}
      />
    </div>
  );
}

function EncodingsSection() {
  const [watchUntil, setWatchUntil] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);
  const watching = watchUntil !== null;

  useEffect(() => {
    if (watchUntil === null) return;
    const id = window.setTimeout(() => setWatchUntil(null), Math.max(0, watchUntil - Date.now()));
    return () => window.clearTimeout(id);
  }, [watchUntil]);

  const stats = useQuery({
    queryKey: SHADOW_STATS_KEY,
    queryFn: () => fetchMatchEngineShadowStats(),
    refetchInterval: watching ? 5000 : false,
  });

  const backfill = useMutation({
    mutationFn: triggerMatchEngineBackfill,
    onSuccess: (res) => {
      setWatchUntil(Date.now() + BACKFILL_WATCH_MS);
      if (res.already_running) toast.info('A backfill is already running.');
      else toast.success('Backfill started', { description: 'Jobs and profiles are being encoded in the background.' });
    },
    onError: () => toast.error('Failed to start the backfill. Check that Redis and the encoding worker are up.'),
  });

  const s = stats.data;
  const histogram = s ? Object.entries(s.abs_delta_histogram).sort(([a], [b]) => a.localeCompare(b)) : [];

  return (
    <SectionCard
      title="Encodings & shadow stats"
      description="Embedding coverage and how vector scores compare with LLM scores."
      actions={
        <>
          <Button variant="outline" size="sm" disabled={stats.isFetching} onClick={() => void stats.refetch()}>
            {stats.isFetching ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Refresh
          </Button>
          <Button size="sm" disabled={backfill.isPending} onClick={() => setConfirm(true)}>
            {backfill.isPending ? <Loader2 className="animate-spin" /> : <Database />}
            Backfill encodings
          </Button>
        </>
      }
    >
      {watching ? (
        <div role="status" className="mb-4 flex items-center gap-2 rounded-lg border bg-brand-soft px-3 py-2 text-sm">
          <Loader2 className="size-3.5 animate-spin text-brand" aria-hidden />
          Backfill running · counts refresh every 5 seconds.
          <Button variant="ghost" size="xs" className="ml-auto" onClick={() => setWatchUntil(null)}>
            Stop watching
          </Button>
        </div>
      ) : null}
      {stats.isError ? (
        <QueryError message="Failed to load match engine stats." onRetry={() => void stats.refetch()} />
      ) : !s ? (
        <Skeleton className="h-16 rounded-lg" aria-label="Loading match engine stats" />
      ) : (
        <div className="space-y-3">
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" aria-label="Match engine stats">
            <Stat label="Jobs encoded" value={s.jobs_encoded.toLocaleString()} />
            <Stat label="Users encoded" value={s.users_encoded.toLocaleString()} />
            <Stat label={`Comparisons (${s.window_days}d)`} value={s.comparisons.toLocaleString()} />
            <Stat label="Mean delta" value={s.mean_delta ?? '-'} />
            <Stat label="Mean abs. error" value={s.mean_absolute_error ?? '-'} />
            <Stat label="Max abs. error" value={s.max_absolute_error ?? '-'} />
          </dl>
          {s.comparisons > 0 && histogram.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">|vector − LLM| distribution:</span>
              {histogram.map(([bucket, n]) => (
                <Badge key={bucket} variant="outline" className="font-mono tabular-nums">
                  {bucket}: {n}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No shadow comparisons yet. Set the engine to Shadow and let analyses run; each one records an LLM-vs-vector
              score pair here.
            </p>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Backfill all encodings?"
        description="Queues embedding of every job and user profile that is missing a vector. This loads the encoding worker and the embedding provider for several minutes; it is skipped if a backfill is already running."
        confirmLabel="Start backfill"
        onConfirm={() => backfill.mutate()}
      />
    </SectionCard>
  );
}

function DiagnoseSection() {
  const [jobId, setJobId] = useState('');
  const [userId, setUserId] = useState('');
  const [persist, setPersist] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const diagnose = useMutation({
    mutationFn: () =>
      diagnoseMatchEngine({
        job_id: jobId.trim(),
        user_id: userId.trim() || undefined,
        persist,
        include_logs: true,
        encode_if_missing: true,
      }),
    onError: () => toast.error('Diagnose failed. Check the job id and try again.'),
  });

  const start = () => {
    if (!jobId.trim() || diagnose.isPending) return;
    if (persist) setConfirm(true);
    else diagnose.mutate();
  };

  return (
    <SectionCard
      title="Test a job match"
      description="Runs a timed vector score with full reasoning (cosines, skill overlap, weighted contributions) and recent job logs."
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          start();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="diag-job-id">Job ID</FieldLabel>
            <Input id="diag-job-id" className="font-mono" placeholder="uuid from jobs table" value={jobId} onChange={(e) => setJobId(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="diag-user-id">User ID (optional)</FieldLabel>
            <Input
              id="diag-user-id"
              className="font-mono"
              placeholder="Defaults to you"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
            />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <label htmlFor="diag-persist" className="flex items-center gap-2 text-sm">
            <Checkbox id="diag-persist" checked={persist} onCheckedChange={(v) => setPersist(Boolean(v))} />
            Persist analysis (overwrite the saved match score)
          </label>
          <Button type="submit" disabled={diagnose.isPending || !jobId.trim()}>
            {diagnose.isPending ? <Loader2 className="animate-spin" /> : <FlaskConical />}
            Run diagnose
          </Button>
        </div>
      </form>

      {diagnose.data ? <DiagnoseResult result={diagnose.data} /> : null}

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Persist this analysis?"
        description="The diagnose result replaces the saved match score for this job and user, which can change what they see on their dashboard."
        confirmLabel="Run and persist"
        onConfirm={() => diagnose.mutate()}
      />
    </SectionCard>
  );
}

const TH = 'sticky top-0 bg-muted px-2 py-1.5 text-left text-xs font-medium text-muted-foreground';

function DiagnoseResult({ result }: { result: MatchDiagnoseResult }) {
  const vr = result.vector_result;
  const explain = (vr?.explain || {}) as Record<string, unknown>;
  const cosines = (explain.cosines || {}) as Record<string, number | null>;
  const contributions = (explain.dimension_contributions || {}) as Record<
    string,
    { score?: number; weight?: number; weighted?: number }
  >;
  const skills = (explain.skills || {}) as { matched?: string[]; missing_required?: string[] };

  return (
    <div className="mt-5 space-y-4 border-t pt-4" aria-label="Diagnose result">
      <dl className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Stat label="OK" value={result.ok ? 'yes' : 'no'} tone={result.ok ? 'ok' : 'bad'} />
        <Stat label="Score" value={vr?.overall_score ?? '-'} />
        <Stat label="Total time" value={`${result.timing?.total_ms ?? '-'} ms`} />
        <Stat label="Engine setting" value={result.match_engine_setting || '-'} />
      </dl>

      {result.errors?.length || result.warnings?.length ? (
        <ul className="space-y-1 text-sm">
          {result.errors?.map((e) => (
            <li key={e} className="text-destructive">
              Error: {e}
            </li>
          ))}
          {result.warnings?.map((w) => (
            <li key={w} className="text-status-preparing">
              Warning: {w}
            </li>
          ))}
        </ul>
      ) : null}

      {result.timing?.steps?.length ? (
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Step timings</p>
          <div className="max-h-56 overflow-auto rounded-lg border">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th className={TH}>Step</th>
                  <th className={TH}>ms</th>
                  <th className={TH}>Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {result.timing.steps.map((s, i) => (
                  <tr key={`${s.step}-${i}`}>
                    <td className="px-2 py-1.5 font-mono">{s.step}</td>
                    <td className="px-2 py-1.5 tabular-nums">{s.duration_ms}</td>
                    <td className="max-w-md truncate px-2 py-1.5 font-mono text-muted-foreground">
                      {s.detail ? JSON.stringify(s.detail) : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {vr ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Reasoning</p>
            <p className="text-sm">{vr.summary || '-'}</p>
            {vr.strengths?.length ? (
              <ul className="list-disc space-y-0.5 pl-4 text-sm text-match-strong">
                {vr.strengths.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            ) : null}
            {vr.gaps?.length ? (
              <ul className="list-disc space-y-0.5 pl-4 text-sm text-match-fair">
                {vr.gaps.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            ) : null}
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="outline" className="tabular-nums">
                exp↔content: {cosines.experience_to_content ?? '-'}
              </Badge>
              <Badge variant="outline" className="tabular-nums">
                title: {cosines.best_title ?? '-'}
              </Badge>
              <Badge variant="outline" className="tabular-nums">
                prefs: {cosines.prefs_to_content ?? '-'}
              </Badge>
            </div>
            {skills.matched?.length || skills.missing_required?.length ? (
              <p className="text-sm text-muted-foreground">
                Matched: {(skills.matched || []).join(', ') || '-'}
                <br />
                Missing required: {(skills.missing_required || []).join(', ') || '-'}
              </p>
            ) : null}
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">Weighted dimensions</p>
            <div className="overflow-auto rounded-lg border">
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    <th className={TH}>Dimension</th>
                    <th className={TH}>Score</th>
                    <th className={TH}>Weight</th>
                    <th className={TH}>Points</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {Object.entries(contributions).map(([key, c]) => (
                    <tr key={key}>
                      <td className="px-2 py-1.5 font-mono">{key}</td>
                      <td className="px-2 py-1.5 tabular-nums">{c.score ?? '-'}</td>
                      <td className="px-2 py-1.5 tabular-nums">{c.weight ?? '-'}</td>
                      <td className="px-2 py-1.5 tabular-nums">{c.weighted ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}

      {result.recent_logs?.length ? (
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Recent job logs ({result.recent_logs.length})</p>
          <div className="max-h-56 overflow-auto rounded-lg border">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th className={TH}>When</th>
                  <th className={TH}>Event</th>
                  <th className={TH}>ms</th>
                  <th className={TH}>Service</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {result.recent_logs.map((log, i) => (
                  <tr key={`${log.event}-${i}`}>
                    <td className="px-2 py-1 whitespace-nowrap text-muted-foreground">{log.created_at || '-'}</td>
                    <td className="px-2 py-1 font-mono">{log.event}</td>
                    <td className="px-2 py-1 tabular-nums">{log.duration_ms ?? '-'}</td>
                    <td className="px-2 py-1">{log.service}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <Collapsible>
        <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
          Raw diagnose JSON
          <ChevronDown />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-muted p-3 font-mono text-[11px]">
            {JSON.stringify(result, null, 2)}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
