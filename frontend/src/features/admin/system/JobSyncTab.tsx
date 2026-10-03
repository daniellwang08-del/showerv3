import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Loader2, OctagonX, Play, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { SectionCard } from '@/components/app/PageLayout';
import { SaveBar } from '@/components/app/SaveBar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  fetchJobSyncSchedule,
  fetchSyncCheckpoints,
  fetchSyncPlatforms,
  saveJobSyncSchedule,
  stopJobFetch,
} from '@/api/scraperApi';
import { usePostedSyncWindow } from '@/hooks/usePostedSyncWindow';
import { useScraperStore } from '@/stores/scraperStore';
import type { JobSyncSchedule, SyncCheckpoint, SyncPlatform } from '@/types/scraper';
import { JOB_SYNC_SCHEDULE_UPDATED_EVENT, todayIsoDate } from '@/utils/postedSyncWindow';
import { cn } from '@/lib/utils';
import { ConfirmDialog, OptionSelect, QueryError } from './fields';
import { SYNC_KEY } from './queries';
import { errDetail, formatWhen } from './settingsModel';
import { useReportDirty } from './useSettingsDraft';

const INTERVAL_PRESETS = [1, 2, 4, 6, 8, 12, 24] as const;

const TIMEZONE_LABELS: Record<string, string> = {
  'America/Los_Angeles': 'Pacific (Los Angeles)',
  'America/New_York': 'Eastern (New York)',
  'America/Chicago': 'Central (Chicago)',
  'America/Denver': 'Mountain (Denver)',
  UTC: 'UTC',
};

const scheduleSchema = z.object({
  enabled: z.boolean(),
  cadence: z.enum(['interval', 'daily']),
  interval_hours: z.number().int('Whole hours only.').min(1, 'At least 1 hour.').max(168, 'At most 168 hours.'),
  daily_time: z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM.'),
  timezone: z.string().min(1),
  sync_mode: z.enum(['incremental', 'date_backfill']),
  lookback_days: z.number().int('Whole days only.').min(1, 'At least 1 day.').max(90, 'At most 90 days.'),
  spider_names: z.array(z.string()).min(1, 'Select at least one platform.'),
});

type ScheduleForm = z.infer<typeof scheduleSchema>;

function toForm(row: JobSyncSchedule, platforms: SyncPlatform[]): ScheduleForm {
  return {
    enabled: row.enabled,
    cadence: row.cadence,
    interval_hours: row.interval_hours,
    daily_time: row.daily_time,
    timezone: row.timezone,
    sync_mode: row.sync_mode,
    lookback_days: row.lookback_days,
    spider_names: row.spider_names?.length ? row.spider_names : platforms.map((p) => p.name),
  };
}

function formatMarkers(markers: SyncCheckpoint['marker_job_ids']): string {
  if (Array.isArray(markers)) return markers.slice(0, 3).join(', ') || '—';
  if (markers && typeof markers === 'object') {
    return (
      Object.entries(markers)
        .slice(0, 2)
        .map(([title, ids]) => `${title}: ${Array.isArray(ids) ? ids.slice(0, 3).join(', ') : String(ids)}`)
        .join(' · ') || '—'
    );
  }
  return '—';
}

function useSyncData() {
  const platforms = useQuery({ queryKey: [...SYNC_KEY, 'platforms'], queryFn: fetchSyncPlatforms });
  const checkpoints = useQuery({ queryKey: [...SYNC_KEY, 'checkpoints'], queryFn: fetchSyncCheckpoints });
  const schedule = useQuery({ queryKey: [...SYNC_KEY, 'schedule'], queryFn: fetchJobSyncSchedule });
  return { platforms, checkpoints, schedule };
}

