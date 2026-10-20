import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Bot, CheckCircle2, Gauge, Loader2, Send, Settings2, Zap, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/api/client';
import type { DashboardView } from '@/api/scraperApi';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { openAutoApply } from '@/lib/extensionBridge';
import { cn } from '@/lib/utils';
import { useSettingsQuery } from '@/features/settings/queries';
import { useScraperStore } from '@/stores/scraperStore';
import { extractApiErrorMessage } from '@/utils/profileErrors';
import type { UserSettings } from '@/types/settings';
import { viewTone } from './viewTone';

const RUN_SIZES: readonly number[] = [10, 25, 50];

function runOptions(scored: number): Array<{ size: number; all: boolean }> {
  const options = RUN_SIZES.filter((n) => n < scored).map((size) => ({ size, all: false }));
  if (scored > 0 && scored <= RUN_SIZES[RUN_SIZES.length - 1]) options.push({ size: scored, all: true });
  return options;
}

interface MakeReadyResult {
  queued: number;
  already_running: number;
  failed: number;
  remaining: number;
  resume_source: 'original' | 'tailored';
  original_resume_missing: boolean;
}

/** Headline cards above the jobs table (each opens its view) plus a preference summary. */
export function JobsSummary({
  ready,
  todayReady,
  scored,
  appliedToday,
  appliedWeek,
  weekDates,
  activeView,
  onView,
}: {
  ready: number | undefined;
  todayReady: number | undefined;
  scored: number | undefined;
  appliedToday: number | undefined;
  appliedWeek: number[] | undefined;
  weekDates: string[] | undefined;
  activeView: DashboardView;
  onView: (view: DashboardView) => void;
}) {
  const reduceMotion = usePrefersReducedMotion();
  const settings = useSettingsQuery().data;
  const animate = (index: number) => (reduceMotion ? undefined : { animationDelay: `${80 + index * 70}ms` });

  return (
    <div className="grid grid-cols-1 gap-2 lg:grid-cols-[minmax(0,4fr)_minmax(0,1fr)]">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" aria-label="Job summary">
        <SummaryCard
          view="ready"
          label="Ready to apply"
          value={ready}
          icon={CheckCircle2}
          active={activeView === 'ready'}
          onView={onView}
          style={animate(0)}
          motion={!reduceMotion}
          aside={<AutoApplyButton ready={ready ?? 0} />}
        >
          <ReadyBreakdown total={ready} today={todayReady} />
        </SummaryCard>

        <SummaryCard
          view="available"
          label="Scored"
          value={scored}
          icon={Gauge}
          active={activeView === 'available'}
          onView={onView}
          style={animate(1)}
          motion={!reduceMotion}
          aside={<RunReadyButton scored={scored ?? 0} settings={settings} />}
        >
          <p className="truncate text-xs text-muted-foreground">
            {settings?.application_resume_source === 'original'
              ? 'Original resume, cover letter per job'
              : 'Tailored resume and cover letter per job'}
          </p>
        </SummaryCard>

        <SummaryCard
          view="applied_today"
          label="Applied today"
          value={appliedToday}
          icon={Send}
          active={activeView === 'applied_today'}
          onView={onView}
          style={animate(2)}
          motion={!reduceMotion}
          aside={<WeekChart values={appliedWeek} dates={weekDates} />}
        >
          <WeekCaption values={appliedWeek} />
        </SummaryCard>
      </div>

      <PreferencesSummary settings={settings} style={animate(3)} motion={!reduceMotion} />
    </div>
  );
}

