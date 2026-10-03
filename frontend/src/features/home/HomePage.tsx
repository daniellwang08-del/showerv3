import { useRef } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  CalendarCheck,
  CheckCircle2,
  Circle,
  Loader2,
  Paperclip,
  Rocket,
  Sparkles,
  Target,
} from 'lucide-react';
import { toast } from 'sonner';
import { fetchUserProfile } from '@/api/profileApi';
import { fetchUserSettings } from '@/api/settingsApi';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Composer } from '@/features/assistant/Composer';
import { ASSISTANT_SUGGESTIONS, useAssistantDraft } from '@/features/assistant/useAssistantDraft';
import { useJobList, useJobStats } from '@/features/jobs/queries';
import { useOpenJob } from '@/features/jobs/useOpenJob';
import { isApplied } from '@/features/jobs/jobStatus';
import { shouldOnboard } from '@/features/onboarding/onboardingState';
import { MatchScore } from '@/components/app/MatchScore';
import { PageTitle } from '@/components/app/PageTitle';
import { cn } from '@/lib/utils';
import { useJobsStore } from '@/stores/jobsStore';
import { useScraperStore } from '@/stores/scraperStore';
import { useShellStore } from '@/stores/shellStore';
import type { DashboardView } from '@/api/scraperApi';
import {
  appliedWithin,
  buildChecklist,
  isBlankProfile,
  nextStep,
  type ChecklistId,
  type NextStep,
} from './homeState';

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

type Tile = {
  label: string;
  value: number | undefined;
  icon: typeof Rocket;
  view: DashboardView;
  live?: boolean;
};