export function JobSyncTab({ active, onDirtyChange }: { active: boolean; onDirtyChange: (dirty: boolean) => void }) {
  const { platforms, checkpoints, schedule } = useSyncData();
  const loadSpiders = useScraperStore((s) => s.loadSpiders);
  const checkSyncStatus = useScraperStore((s) => s.checkSyncStatus);

  useEffect(() => {
    void loadSpiders();
  }, [loadSpiders]);

  useEffect(() => {
    if (!active) return;
    void checkSyncStatus();
    const id = window.setInterval(() => void checkSyncStatus(), 4000);
    return () => window.clearInterval(id);
  }, [active, checkSyncStatus]);

  const error = platforms.error ?? schedule.error;
  if (error) {
    return (
      <QueryError
        message={errDetail(error, 'Failed to load sync settings.')}
        onRetry={() => {
          void platforms.refetch();
          void schedule.refetch();
          void checkpoints.refetch();
        }}
      />
    );
  }
  if (!platforms.data || !schedule.data) {
    return (
      <div className="space-y-6" aria-busy="true" aria-label="Loading job sync">
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }
  return (
    <JobSyncBody
      platforms={platforms.data}
      schedule={schedule.data}
      checkpoints={checkpoints.data ?? []}
      active={active}
      onDirtyChange={onDirtyChange}
    />
  );
}

function JobSyncBody({
  platforms,
  schedule,
  checkpoints,
  active,
  onDirtyChange,
}: {
  platforms: SyncPlatform[];
  schedule: JobSyncSchedule;
  checkpoints: SyncCheckpoint[];
  active: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const syncing = useScraperStore((s) => s.syncing);
  const syncProgress = useScraperStore((s) => s.syncProgress);
  const spiders = useScraperStore((s) => s.spiders);
  const checkSyncStatus = useScraperStore((s) => s.checkSyncStatus);

  const authOk = (name: string) => {
    const spider = spiders.find((s) => s.name === name);
    return !spider || !spider.requires_auth || spider.auth_optional === true || spider.auth_configured;
  };

  const saved = toForm(schedule, platforms);
  const [draft, setDraft] = useState<Partial<ScheduleForm>>({});
  const values = { ...saved, ...draft };
  const set = (patch: Partial<ScheduleForm>) => setDraft((d) => ({ ...d, ...patch }));
  const normalized = (f: ScheduleForm) => JSON.stringify({ ...f, spider_names: [...f.spider_names].sort() });
  const dirty = normalized(values) !== normalized(saved);
  useReportDirty(dirty, onDirtyChange);

  const parsed = scheduleSchema.safeParse(values);
  const fieldErrors = parsed.success ? {} : parsed.error.flatten().fieldErrors;
  const blockedSchedule = values.spider_names.filter((n) => !authOk(n));
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!parsed.success || blockedSchedule.length) return;
    setSaving(true);
    try {
      const next = await saveJobSyncSchedule({
        ...parsed.data,
        spider_names: platforms.filter((p) => parsed.data.spider_names.includes(p.name)).map((p) => p.name),
      });
      queryClient.setQueryData([...SYNC_KEY, 'schedule'], next);
      setDraft({});
      window.dispatchEvent(new CustomEvent(JOB_SYNC_SCHEDULE_UPDATED_EVENT));
      toast.success(next.enabled ? `Schedule saved. Next run: ${formatWhen(next.next_run_at)}.` : 'Schedule saved (disabled).');
    } catch (err) {
      toast.error(errDetail(err, 'Failed to save schedule.'));
    } finally {
      setSaving(false);
    }
  };

  const [confirmStop, setConfirmStop] = useState(false);
  const stop = useMutation({
    mutationFn: stopJobFetch,
    onSuccess: (res) => {
      useScraperStore.setState({
        syncing: false,
        syncProgress: null,
        syncStatus: { status: 'idle', spider_name: null, message: res.message || 'Job fetching stopped.' },
      });
      if (res.schedule_disabled || schedule.enabled) {
        queryClient.setQueryData<JobSyncSchedule>([...SYNC_KEY, 'schedule'], (prev) =>
          prev ? { ...prev, enabled: false, next_run_at: null } : prev,
        );
        setDraft((d) => {
          const next = { ...d };
          delete next.enabled;
          return next;
        });
      }
      void checkSyncStatus();
      toast.success(res.message || 'Job fetching stopped.');
    },
    onError: (err) => toast.error(errDetail(err, 'Failed to stop job fetching.')),
  });

  const timezoneOptions = (schedule.allowed_timezones?.length ? schedule.allowed_timezones : Object.keys(TIMEZONE_LABELS)).map(
    (tz) => ({ value: tz, label: TIMEZONE_LABELS[tz] || tz }),
  );

  return (
    <div className="space-y-6">
      <div
        className={cn(
          'flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3',
          syncing ? 'border-destructive/40 bg-destructive/5' : 'bg-card',
        )}
        role="status"
        aria-label="Fetch status"
      >
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium">
            {syncing ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            {syncing ? 'Fetch in progress' : 'No fetch running'}
          </p>
          <p className="text-sm text-muted-foreground">
            {syncing
              ? syncProgress?.message || syncProgress?.spiderName || 'A sync is queued or running.'
              : 'Stop becomes available while a sync is queued or running.'}
            {syncing && syncProgress?.itemsScraped ? (
              <span className="tabular-nums"> · {syncProgress.itemsScraped.toLocaleString()} scraped</span>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: SYNC_KEY });
              void useScraperStore.getState().loadSpiders();
              void checkSyncStatus();
            }}
          >
            <RefreshCw />
            Refresh
          </Button>
          <Button variant="destructive" size="sm" disabled={!syncing || stop.isPending} onClick={() => setConfirmStop(true)}>
            {stop.isPending ? <Loader2 className="animate-spin" /> : <OctagonX />}
            {stop.isPending ? 'Stopping…' : 'Stop fetching'}
          </Button>
        </div>
      </div>

      <SectionCard
        title="Scheduled sync"
        description="Automatic polling. The Jobs page Sync All still handles quick incremental updates."
        actions={
          <div className="flex items-center gap-2">
            <span id="sched-enabled-label" className="text-sm text-muted-foreground">
              Auto-run
            </span>
            <Switch
              aria-labelledby="sched-enabled-label"
              checked={values.enabled}
              onCheckedChange={(enabled) => set({ enabled })}
            />
          </div>
        }
      >
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel id="sched-cadence-label">Cadence</FieldLabel>
              <ToggleGroup
                aria-labelledby="sched-cadence-label"
                variant="outline"
                size="sm"
                spacing={0}
                value={[values.cadence]}
                onValueChange={(next) => next[0] && set({ cadence: next[0] as ScheduleForm['cadence'] })}
              >
                <ToggleGroupItem value="daily">Daily</ToggleGroupItem>
                <ToggleGroupItem value="interval">Every N hours</ToggleGroupItem>
              </ToggleGroup>
            </Field>
            <Field>
              <FieldLabel id="sched-mode-label">What to pull</FieldLabel>
              <ToggleGroup
                aria-labelledby="sched-mode-label"
                variant="outline"
                size="sm"
                spacing={0}
                value={[values.sync_mode]}
                onValueChange={(next) => next[0] && set({ sync_mode: next[0] as ScheduleForm['sync_mode'] })}
              >
                <ToggleGroupItem value="incremental">Since checkpoint</ToggleGroupItem>
                <ToggleGroupItem value="date_backfill">Lookback window</ToggleGroupItem>
              </ToggleGroup>
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            {values.cadence === 'daily' ? (
              <>
                <Field data-invalid={fieldErrors.daily_time ? true : undefined}>
                  <FieldLabel htmlFor="sched-daily-time">Run at</FieldLabel>
                  <Input
                    id="sched-daily-time"
                    type="time"
                    value={values.daily_time}
                    onChange={(e) => set({ daily_time: e.target.value })}
                  />
                  {fieldErrors.daily_time ? <FieldError>{fieldErrors.daily_time[0]}</FieldError> : null}
                </Field>
                <Field>
                  <FieldLabel htmlFor="sched-timezone">Timezone</FieldLabel>
                  <OptionSelect
                    id="sched-timezone"
                    value={values.timezone}
                    options={timezoneOptions}
                    onChange={(timezone) => set({ timezone })}
                  />
                </Field>
              </>
            ) : (
              <Field data-invalid={fieldErrors.interval_hours ? true : undefined} className="sm:col-span-2">
                <FieldLabel htmlFor="sched-interval">Interval (hours)</FieldLabel>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Input
                    id="sched-interval"
                    type="number"
                    min={1}
                    max={168}
                    className="w-20 tabular-nums"
                    value={Number.isFinite(values.interval_hours) ? values.interval_hours : ''}
                    onChange={(e) => set({ interval_hours: e.target.value === '' ? Number.NaN : Number(e.target.value) })}
                  />
                  {INTERVAL_PRESETS.map((h) => (
                    <Button
                      key={h}
                      variant={values.interval_hours === h ? 'secondary' : 'ghost'}
                      size="xs"
                      aria-pressed={values.interval_hours === h}
                      className="tabular-nums"
                      onClick={() => set({ interval_hours: h })}
                    >
                      {h}h
                    </Button>
                  ))}
                </div>
                {fieldErrors.interval_hours ? <FieldError>{fieldErrors.interval_hours[0]}</FieldError> : null}
              </Field>
            )}
            {values.sync_mode === 'date_backfill' ? (
              <Field data-invalid={fieldErrors.lookback_days ? true : undefined}>
                <FieldLabel htmlFor="sched-lookback">Lookback (days)</FieldLabel>
                <Input
                  id="sched-lookback"
                  type="number"
                  min={1}
                  max={90}
                  className="tabular-nums"
                  value={Number.isFinite(values.lookback_days) ? values.lookback_days : ''}
                  onChange={(e) => set({ lookback_days: e.target.value === '' ? Number.NaN : Number(e.target.value) })}
                />
                {fieldErrors.lookback_days ? <FieldError>{fieldErrors.lookback_days[0]}</FieldError> : null}
              </Field>
            ) : null}
          </div>

          <PlatformPicker
            legend="Scheduled platforms"
            platforms={platforms}
            selected={values.spider_names}
            authOk={authOk}
            onChange={(spider_names) => set({ spider_names })}
            error={fieldErrors.spider_names?.[0]}
          />

          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Next:</span>{' '}
            {values.enabled ? formatWhen(schedule.next_run_at) : '— (disabled)'}
            <span className="mx-1.5">·</span>
            <span className="font-medium text-foreground">Last:</span> {formatWhen(schedule.last_run_at)}
            {schedule.last_run_status ? (
              <Badge variant="outline" className="ml-1.5">
                {schedule.last_run_status}
              </Badge>
            ) : null}
          </p>
          {schedule.last_run_message ? <p className="text-xs text-muted-foreground">{schedule.last_run_message}</p> : null}
        </div>
      </SectionCard>

      <ManualSync platforms={platforms} checkpoints={checkpoints} authOk={authOk} />

      <ConfirmDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title="Stop job fetching?"
        description="Stops the current scrape, skips the remaining platforms, and disables the sync schedule. Jobs already saved are kept."
        confirmLabel="Stop fetching"
        destructive
        onConfirm={() => stop.mutate()}
      />

      <SaveBar
        dirty={dirty && active}
        saving={saving}
        disabled={!parsed.success || blockedSchedule.length > 0}
        saveLabel="Save schedule"
        onSave={() => void handleSave()}
        onDiscard={() => setDraft({})}
      />
    </div>
  );
}

