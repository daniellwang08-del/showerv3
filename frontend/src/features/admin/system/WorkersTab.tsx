import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eraser, Loader2, RefreshCw, TimerOff } from 'lucide-react';
import { toast } from 'sonner';
import { SectionCard } from '@/components/app/PageLayout';
import { SaveBar } from '@/components/app/SaveBar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { clearQueue, fetchOpsOverview, interruptStaleScrapes, updateSystemSettings } from '@/api/adminApi';
import type { QueueInfo, SystemSettingsResponse } from '@/types/admin';
import { ConfirmDialog, NumberSetting, QueryError, Stat } from './fields';
import { OPS_KEY, useSetSystemSettings } from './queries';
import { errDetail, WORKER_KEYS } from './settingsModel';
import { useReportDirty, useSettingsDraft } from './useSettingsDraft';

const DRAFT_KEYS = WORKER_KEYS.map((w) => w.key);
const TH = 'sticky top-0 z-10 bg-muted px-3 py-2 text-left text-xs font-medium text-muted-foreground';

export function WorkersTab({
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
      toast.success('Worker concurrency saved', { description: 'Each worker applies its new limit when it restarts.' });
    } catch (err) {
      toast.error(errDetail(err, 'Failed to save worker concurrency'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <SectionCard title="Worker concurrency" description="arq max_jobs per worker process. Applied when that worker restarts.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {WORKER_KEYS.map((w) => (
            <NumberSetting key={w.key} draft={draft} k={w.key} label={w.label} />
          ))}
        </div>
      </SectionCard>

      <OpsSection active={active} />

      <SaveBar
        dirty={draft.dirty && active}
        saving={saving}
        disabled={!draft.valid}
        onSave={() => void handleSave()}
        onDiscard={() => draft.clear()}
      />
    </div>
  );
}