function SummaryCard({
  view,
  label,
  value,
  icon: Icon,
  active,
  onView,
  style,
  motion,
  aside,
  children,
}: {
  view: DashboardView;
  label: string;
  value: number | undefined;
  icon: LucideIcon;
  active: boolean;
  onView: (view: DashboardView) => void;
  style?: React.CSSProperties;
  motion: boolean;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  const tone = viewTone(view);
  return (
    <div
      style={style}
      className={cn(
        'group relative flex min-h-[92px] items-center gap-3 rounded-xl border bg-card/90 px-3.5 py-3 shadow-xs backdrop-blur-sm transition-all',
        'hover:-translate-y-0.5 hover:shadow-md',
        active && cn('ring-2', tone.ring),
        motion && 'jobs-summary-card',
      )}
    >
      <button
        type="button"
        aria-pressed={active}
        aria-label={`${label}: ${value == null ? 'loading' : value.toLocaleString()}`}
        onClick={() => onView(view)}
        className="absolute inset-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      />
      <span
        aria-hidden
        className={cn(
          'pointer-events-none inline-flex size-10 shrink-0 items-center justify-center rounded-lg transition-transform duration-300 group-hover:scale-105',
          tone.soft,
        )}
      >
        <Icon className="size-5" />
      </span>
      <span className="pointer-events-none min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="text-2xl leading-tight font-semibold tabular-nums">
            {value == null ? <span className="text-muted-foreground/50">-</span> : value.toLocaleString()}
          </span>
          <span className="truncate text-sm font-medium">{label}</span>
        </span>
        <span className="mt-1 block">{children}</span>
      </span>
      {aside && <div className="relative z-10 shrink-0">{aside}</div>}
    </div>
  );
}

function ReadyBreakdown({ total, today }: { total: number | undefined; today: number | undefined }) {
  const all = total ?? 0;
  const fresh = Math.min(today ?? 0, all);
  const staged = Math.max(0, all - fresh);
  const freshPct = all > 0 ? (fresh / all) * 100 : 0;
  return (
    <span className="block space-y-1.5">
      <span className="flex h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
        <span className="h-full bg-status-ready transition-[width] duration-500" style={{ width: `${freshPct}%` }} />
        <span className="h-full flex-1 bg-status-ready/35" />
      </span>
      <span className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-status-ready" />
          Today <b className="font-semibold text-foreground tabular-nums">{fresh.toLocaleString()}</b>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-status-ready/40" />
          Staged <b className="font-semibold text-foreground tabular-nums">{staged.toLocaleString()}</b>
        </span>
      </span>
    </span>
  );
}

function AutoApplyButton({ ready }: { ready: number }) {
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      const res = await openAutoApply();
      if (!res.ok) toast.error(res.error || 'Could not open auto-apply in the NAO extension.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      disabled={ready === 0 || busy}
      onClick={() => void open()}
      title="Fill and submit ready jobs automatically with the NAO extension"
      className={cn(
        'group/auto inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold outline-none transition-all',
        'bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-sm shadow-emerald-500/30',
        'hover:-translate-y-px hover:shadow-md hover:shadow-emerald-500/40 focus-visible:ring-2 focus-visible:ring-ring/50',
        'disabled:pointer-events-none disabled:opacity-50',
      )}
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Bot className="size-3.5 transition-transform group-hover/auto:scale-110" />}
      Auto-apply
    </button>
  );
}