function PlatformPicker({
  legend,
  platforms,
  selected,
  authOk,
  onChange,
  error,
}: {
  legend: string;
  platforms: SyncPlatform[];
  selected: string[];
  authOk: (name: string) => boolean;
  onChange: (next: string[]) => void;
  error?: string;
}) {
  const blocked = selected.filter((n) => !authOk(n));
  const legendId = `${legend.replace(/\s+/g, '-').toLowerCase()}-legend`;
  return (
    <div role="group" aria-labelledby={legendId}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p id={legendId} className="text-sm font-medium">
          {legend}
        </p>
        <Button variant="link" size="xs" onClick={() => onChange(platforms.map((p) => p.name))}>
          Select all
        </Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {platforms.map((p) => {
          const checked = selected.includes(p.name);
          const ok = authOk(p.name);
          const id = `${legendId}-${p.name}`;
          return (
            <label
              key={p.name}
              htmlFor={id}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm',
                checked && 'border-brand/40 bg-brand-soft',
              )}
            >
              <Checkbox
                id={id}
                checked={checked}
                onCheckedChange={(next) =>
                  onChange(next ? [...selected, p.name] : selected.filter((n) => n !== p.name))
                }
              />
              <span className="min-w-0 flex-1 truncate">{p.label}</span>
              {p.requires_auth ? (
                <span className={cn('shrink-0 text-xs', ok ? 'text-status-ready' : 'text-destructive')}>
                  {ok ? 'Auth OK' : 'Auth required'}
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
      {error ? <p className="mt-1.5 text-sm text-destructive">{error}</p> : null}
      {blocked.length ? <p className="mt-1.5 text-sm text-destructive">Auth required: {blocked.join(', ')}</p> : null}
    </div>
  );
}

function ManualSync({
  platforms,
  checkpoints,
  authOk,
}: {
  platforms: SyncPlatform[];
  checkpoints: SyncCheckpoint[];
  authOk: (name: string) => boolean;
}) {
  const syncing = useScraperStore((s) => s.syncing);
  const { postedSince, postedUntil, windowInvalid, setPostedSince, setPostedUntil } = usePostedSyncWindow();
  const [selected, setSelected] = useState<string[]>(() => platforms.map((p) => p.name));
  const [running, setRunning] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const list = platforms.filter((p) => selected.includes(p.name)).map((p) => p.name);
  const blocked = list.filter((n) => !authOk(n));
  const canRun = !syncing && !running && postedSince.trim() !== '' && list.length > 0 && blocked.length === 0 && !windowInvalid;

  const run = async () => {
    setRunning(true);
    try {
      await useScraperStore.getState().startSync({
        spider_name: 'all',
        sync_mode: 'date_backfill',
        spider_names: list,
        posted_since: postedSince,
        posted_until: postedUntil || undefined,
      });
      const { syncing: queued, syncStatus } = useScraperStore.getState();
      if (!queued) throw new Error('Failed to queue date-range sync.');
      toast.success(syncStatus?.message || 'Date-range sync queued.');
    } catch (err) {
      toast.error(errDetail(err, 'Failed to queue date-range sync.'));
    } finally {
      setRunning(false);
    }
  };

  return (
    <SectionCard title="Manual date-range sync" description="Run a one-off backfill for jobs posted in a date window.">
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field data-invalid={windowInvalid ? true : undefined}>
            <FieldLabel htmlFor="sync-posted-since">Posted since</FieldLabel>
            <Input
              id="sync-posted-since"
              type="date"
              value={postedSince}
              max={postedUntil || undefined}
              onChange={(e) => setPostedSince(e.target.value)}
            />
          </Field>
          <Field data-invalid={windowInvalid ? true : undefined}>
            <FieldLabel htmlFor="sync-posted-until">Posted until</FieldLabel>
            <Input
              id="sync-posted-until"
              type="date"
              value={postedUntil}
              min={postedSince || undefined}
              max={todayIsoDate()}
              onChange={(e) => setPostedUntil(e.target.value)}
            />
            {windowInvalid ? <FieldError>Until must be on or after Since.</FieldError> : null}
          </Field>
        </div>
        <FieldDescription>Same Since / Until as the dashboard Job fetch panel; changing either place updates both.</FieldDescription>

        <PlatformPicker legend="Platforms to backfill" platforms={platforms} selected={selected} authOk={authOk} onChange={setSelected} />

        {checkpoints.length > 0 ? (
          <Collapsible className="rounded-lg border">
            <CollapsibleTrigger
              render={
                <Button variant="ghost" size="sm" className="w-full justify-between rounded-lg px-3">
                  Checkpoint markers
                  <ChevronDown />
                </Button>
              }
            />
            <CollapsibleContent>
              <ul className="space-y-1 border-t px-3 py-2 text-sm">
                {checkpoints.map((cp) => (
                  <li key={cp.spider_name} className="flex flex-wrap gap-x-2">
                    <span className="font-medium capitalize">{cp.spider_name}</span>
                    <span className="truncate font-mono text-xs text-muted-foreground">{formatMarkers(cp.marker_job_ids)}</span>
                  </li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        ) : null}

        <Button disabled={!canRun} onClick={() => setConfirm(true)}>
          {running || syncing ? <Loader2 className="animate-spin" /> : <Play />}
          {running || syncing ? 'Sync running…' : 'Run date-range sync'}
        </Button>
      </div>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Run date-range sync?"
        description={`Scrapes ${list.length} platform${list.length === 1 ? '' : 's'} for jobs posted ${postedSince}${
          postedUntil ? ` to ${postedUntil}` : ' to today'
        }. It runs in the background and can take several minutes; new jobs are queued for extraction and analysis.`}
        confirmLabel="Run sync"
        onConfirm={() => void run()}
      />
    </SectionCard>
  );
}