function OpsSection({ active }: { active: boolean }) {
  const queryClient = useQueryClient();
  const ops = useQuery({
    queryKey: OPS_KEY,
    queryFn: fetchOpsOverview,
    refetchInterval: active ? 15_000 : false,
  });
  const [queueToClear, setQueueToClear] = useState<QueueInfo | null>(null);
  const [confirmInterrupt, setConfirmInterrupt] = useState(false);

  const clear = useMutation({
    mutationFn: (q: QueueInfo) => clearQueue(q.id),
    onSuccess: (res, q) => {
      toast.success(`Cleared ${q.label} queue`, { description: `${res.keys_deleted} key(s) deleted.` });
      void queryClient.invalidateQueries({ queryKey: OPS_KEY });
    },
    onError: (err) => toast.error(errDetail(err, 'Failed to clear queue')),
  });
  const interrupt = useMutation({
    mutationFn: interruptStaleScrapes,
    onSuccess: (res) => {
      toast.success(`Interrupted ${res.interrupted_count} stale scrape(s)`);
      void queryClient.invalidateQueries({ queryKey: OPS_KEY });
    },
    onError: () => toast.error('Failed to interrupt stale scrapes'),
  });

  const refresh = (
    <Button variant="outline" size="sm" disabled={ops.isFetching} onClick={() => void ops.refetch()}>
      {ops.isFetching ? <Loader2 className="animate-spin" /> : <RefreshCw />}
      Refresh
    </Button>
  );

  if (ops.isError) {
    return (
      <SectionCard title="Health & queues" actions={refresh}>
        <QueryError message={errDetail(ops.error, 'Failed to load ops overview.')} onRetry={() => void ops.refetch()} />
      </SectionCard>
    );
  }
  if (!ops.data) {
    return (
      <SectionCard title="Health & queues" actions={refresh}>
        <div className="space-y-3" aria-busy="true" aria-label="Loading ops overview">
          <Skeleton className="h-14 rounded-lg" />
          <Skeleton className="h-32 rounded-lg" />
        </div>
      </SectionCard>
    );
  }

  const { health, scrape, queues = [], recent_scrape_runs: runs = [] } = ops.data;
  const apiOk = health.status === 'ok' || health.status === 'healthy';

  return (
    <>
      <SectionCard title="Health & queues" description="Service health and pending work per queue. Refreshes every 15 seconds." actions={refresh}>
        <div className="space-y-5">
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Service health">
            <Stat label="API" value={health.status} tone={apiOk ? 'ok' : 'bad'} />
            <Stat label="Database" value={health.database_connected ? 'ok' : 'down'} tone={health.database_connected ? 'ok' : 'bad'} />
            <Stat label="Redis" value={health.redis_connected ? 'ok' : 'down'} tone={health.redis_connected ? 'ok' : 'bad'} />
            <Stat label="Browsers available" value={health.browser_pool_available} />
          </dl>

          {queues.length ? (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[520px] text-sm" aria-label="Queues">
                <thead>
                  <tr>
                    <th className={TH}>Queue</th>
                    <th className={`${TH} text-right`}>Pending</th>
                    <th className={TH}>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {queues.map((q) => (
                    <tr key={q.id}>
                      <td className="px-3 py-2">
                        <p className="font-medium">{q.label}</p>
                        <p className="text-xs text-muted-foreground">{q.description}</p>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {q.reachable ? (q.pending ?? 0).toLocaleString() : <Badge variant="destructive">unreachable</Badge>}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!q.reachable || (clear.isPending && clear.variables?.id === q.id)}
                          aria-label={`Clear ${q.label} queue`}
                          onClick={() => setQueueToClear(q)}
                        >
                          <Eraser />
                          Clear
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No queues reported.</p>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title="Scrapes"
        description="Current scrape and recent runs."
        actions={
          <Button variant="outline" size="sm" disabled={interrupt.isPending} onClick={() => setConfirmInterrupt(true)}>
            {interrupt.isPending ? <Loader2 className="animate-spin" /> : <TimerOff />}
            Interrupt stale
          </Button>
        }
      >
        <div className="space-y-4">
          <p className="flex flex-wrap items-center gap-2 text-sm" aria-label="Scrape status">
            <Badge variant={scrape.status === 'running' ? 'secondary' : 'outline'}>{scrape.status}</Badge>
            {scrape.status === 'running' ? (
              <span className="tabular-nums text-muted-foreground">
                {scrape.spider_name} · {(scrape.items_scraped ?? 0).toLocaleString()} items
                {scrape.elapsed_seconds != null ? ` · ${scrape.elapsed_seconds}s` : ''}
              </span>
            ) : null}
          </p>
          {runs.length ? (
            <div className="max-h-80 overflow-auto rounded-lg border">
              <table className="w-full min-w-[480px] text-sm" aria-label="Recent scrape runs">
                <thead>
                  <tr>
                    <th className={TH}>Spider</th>
                    <th className={TH}>Status</th>
                    <th className={`${TH} text-right`}>Scraped</th>
                    <th className={TH}>Started</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td className="px-3 py-2 font-medium">{r.spider_name}</td>
                      <td className="px-3 py-2">
                        <Badge variant={r.status === 'failed' ? 'destructive' : 'outline'}>{r.status}</Badge>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{(r.items_scraped ?? 0).toLocaleString()}</td>
                      <td className="px-3 py-2 text-muted-foreground tabular-nums">
                        {r.started_at ? new Date(r.started_at).toLocaleString() : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No recent scrape runs.</p>
          )}
        </div>
      </SectionCard>

      <ConfirmDialog
        open={queueToClear !== null}
        onOpenChange={(open) => !open && setQueueToClear(null)}
        title={`Clear the ${queueToClear?.label ?? ''} queue?`}
        description={`Deletes ${
          queueToClear?.pending != null ? `all ${queueToClear.pending.toLocaleString()} pending` : 'all pending'
        } job(s) in this queue. In-flight work is not cancelled. This cannot be undone.`}
        confirmLabel="Clear queue"
        destructive
        onConfirm={() => queueToClear && clear.mutate(queueToClear)}
      />
      <ConfirmDialog
        open={confirmInterrupt}
        onOpenChange={setConfirmInterrupt}
        title="Interrupt stale scrapes?"
        description="Marks scrape runs that stopped reporting progress as interrupted so new syncs can start. Healthy running scrapes are not affected."
        confirmLabel="Interrupt"
        onConfirm={() => interrupt.mutate()}
      />
    </>
  );
}
