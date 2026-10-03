import { useEffect, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  BarChart3,
  CalendarDays,
  CirclePlay,
  ClipboardCheck,
  Gauge,
  Layers,
  Loader2,
  Rocket,
  Sparkles,
  ThumbsUp,
  UserRound,
  Wifi,
} from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { PageScrollArea } from '../components/layout/PageScrollArea';
import { ScraperStatsBar } from '../components/scraper/ScraperStatsBar';
import { DualLineChart } from '../components/data-management/DualLineChart';
import { MultiLineChart } from '../components/data-management/MultiLineChart';
import { TrendSparkline } from '../components/scraper/TrendSparkline';
import { useScraperStore } from '../stores/scraperStore';
import {
  btnPrimary,
  btnSecondary,
  card,
  headingText,
  mutedText,
  pagePad,
} from '../ui/tokens';

function safe(n: number | null | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function fmt(n: number): string {
  return safe(n).toLocaleString();
}

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}

/**
 * Applicant Job Analysis — full pulse board, pipeline, match quality, and trends.
 * Click-throughs land on Jobs with the matching dashboard filters.
 */
export function JobAnalysisPage() {
  const navigate = useNavigate();
  const stats = useScraperStore((s) => s.stats);
  const statsLoading = useScraperStore((s) => s.statsLoading);
  const loadStats = useScraperStore((s) => s.loadStats);
  const applyAgentDashboard = useScraperStore((s) => s.applyAgentDashboard);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  const goJobs = (filters: Parameters<typeof applyAgentDashboard>[0]) => {
    applyAgentDashboard({ reset: true, ...filters });
    navigate('/app/jobs');
  };

  const trendRows = useMemo(() => {
    const labels = stats?.trends?.labels ?? [];
    const ready = stats?.trends?.ready ?? [];
    const remote = stats?.trends?.remote ?? [];
    const available = stats?.trends?.available ?? [];
    const best = stats?.trends?.best ?? [];
    return labels.map((day, i) => ({
      day,
      ready: ready[i] ?? 0,
      remote: remote[i] ?? 0,
      available: available[i] ?? 0,
      best: best[i] ?? 0,
    }));
  }, [stats]);

  const funnel = useMemo(() => {
    const total = safe(stats?.total_jobs);
    const available = safe(stats?.available_jobs);
    const ready = safe(stats?.ready_jobs);
    const applied = safe(stats?.applied_jobs);
    const max = Math.max(total, available, ready, applied, 1);
    return [
      { key: 'pool', label: 'Visible pool', value: total, color: 'bg-sky-500', width: pct(total, max), view: 'all' as const },
      {
        key: 'in_progress',
        label: 'In progress',
        value: available,
        color: 'bg-amber-500',
        width: pct(available, max),
        view: 'available' as const,
      },
      {
        key: 'ready',
        label: 'Ready to apply',
        value: ready,
        color: 'bg-emerald-500',
        width: pct(ready, max),
        view: 'ready' as const,
      },
      {
        key: 'applied',
        label: 'Applied',
        value: applied,
        color: 'bg-violet-500',
        width: pct(applied, max),
        view: 'applied' as const,
      },
    ];
  }, [stats]);

  const sources = (stats?.sources ?? []).slice(0, 8);
  const sourceMax = Math.max(...sources.map((s) => s.count), 1);

  const kpis = [
    {
      label: 'Good+ matches',
      value: safe(stats?.qualified_jobs ?? stats?.good_jobs),
      hint: `Avg score ${safe(stats?.avg_match_score)} · ${fmt(safe(stats?.scored_jobs))} scored`,
      icon: ThumbsUp,
      onClick: () => goJobs({ view: 'suggested', min_match_score: 0 }),
    },
    {
      label: 'Strong matches',
      value: safe(stats?.best_jobs),
      hint: 'Score ≥ 75',
      icon: Sparkles,
      onClick: () => goJobs({ view: 'suggested', min_match_score: 75 }),
    },
    {
      label: 'Remote open',
      value: safe(stats?.unapplied_remote_jobs ?? stats?.total_remote),
      hint: `${fmt(safe(stats?.total_remote))} remote in pool`,
      icon: Wifi,
      onClick: () => goJobs({ view: 'all', remote_only: true }),
    },
    {
      label: 'Posted by me',
      value: safe(stats?.my_jobs),
      hint: 'URL / attachment submissions',
      icon: UserRound,
      onClick: () => goJobs({ view: 'mine' }),
    },
  ];

  return (
    <PageScrollArea>
      <div className={pagePad}>
        <PageHeader
          icon={BarChart3}
          gradient="from-indigo-500 to-sky-600"
          title="Job Analysis"
          description="Your pipeline, match quality, and seven-day momentum — click any metric to open those jobs."
          actions={
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={btnSecondary}
                onClick={() => void loadStats({ silent: true })}
                disabled={statsLoading}
              >
                {statsLoading ? <Loader2 size={15} className="animate-spin" /> : null}
                Refresh
              </button>
              <Link to="/app/jobs" className={btnPrimary}>
                Open Jobs
                <ArrowRight size={15} />
              </Link>
            </div>
          }
        />

        {/* Today at a glance */}
        <section className={`${card} p-4 sm:p-5`}>
          <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
            <div>
              <p className={`text-[11px] font-bold uppercase tracking-[0.16em] ${mutedText}`}>
                Today
              </p>
              <h2 className={`text-lg font-bold ${headingText}`}>Intake pulse</h2>
            </div>
            <p className={`text-sm ${mutedText}`}>
              {fmt(safe(stats?.today_scraped))} new · {fmt(safe(stats?.today_remote))} remote ·{' '}
              {fmt(safe(stats?.applied_today))} applied
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {(
              [
                {
                  label: "Today's new",
                  value: safe(stats?.today_scraped),
                  icon: CalendarDays,
                  onClick: () => goJobs({ view: 'today' }),
                },
                {
                  label: 'Remote among them',
                  value: safe(stats?.today_remote),
                  icon: Wifi,
                  onClick: () => goJobs({ view: 'today', remote_only: true }),
                },
                {
                  label: 'Ready among them',
                  value: safe(stats?.today_ready_jobs),
                  icon: Rocket,
                  onClick: () => goJobs({ view: 'ready' }),
                },
                {
                  label: 'Applied today',
                  value: safe(stats?.applied_today),
                  icon: ClipboardCheck,
                  onClick: () => goJobs({ view: 'applied_today' }),
                },
              ] as const
            ).map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.label}
                  type="button"
                  onClick={item.onClick}
                  className="rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-3 text-left transition hover:border-sky-300 hover:bg-white dark:border-white/10 dark:bg-white/[0.03] dark:hover:border-sky-400/40 dark:hover:bg-white/[0.06]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className={`text-xs font-semibold ${mutedText}`}>{item.label}</p>
                    <Icon size={15} className="text-sky-600 dark:text-sky-300" />
                  </div>
                  <p className={`mt-1 text-2xl font-black tabular-nums ${headingText}`}>
                    {fmt(item.value)}
                  </p>
                </button>
              );
            })}
          </div>
        </section>

        {/* Full legacy board for deep exploration */}
        <section className="relative z-0 space-y-2">
          <div className="flex items-center justify-between gap-2 px-0.5">
            <h2 className={`text-sm font-bold ${headingText}`}>Live board</h2>
            <p className={`text-xs ${mutedText}`}>Same interactive board formerly on Jobs</p>
          </div>
          <ScraperStatsBar
            variant="applicant"
            stats={stats}
            loading={statsLoading}
            onSelectToday={() => goJobs({ view: 'today' })}
            onSelectReady={() => goJobs({ view: 'ready' })}
            onSelectBest={() => goJobs({ view: 'applied' })}
            onSelectGood={() => goJobs({ view: 'suggested' })}
            onSelectAvg={() => goJobs({ view: 'suggested' })}
            onSelectRemote={() => goJobs({ view: 'all', remote_only: true })}
            onSelectAvailable={() => goJobs({ view: 'available' })}
            onSelectApplied={() => goJobs({ view: 'applied' })}
            onSelectSheet={() => goJobs({ view: 'sheet_posted' })}
            onSelectPumble={() => goJobs({ view: 'pumble_posted' })}
            onSelectMine={() => goJobs({ view: 'mine' })}
            onSelectAll={() => goJobs({ view: 'all' })}
          />
        </section>

        {/* Pipeline + match KPIs */}
        <div className="grid gap-4 lg:grid-cols-2">
          <section className={`${card} p-4 sm:p-5`}>
            <div className="mb-4 flex items-center gap-2">
              <CirclePlay size={16} className="text-amber-500" />
              <h2 className={`text-sm font-bold ${headingText}`}>Apply pipeline</h2>
            </div>
            <ul className="space-y-3">
              {funnel.map((step) => (
                <li key={step.key}>
                  <button
                    type="button"
                    onClick={() => goJobs({ view: step.view })}
                    className="w-full text-left"
                  >
                    <div className="mb-1 flex items-center justify-between gap-2 text-sm">
                      <span className="font-semibold text-slate-800 dark:text-[var(--app-fg)]">
                        {step.label}
                      </span>
                      <span className="tabular-nums font-bold text-slate-900 dark:text-white">
                        {fmt(step.value)}
                      </span>
                    </div>
                    <div className="h-2.5 overflow-hidden rounded-full bg-slate-100 dark:bg-white/10">
                      <div
                        className={`h-full rounded-full ${step.color} transition-all duration-700`}
                        style={{ width: `${Math.max(step.width, step.value > 0 ? 4 : 0)}%` }}
                      />
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className={`${card} p-4 sm:p-5`}>
            <div className="mb-4 flex items-center gap-2">
              <Gauge size={16} className="text-indigo-500" />
              <h2 className={`text-sm font-bold ${headingText}`}>Match quality</h2>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {kpis.map((kpi) => {
                const Icon = kpi.icon;
                return (
                  <button
                    key={kpi.label}
                    type="button"
                    onClick={kpi.onClick}
                    className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3 text-left transition hover:border-sky-300 hover:bg-white dark:border-white/10 dark:bg-white/[0.03] dark:hover:border-sky-400/40"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className={`text-[11px] font-semibold uppercase tracking-wide ${mutedText}`}>
                        {kpi.label}
                      </p>
                      <Icon size={14} className="text-sky-600 dark:text-sky-300" />
                    </div>
                    <p className={`mt-1 text-xl font-black tabular-nums ${headingText}`}>
                      {fmt(kpi.value)}
                    </p>
                    <p className={`mt-0.5 text-[11px] leading-snug ${mutedText}`}>{kpi.hint}</p>
                  </button>
                );
              })}
            </div>
          </section>
        </div>

        {/* Trends */}
        <div className="grid gap-4 xl:grid-cols-2">
          <section className={`${card} p-4 sm:p-5`}>
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className={`text-sm font-bold ${headingText}`}>Ready vs in progress (7d)</h2>
              {stats?.trends?.ready ? (
                <TrendSparkline
                  values={stats.trends.ready}
                  labels={stats.trends.labels}
                  color="#10b981"
                />
              ) : null}
            </div>
            {trendRows.length > 0 ? (
              <DualLineChart
                data={trendRows}
                xKey="day"
                lineAKey="ready"
                lineBKey="available"
                lineAName="Ready"
                lineBName="In progress"
                lineAColor="#10b981"
                lineBColor="#f59e0b"
                height={240}
              />
            ) : (
              <p className={`py-10 text-center text-sm ${mutedText}`}>Trend data will appear as you use the pipeline.</p>
            )}
          </section>

          <section className={`${card} p-4 sm:p-5`}>
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className={`text-sm font-bold ${headingText}`}>Remote & strong matches (7d)</h2>
              {stats?.trends?.remote ? (
                <TrendSparkline
                  values={stats.trends.remote}
                  labels={stats.trends.labels}
                  color="#06b6d4"
                />
              ) : null}
            </div>
            {trendRows.length > 0 ? (
              <MultiLineChart
                data={trendRows}
                xKey="day"
                series={[
                  { key: 'remote', label: 'Remote', color: '#06b6d4' },
                  { key: 'best', label: 'Strong matches', color: '#8b5cf6' },
                ]}
                height={240}
              />
            ) : (
              <p className={`py-10 text-center text-sm ${mutedText}`}>Trend data will appear as matches land.</p>
            )}
          </section>
        </div>

        {/* Sources */}
        <section className={`${card} p-4 sm:p-5`}>
          <div className="mb-4 flex items-center gap-2">
            <Layers size={16} className="text-sky-500" />
            <h2 className={`text-sm font-bold ${headingText}`}>Where your jobs come from</h2>
          </div>
          {sources.length === 0 ? (
            <p className={`py-6 text-center text-sm ${mutedText}`}>
              Sources appear after jobs sync into your pool.
            </p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {sources.map((src) => (
                <li
                  key={src.source}
                  className="rounded-xl border border-slate-200 px-3 py-2.5 dark:border-white/10"
                >
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate font-semibold capitalize text-slate-800 dark:text-[var(--app-fg)]">
                      {src.source.replace(/_/g, ' ')}
                    </span>
                    <span className="tabular-nums font-bold text-slate-900 dark:text-white">
                      {fmt(src.count)}
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-white/10">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-sky-500 to-indigo-500"
                      style={{ width: `${pct(src.count, sourceMax)}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </PageScrollArea>
  );
}
