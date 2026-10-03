import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarRange, CheckCircle2, RefreshCw, Square, Terminal, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
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
import { stopJobFetch } from '@/api/scraperApi';
import { usePostedSyncWindow } from '@/hooks/usePostedSyncWindow';
import { useScraperStore } from '@/stores/scraperStore';
import type { ScrapeRun, SyncTriggerOptions } from '@/types/scraper';
import { formatPostedWindowShort, JOB_SYNC_SCHEDULE_UPDATED_EVENT, todayIsoDate } from '@/utils/postedSyncWindow';
import { pipelineKeys, useSyncSchedule } from './queries';
import { errorMessage } from './pipelineApi';
import { relativeAgo, runStatusTone, runTimeMs, spiderNeedsAuth, spiderRunnable } from './pipelineModel';

export function SyncPanel({ className }: { className?: string }) {
  const syncing = useScraperStore((s) => s.syncing);
  const progress = useScraperStore((s) => s.syncProgress);
  const spiders = useScraperStore((s) => s.spiders);
  const runs = useScraperStore((s) => s.lastSyncRuns);
  const startSync = useScraperStore((s) => s.startSync);
  const qc = useQueryClient();
  const schedule = useSyncSchedule();
  const win = usePostedSyncWindow();
  const [authFor, setAuthFor] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    const onUpdated = () => void qc.invalidateQueries({ queryKey: pipelineKeys.schedule() });
    window.addEventListener(JOB_SYNC_SCHEDULE_UPDATED_EVENT, onUpdated);
    return () => window.removeEventListener(JOB_SYNC_SCHEDULE_UPDATED_EVENT, onUpdated);
  }, [qc]);

  const scheduled = schedule.data?.spider_names?.length
    ? new Set(schedule.data.spider_names.map((n) => n.toLowerCase()))
    : null;
  const runnable = spiders.filter(spiderRunnable);
  const scheduledRunnable = scheduled ? runnable.filter((s) => scheduled.has(s.name.toLowerCase())) : runnable;
  const syncAllTargets = scheduledRunnable.length > 0 ? scheduledRunnable : runnable;
  const usingSubset = Boolean(scheduled) && syncAllTargets.length > 0 && syncAllTargets.length < runnable.length;

  const lastBySpider = new Map<string, ScrapeRun>();
  let latestMs: number | undefined;
  for (const run of runs) {
    const key = (run.spider_name || '').toLowerCase();
    if (key && !lastBySpider.has(key)) lastBySpider.set(key, run);
    const ms = runTimeMs(run);
    if (ms != null && (latestMs == null || ms > latestMs)) latestMs = ms;
  }

  const dated = Boolean(win.postedSince.trim()) && !win.windowInvalid;
  const buildOptions = (spider: string): SyncTriggerOptions => {
    const window = dated
      ? { sync_mode: 'date_backfill' as const, posted_since: win.postedSince.trim(), posted_until: win.postedUntil.trim() || undefined }
      : { sync_mode: 'incremental' as const, posted_since: undefined, posted_until: undefined };
    if (spider === 'all') {
      const names = syncAllTargets.map((s) => s.name);
      return { spider_name: 'all', spider_names: names.length > 0 ? names : undefined, ...window };
    }
    return { spider_name: spider, ...window };
  };

  const stop = async () => {
    setStopping(true);
    try {
      const res = await stopJobFetch();
      toast.success(res.message || 'Stop requested.');
    } catch (err) {
      toast.error(errorMessage(err, 'Could not stop the fetch.'));
    } finally {
      setStopping(false);
      setConfirmStop(false);
    }
  };

  const pct = progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : null;

  return (
    <section aria-label="Job fetch" className={cn('flex min-w-0 flex-col rounded-xl border bg-card', className)}>
      <div className="flex items-start justify-between gap-2 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Job fetch</h2>
          <p className="truncate text-xs text-muted-foreground">
            {latestMs != null ? `Last sync ${relativeAgo(latestMs)}` : 'No syncs yet'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {syncing && (
            <Button variant="destructive" size="sm" onClick={() => setConfirmStop(true)} disabled={stopping}>
              <Square className="fill-current" /> {stopping ? 'Stopping…' : 'Stop'}
            </Button>
          )}
          <Button
            size="sm"
            disabled={syncing || win.windowInvalid || syncAllTargets.length === 0}
            onClick={() => void startSync(buildOptions('all'))}
            title={usingSubset ? `Syncs ${syncAllTargets.length} site(s) from Job Sync settings` : 'Sync all runnable sites'}
          >
            <RefreshCw className={cn(syncing && 'animate-spin')} />
            Sync all sites
            {dated && !syncing && <span className="rounded bg-primary-foreground/20 px-1 text-[10px]">Dated</span>}
          </Button>
        </div>
      </div>

      {syncing && (
        <div role="status" aria-live="polite" className="space-y-2 border-b bg-muted/30 px-4 py-3">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="min-w-0 truncate font-medium">{progress?.message || 'Sync in progress…'}</span>
            {progress && progress.total > 0 && (
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {progress.current}/{progress.total}
              </span>
            )}
          </div>
          <Progress value={pct} aria-label="Sync progress" />
          {progress && (progress.itemsScraped > 0 || progress.itemsNew > 0) && (
            <p className="text-xs tabular-nums text-muted-foreground">
              {progress.itemsScraped.toLocaleString()} scraped · {progress.itemsNew.toLocaleString()} new
              {progress.elapsedSeconds > 0 ? ` · ${progress.elapsedSeconds}s` : ''}
            </p>
          )}
        </div>
      )}

      <div role="group" aria-labelledby="pipeline-posted-window" className="space-y-2 border-b px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <h3 id="pipeline-posted-window" className="flex items-center gap-1.5 text-xs font-medium">
            <CalendarRange className="size-3.5 text-muted-foreground" /> Posted window
          </h3>
          {win.windowActive && (
            <Button variant="ghost" size="xs" onClick={win.clearPostedWindow}>
              <X /> Clear
            </Button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor="pipeline-posted-since" className="text-xs text-muted-foreground">Since</Label>
            <Input
              id="pipeline-posted-since"
              type="date"
              value={win.postedSince}
              max={win.postedUntil || todayIsoDate()}
              onChange={(e) => win.setPostedSince(e.target.value)}
              aria-invalid={win.windowInvalid || undefined}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pipeline-posted-until" className="text-xs text-muted-foreground">Until</Label>
            <Input
              id="pipeline-posted-until"
              type="date"
              value={win.postedUntil}
              min={win.postedSince || undefined}
              max={todayIsoDate()}
              onChange={(e) => win.setPostedUntil(e.target.value)}
              aria-invalid={win.windowInvalid || undefined}
              className="h-8 text-xs"
            />
          </div>
        </div>
        <p className={cn('text-xs', win.windowInvalid ? 'text-destructive' : 'text-muted-foreground')}>
          {win.windowInvalid
            ? '“Since” must be on or before “Until”.'
            : win.windowActive
              ? `${formatPostedWindowShort(win.postedSince)} → ${win.postedUntil ? formatPostedWindowShort(win.postedUntil) : 'today'}`
              : `Incremental — new since checkpoint${usingSubset ? ` · ${syncAllTargets.length} site(s)` : ''}. Shared with Job Sync settings.`}
        </p>
      </div>

      <div className="min-h-0 flex-1">
        <h3 className="px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground">Pull by site</h3>
        {spiders.length === 0 ? (
          <p className="px-4 pb-3 text-xs text-muted-foreground">No job sites configured. Add them in System Settings.</p>
        ) : (
          <ul className="scrollbar-thin max-h-72 overflow-y-auto pb-2">
            {spiders.map((spider) => {
              const needsAuth = spiderNeedsAuth(spider);
              const inSchedule = !scheduled || scheduled.has(spider.name.toLowerCase());
              const run = lastBySpider.get(spider.name.toLowerCase());
              const ms = run ? runTimeMs(run) : undefined;
              return (
                <li key={spider.name} className={cn('px-2', !inSchedule && !needsAuth && 'opacity-60')}>
                  <div className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-sm">
                        <span className="truncate font-medium">{spider.label}</span>
                        {spider.requires_auth && spider.auth_configured && (
                          <CheckCircle2 className="size-3.5 shrink-0 text-status-ready" aria-label="Auth configured" />
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        {ms != null && <span className={cn('size-1.5 rounded-full', runStatusTone(run?.status))} />}
                        <span title={ms != null ? new Date(ms).toLocaleString() : undefined}>
                          {ms != null ? `Synced ${relativeAgo(ms)}` : 'Never synced'}
                        </span>
                        {!inSchedule && <span>· not in schedule</span>}
                      </div>
                    </div>
                    {needsAuth ? (
                      <Button
                        variant="destructive"
                        size="xs"
                        aria-expanded={authFor === spider.name}
                        onClick={() => setAuthFor(authFor === spider.name ? null : spider.name)}
                      >
                        <AlertTriangle /> Auth
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Sync ${spider.label}`}
                        title={inSchedule ? `Sync ${spider.label}` : 'Not in Job Sync settings — still pullable individually'}
                        disabled={syncing || win.windowInvalid}
                        onClick={() => void startSync(buildOptions(spider.name))}
                      >
                        <RefreshCw />
                      </Button>
                    )}
                  </div>
                  {needsAuth && authFor === spider.name && spider.auth_setup_command && (
                    <div className="mx-2 mb-2 rounded-md border bg-muted p-2">
                      <p className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Terminal className="size-3" /> Run this command to set up auth:
                      </p>
                      <code className="block break-all font-mono text-xs select-all">{spider.auth_setup_command}</code>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <AlertDialog open={confirmStop} onOpenChange={(open) => !stopping && setConfirmStop(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop the current fetch?</AlertDialogTitle>
            <AlertDialogDescription>
              Running site syncs are interrupted. Listings already scraped are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={stopping}>Keep running</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={stopping} onClick={() => void stop()}>
              {stopping ? 'Stopping…' : 'Stop fetch'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