function RunReadyButton({ scored, settings }: { scored: number; settings: UserSettings | undefined }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const original = settings?.application_resume_source === 'original';

  const run = async (limit: number) => {
    setBusy(true);
    try {
      const { data } = await apiClient.post<MakeReadyResult>('/jobs/scored/make-ready', { limit });
      setOpen(false);
      const parts = [`Queued ${data.queued} job${data.queued === 1 ? '' : 's'}`];
      if (data.already_running > 0) parts.push(`${data.already_running} already in progress`);
      if (data.queued === 0 && data.already_running === 0) {
        toast.info('No scored jobs need documents right now.');
      } else {
        toast.success(`${parts.join(', ')}.`, {
          description:
            data.resume_source === 'original'
              ? 'Writing a cover letter for each. Your original resume is attached as is.'
              : 'Tailoring a resume and cover letter for each. They move to Ready to apply when done.',
        });
      }
      if (data.original_resume_missing) {
        toast.warning('Upload your original resume in Profile so it can be attached to applications.');
      }
      const store = useScraperStore.getState();
      void store.bgRefreshJobs();
      void store.loadStats({ silent: true, isAdmin: false });
    } catch (err) {
      toast.error(extractApiErrorMessage(err, 'Could not start the run.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={scored === 0 || busy}
        aria-label="Make scored jobs ready to apply"
        className={cn(
          'group/run inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold outline-none transition-all',
          'bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-sm shadow-amber-500/30',
          'hover:-translate-y-px hover:shadow-md hover:shadow-amber-500/40 focus-visible:ring-2 focus-visible:ring-ring/50',
          'disabled:pointer-events-none disabled:opacity-50',
        )}
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5 transition-transform group-hover/run:scale-110" />}
        Run ready
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 gap-3 p-3">
        <div className="space-y-1">
          <p className="text-sm font-semibold">Make scored jobs ready</p>
          <p className="text-xs text-muted-foreground">
            {original
              ? 'You apply with your original resume, so it is attached unchanged. Each job only gets a cover letter.'
              : 'Each job gets a tailored resume and a cover letter, then moves to Ready to apply.'}{' '}
            Highest scores go first.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {runOptions(scored).map(({ size, all }) => (
            <button
              key={size}
              type="button"
              disabled={busy}
              onClick={() => void run(size)}
              className="rounded-lg border bg-muted/40 px-2 py-2 text-center transition-colors hover:border-amber-500/50 hover:bg-amber-500/10 disabled:pointer-events-none disabled:opacity-40"
            >
              <span className="block text-base font-semibold tabular-nums">{size}</span>
              <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">
                {all ? 'All' : `Top ${size}`}
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function WeekCaption({ values }: { values: number[] | undefined }) {
  const week = (values ?? []).reduce((a, b) => a + b, 0);
  const avg = values?.length ? week / values.length : 0;
  return (
    <p className="truncate text-xs text-muted-foreground">
      <b className="font-semibold text-foreground tabular-nums">{week.toLocaleString()}</b> this week
      <span className="mx-1.5 text-muted-foreground/50">|</span>
      {avg >= 10 ? Math.round(avg) : avg.toFixed(1)}/day
    </p>
  );
}

function weekdayLetter(iso: string | undefined, fallbackIndex: number): string {
  if (!iso) return String(fallbackIndex + 1);
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { weekday: 'narrow' });
}

function WeekChart({ values, dates }: { values: number[] | undefined; dates: string[] | undefined }) {
  const series = values?.length ? values : Array.from({ length: 7 }, () => 0);
  const max = Math.max(1, ...series);
  const last = series.length - 1;
  return (
    <div className="flex items-end gap-1" role="img" aria-label="Applications over the last 7 days">
      {series.map((v, i) => {
        const day = dates?.[i];
        const label = day
          ? new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
          : `Day ${i + 1}`;
        return (
          <div key={day ?? i} className="flex flex-col items-center gap-1" title={`${label}: ${v} applied`}>
            <div className="relative flex h-10 w-2.5 items-end overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  'w-full rounded-full transition-[height] duration-500',
                  i === last ? 'bg-status-applied' : 'bg-status-applied/45',
                )}
                style={{ height: v > 0 ? `${Math.max(12, (v / max) * 100)}%` : '0%' }}
              />
            </div>
            <span className={cn('text-[9px] leading-none text-muted-foreground', i === last && 'font-semibold text-foreground')}>
              {weekdayLetter(day, i)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

const WORK_MODE_LABEL: Record<string, string> = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'Onsite' };

function PreferencesSummary({
  settings,
  style,
  motion,
}: {
  settings: UserSettings | undefined;
  style?: React.CSSProperties;
  motion: boolean;
}) {
  const modes = settings?.work_mode_preferences ?? [];
  const countries = settings?.country_preferences ?? [];
  const items: Array<{ label: string; value: string }> = [
    {
      label: 'Resume',
      value: settings == null ? '-' : settings.application_resume_source === 'original' ? 'Original' : 'Tailored',
    },
    { label: 'Min match', value: settings?.min_match_score ? `${settings.min_match_score}+` : 'Any' },
    { label: 'Work mode', value: modes.length ? modes.map((m) => WORK_MODE_LABEL[m] ?? m).join(', ') : 'Any' },
    {
      label: 'Countries',
      value: countries.length
        ? countries.slice(0, 2).join(', ').toUpperCase() + (countries.length > 2 ? ` +${countries.length - 2}` : '')
        : 'Any',
    },
  ];

  return (
    <section
      aria-label="Your preferences"
      style={style}
      className={cn(
        'flex min-h-[92px] min-w-0 flex-col justify-center gap-1.5 rounded-xl border bg-card/90 px-3.5 py-2.5 shadow-xs backdrop-blur-sm',
        motion && 'jobs-summary-card',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
          <Settings2 className="size-3.5 text-brand" /> Preferences
        </span>
        <Link
          to="/app/preferences"
          className="rounded text-[11px] font-medium text-brand underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          Edit
        </Link>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
        {items.map((item) => (
          <div key={item.label} className="min-w-0">
            <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{item.label}</dt>
            <dd className="truncate text-xs font-semibold" title={item.value}>
              {item.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