export function HomePage({ firstName, userId }: { firstName?: string; userId?: string }) {
  const navigate = useNavigate();
  const openJob = useOpenJob();
  const setDocked = useShellStore((s) => s.setAssistantDocked);
  const fileRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const stats = useJobStats();
  const profile = useQuery({ queryKey: ['profile'], queryFn: fetchUserProfile });
  const settings = useQuery({ queryKey: ['settings'], queryFn: fetchUserSettings });
  const top = useJobList({ view: 'all', sort: 'match_score', order: 'desc', per_page: 12 });
  const applied = useJobList({ view: 'applied', sort: 'applied_at', order: 'desc', per_page: 100 });
  const { draft, setDraft, submit, busy } = useAssistantDraft({
    onAsk: () => setDocked(true),
  });

  const onboardingPending =
    profile.data !== undefined && isBlankProfile(profile.data) && shouldOnboard(userId, false);
  if (onboardingPending) return <Navigate to="/onboarding" replace />;

  const goToBoard = (view: DashboardView) => {
    useScraperStore.getState().applyAgentDashboard({ reset: true, view, remote_only: false, min_match_score: 0 });
    navigate('/app/jobs');
  };

  const focusComposer = () => {
    composerRef.current?.querySelector('textarea')?.focus();
    composerRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const id = toast.loading('Reading attachment…');
    await useJobsStore.getState().submitAttachmentFiles(Array.from(files));
    const { submitError, submitNotice } = useJobsStore.getState();
    if (submitError) toast.error(submitError, { id });
    else toast.success(submitNotice || 'Jobs submitted', { id });
    if (fileRef.current) fileRef.current.value = '';
  };

  const inputs = { profile: profile.data, settings: settings.data, stats: stats.data };
  const checklist = buildChecklist(inputs);
  const checklistReady = !profile.isPending && !settings.isPending && !stats.isPending;
  const checklistDone = checklist.filter((i) => i.done).length;
  const step = nextStep(inputs, onboardingPending);

  const runChecklist = (id: ChecklistId) => {
    if (id === 'profile') navigate('/app/profile');
    else if (id === 'preferences') navigate('/app/preferences');
    else if (id === 'jobs') focusComposer();
    else goToBoard('ready');
  };

  const s = stats.data;
  const appliedWeek = applied.data ? appliedWithin(applied.data.items, 7) : undefined;
  const tiles: Tile[] = [
    { label: 'New today', value: s?.today_scraped, icon: Rocket, view: 'today' },
    { label: 'Ready to apply', value: s?.ready_jobs, icon: Target, view: 'ready' },
    { label: 'In progress', value: s?.available_jobs, icon: Loader2, view: 'available', live: true },
    { label: 'Applied this week', value: appliedWeek, icon: CalendarCheck, view: 'applied' },
  ];

  const topJobs = (top.data?.items ?? [])
    .filter((j) => j.match_overall_score != null && !isApplied(j))
    .slice(0, 5);

  return (
    <div className="scrollbar-thin relative h-full overflow-y-auto">
      <PageTitle title="Home" />
      <div aria-hidden className="nao-horizon" />
      <div className="relative z-10 mx-auto flex min-h-full w-full max-w-3xl flex-col px-4 pt-[clamp(11rem,22vh,14rem)] pb-10">
        <h1 className="text-center text-3xl font-semibold tracking-tight sm:text-4xl">
          {greeting()}
          {firstName ? `, ${firstName}` : ''}
        </h1>
        <p className="mt-2 text-center text-muted-foreground">
          Ask about your search, or paste job links to analyze and tailor.
        </p>
        <NextStepButton
          step={step}
          onRun={(s) => {
            if (!s) return;
            if (s.kind === 'onboarding') navigate('/onboarding');
            else if (s.kind === 'profile') navigate('/app/profile');
            else if (s.kind === 'add-jobs') focusComposer();
            else if (s.kind === 'review-ready') goToBoard('ready');
            else goToBoard('available');
          }}
        />

        <div ref={composerRef} className="mt-6">
          <Composer
            size="lg"
            value={draft}
            onChange={setDraft}
            onSubmit={(t) => void submit(t)}
            busy={busy}
            autoFocus
            placeholder="Ask anything, or paste job URLs…"
            urlActionLabel={(n) => `Analyze ${n} job${n === 1 ? '' : 's'}`}
            tools={
              <>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  className="hidden"
                  accept=".docx,.xlsx,.txt,.text,.md,.markdown,.html,.htm"
                  onChange={(e) => void onFiles(e.target.files)}
                />
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="rounded-full text-muted-foreground"
                        aria-label="Attach a file with job links"
                        onClick={() => fileRef.current?.click()}
                      />
                    }
                  >
                    <Paperclip />
                  </TooltipTrigger>
                  <TooltipContent>Attach a file with job links</TooltipContent>
                </Tooltip>
              </>
            }
          />
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {ASSISTANT_SUGGESTIONS.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => void submit(q)}
                className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Sparkles className="size-3 text-brand" />
                {q}
              </button>
            ))}
          </div>
        </div>

        {checklistReady && checklistDone < checklist.length ? (
          <section className="mt-10 rounded-2xl border bg-card p-4" aria-label="Getting started">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-medium">Getting started</h2>
                <p className="text-xs text-muted-foreground">
                  {checklistDone} of {checklist.length} done
                </p>
              </div>
              <Progress value={(checklistDone / checklist.length) * 100} className="w-28" aria-label="Setup progress" />
            </div>
            <ul className="mt-3 grid gap-1 sm:grid-cols-2">
              {checklist.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    disabled={item.done}
                    onClick={() => runChecklist(item.id)}
                    className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors enabled:hover:bg-muted/60"
                  >
                    {item.done ? (
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-match-strong" />
                    ) : (
                      <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0">
                      <span className={cn('block text-sm', item.done && 'text-muted-foreground line-through')}>
                        {item.label}
                      </span>
                      <span className="block text-xs text-muted-foreground">{item.hint}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="mt-10" aria-label="Your search">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {tiles.map((t) => {
              const active = t.live && (t.value ?? 0) > 0;
              return (
                <button
                  key={t.label}
                  type="button"
                  onClick={() => goToBoard(t.view)}
                  className="group rounded-2xl border bg-card p-3.5 text-left transition-colors hover:bg-muted/60"
                >
                  <t.icon
                    className={cn(
                      'size-4 text-muted-foreground group-hover:text-brand',
                      active && 'animate-spin text-brand motion-reduce:animate-none',
                    )}
                  />
                  {t.value === undefined ? (
                    <Skeleton className="mt-3 h-7 w-12" />
                  ) : (
                    <p className="mt-2 text-2xl font-semibold tabular-nums">{t.value}</p>
                  )}
                  <p className="text-xs text-muted-foreground">{t.label}</p>
                </button>
              );
            })}
          </div>
        </section>

        <section className="mt-8" aria-label="Best matches">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-medium">Best matches waiting</h2>
            <Button variant="ghost" size="sm" onClick={() => goToBoard('all')}>
              All jobs
              <ArrowRight />
            </Button>
          </div>
          <div className="overflow-hidden rounded-2xl border bg-card">
            {top.isPending ? (
              Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0">
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-1/2" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                  <Skeleton className="h-6 w-9 rounded-full" />
                </div>
              ))
            ) : topJobs.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                No scored jobs yet. Paste a job link above to get a match analysis.
              </p>
            ) : (
              topJobs.map((job) => (
                <button
                  key={job.id}
                  type="button"
                  onClick={() => openJob(job)}
                  className="flex w-full items-center gap-3 border-b px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/50"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{job.title || 'Untitled role'}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {job.company}
                      {job.location ? ` · ${job.location}` : ''}
                      {job.is_remote ? ' · Remote' : ''}
                    </p>
                  </div>
                  <MatchScore score={job.match_overall_score} />
                </button>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function NextStepButton({ step, onRun }: { step: NextStep; onRun: (s: NextStep) => void }) {
  if (!step) return <div className="h-9" />;
  const label =
    step.kind === 'onboarding'
      ? 'Set up your profile in 2 minutes'
      : step.kind === 'profile'
        ? `Finish your profile · ${step.missing} field${step.missing === 1 ? '' : 's'} left`
        : step.kind === 'add-jobs'
          ? 'Add your first jobs'
          : step.kind === 'review-ready'
            ? `Review ${step.count} job${step.count === 1 ? '' : 's'} ready to apply`
            : `Review ${step.count} good match${step.count === 1 ? '' : 'es'}`;
  return (
    <div className="mt-4 flex justify-center">
      <button
        type="button"
        onClick={() => onRun(step)}
        className="group inline-flex h-9 items-center gap-2 rounded-full border bg-brand-soft/50 px-4 text-sm font-medium text-foreground transition-colors hover:bg-brand-soft"
      >
        <span className="size-1.5 rounded-full bg-brand" aria-hidden />
        <span className="text-muted-foreground">Next:</span>
        {label}
        <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
      </button>
    </div>
  );
}
