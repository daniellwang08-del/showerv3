import { Link } from 'react-router-dom';
import {
  Activity,
  BarChart3,
  BriefcaseBusiness,
  CalendarClock,
  ClipboardCheck,
  Crown,
  type LucideIcon,
  MailPlus,
  Settings2,
  Trophy,
  UsersRound,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { TeamMemberRow } from '@/types/team';
import { relativeAgo } from '@/features/interviews/interviewsModel';
import { ALL_SPACES, MY_SEARCH, TeamSpaceTabs } from '@/features/team/TeamSpaceTabs';
import { ALL_TEAMS, ME, type InsightsSubject, type RosterSpace } from './insightsSubject';
import { MemberAvatar } from './MemberAvatar';

const fmt = new Intl.NumberFormat('en-US');

/** Team tabs plus a one-click member row: how a lead moves around Insights. */
export function LeadNavigator({
  spaces,
  subject,
  activeSpaceId,
  onChange,
}: {
  spaces: RosterSpace[];
  subject: InsightsSubject;
  /** The team being looked at, directly or through one of its members. */
  activeSpaceId: string | null;
  onChange: (next: InsightsSubject) => void;
}) {
  const tab = subject.kind === 'me' ? MY_SEARCH : subject.kind === 'teams' ? ALL_SPACES : (activeSpaceId ?? MY_SEARCH);
  const active = spaces.find((s) => s.space.id === activeSpaceId) ?? null;
  return (
    <div className="space-y-3">
      <TeamSpaceTabs
        label="Insights for"
        spaces={spaces.map((s) => s.space)}
        leading={spaces.length > 1 ? [MY_SEARCH, ALL_SPACES] : [MY_SEARCH]}
        value={tab}
        onChange={(id) =>
          onChange(id === MY_SEARCH ? ME : id === ALL_SPACES ? ALL_TEAMS : { kind: 'team', spaceId: id })
        }
      />
      {active && subject.kind !== 'me' && subject.kind !== 'teams' ? (
        <MemberChips
          spaceName={active.space.name}
          members={active.members}
          selected={subject.kind === 'member' ? subject.memberId : null}
          onWholeTeam={() => onChange({ kind: 'team', spaceId: active.space.id })}
          onMember={(id) => onChange({ kind: 'member', memberId: id })}
        />
      ) : null}
    </div>
  );
}

function MemberChips({
  spaceName,
  members,
  selected,
  onWholeTeam,
  onMember,
}: {
  spaceName: string;
  members: TeamMemberRow[];
  selected: string | null;
  onWholeTeam: () => void;
  onMember: (id: string) => void;
}) {
  const chip = (on: boolean) =>
    cn(
      'inline-flex shrink-0 items-center gap-2 rounded-full border py-1 pr-3 pl-1 text-sm transition-colors',
      on ? 'border-brand/50 bg-brand/10 text-foreground shadow-xs' : 'bg-card/80 text-muted-foreground hover:bg-muted/60 hover:text-foreground',
    );
  return (
    <div role="tablist" aria-label={`Members of ${spaceName}`} className="scrollbar-thin flex gap-2 overflow-x-auto pb-1">
      <button type="button" role="tab" aria-selected={selected === null} onClick={onWholeTeam} className={chip(selected === null)}>
        <span className="inline-flex size-6 items-center justify-center rounded-full bg-brand/12 text-brand" aria-hidden>
          <UsersRound className="size-3.5" />
        </span>
        Whole team
      </button>
      {members.map((m) => (
        <button
          key={m.id}
          type="button"
          role="tab"
          aria-selected={selected === m.id}
          onClick={() => onMember(m.id)}
          className={chip(selected === m.id)}
        >
          <MemberAvatar id={m.id} name={m.name} />
          <span className="max-w-40 truncate font-medium">{m.name}</span>
          <span className="text-xs tabular-nums opacity-70">{fmt.format(m.stats.applied)} applied</span>
        </button>
      ))}
      {members.length === 0 ? (
        <span className="self-center text-xs text-muted-foreground">No members yet</span>
      ) : null}
    </div>
  );
}

type Totals = { members: number; active: number; applied: number; jobsAdded: number; interviews: number; upcoming: number };

function totalsOf(members: TeamMemberRow[]): Totals {
  return members.reduce<Totals>(
    (t, m) => ({
      members: t.members + 1,
      active: t.active + (m.stats.applied + m.stats.jobs_added + m.stats.active_interviews > 0 ? 1 : 0),
      applied: t.applied + m.stats.applied,
      jobsAdded: t.jobsAdded + m.stats.jobs_added,
      interviews: t.interviews + m.stats.active_interviews,
      upcoming: t.upcoming + m.stats.upcoming_interviews,
    }),
    { members: 0, active: 0, applied: 0, jobsAdded: 0, interviews: 0, upcoming: 0 },
  );
}

/** Every team a lead runs side by side, with each member one click away. */
export function AllTeamsView({
  spaces,
  onOpenTeam,
  onOpenMember,
}: {
  spaces: RosterSpace[];
  onOpenTeam: (spaceId: string) => void;
  onOpenMember: (memberId: string) => void;
}) {
  const all = totalsOf(spaces.flatMap((s) => s.members));
  return (
    <div className="space-y-6">
      <section aria-label="All teams totals" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Kpi icon={Crown} tone="bg-amber-500/12 text-amber-600 dark:text-amber-300" label="Teams you lead" value={fmt.format(spaces.length)} />
        <Kpi icon={UsersRound} label="Active members" value={`${all.active} of ${all.members}`} hint="Any activity in 30 days" />
        <Kpi icon={ClipboardCheck} tone="bg-status-ready/15 text-status-ready" label="Applications" value={fmt.format(all.applied)} hint="Last 30 days" />
        <Kpi icon={BriefcaseBusiness} tone="bg-chart-4/12 text-chart-4" label="Jobs added" value={fmt.format(all.jobsAdded)} hint="Last 30 days" />
        <Kpi
          icon={CalendarClock}
          tone="bg-chart-2/12 text-chart-2"
          label="Active interviews"
          value={fmt.format(all.interviews)}
          hint={all.upcoming ? `${all.upcoming} scheduled ahead` : 'None scheduled ahead'}
        />
      </section>

      <section aria-label="Teams" className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {spaces.map(({ space, members }) => {
          const t = totalsOf(members);
          const top = [...members].sort((a, b) => b.stats.applied - a.stats.applied)[0];
          return (
            <article
              key={space.id}
              aria-label={space.name}
              className="jobs-summary-card flex min-w-0 flex-col rounded-2xl border bg-card/85 p-5 shadow-xs backdrop-blur-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="flex items-center gap-1.5 truncate text-base font-semibold">
                    <Crown className="size-4 shrink-0 text-amber-500" fill="currentColor" aria-hidden />
                    {space.name}
                  </h3>
                  <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{space.public_id}</p>
                </div>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground tabular-nums">
                  {t.active} of {t.members} active
                </span>
              </div>
              <dl className="mt-4 grid grid-cols-3 gap-2">
                <Mini label="Applied" value={t.applied} />
                <Mini label="Jobs added" value={t.jobsAdded} />
                <Mini label="Interviews" value={t.interviews} />
              </dl>
              {members.length ? (
                <div className="mt-4 flex items-center justify-between gap-2">
                  <div className="flex -space-x-1.5" aria-label={`${members.length} members`}>
                    {members.slice(0, 6).map((m) => (
                      <MemberAvatar key={m.id} id={m.id} name={m.name} className="size-7 ring-2 ring-card" />
                    ))}
                    {members.length > 6 ? (
                      <span className="inline-flex size-7 items-center justify-center rounded-full bg-muted text-[10px] font-semibold ring-2 ring-card">
                        +{members.length - 6}
                      </span>
                    ) : null}
                  </div>
                  {top && top.stats.applied > 0 ? (
                    <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                      <Trophy className="size-3.5 shrink-0 text-amber-500" aria-hidden />
                      <span className="truncate">
                        {top.name}, {top.stats.applied} applied
                      </span>
                    </span>
                  ) : null}
                </div>
              ) : (
                <p className="mt-4 text-xs text-muted-foreground">No members yet.</p>
              )}
              <div className="mt-4 flex flex-wrap gap-2 border-t pt-3">
                <Button size="sm" onClick={() => onOpenTeam(space.id)} aria-label={`Open ${space.name} insights`}>
                  <BarChart3 /> Team insights
                </Button>
                <Link
                  to={`/app/team?space=${encodeURIComponent(space.id)}`}
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  aria-label={`Manage ${space.name}`}
                >
                  {members.length ? <Settings2 /> : <MailPlus />}
                  {members.length ? 'Manage' : 'Invite members'}
                </Link>
              </div>
            </article>
          );
        })}
      </section>

      <section
        aria-label="Members across teams"
        className="jobs-summary-card min-w-0 rounded-2xl border bg-card/85 shadow-xs backdrop-blur-sm"
      >
        <div className="px-5 pt-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <Activity className="size-4 text-brand" aria-hidden />
            Members across your teams
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Last 30 days, grouped by team. Open anyone for their full insights.</p>
        </div>
        <div className="px-3 pt-3 pb-3 sm:px-5">
          <div className={cn('hidden gap-3 border-b px-2 pb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase lg:grid', ROW_GRID)}>
            <span>Member</span>
            <span className="text-right">Applied</span>
            <span className="text-right">Jobs added</span>
            <span className="text-right">Interviews</span>
            <span>Last active</span>
            <span className="sr-only">Actions</span>
          </div>
          {spaces.map(({ space, members }) => {
            const top = Math.max(1, ...members.map((m) => m.stats.applied));
            const sorted = [...members].sort((a, b) => b.stats.applied - a.stats.applied);
            return (
              <div key={space.id}>
                <div className="mt-3 flex items-center gap-2 rounded-lg bg-muted/50 px-2 py-1.5 first:mt-2">
                  <Crown className="size-3.5 shrink-0 text-amber-500" fill="currentColor" aria-hidden />
                  <h3 className="min-w-0 truncate text-sm font-semibold">{space.name}</h3>
                  <span className="text-xs text-muted-foreground">
                    {members.length} member{members.length === 1 ? '' : 's'}
                  </span>
                </div>
                {sorted.length ? (
                  <ul aria-label={`${space.name} members`} className="divide-y">
                    {sorted.map((m) => (
                      <li key={m.id} className={cn('grid grid-cols-2 items-center gap-x-3 gap-y-2 rounded-lg px-2 py-2.5 hover:bg-muted/30', ROW_GRID)}>
                        <div className="col-span-2 flex min-w-0 items-center gap-2.5 lg:col-span-1">
                          <MemberAvatar id={m.id} name={m.name} className="size-8 text-xs" />
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">{m.name}</span>
                            <span className="block truncate text-xs text-muted-foreground">{m.headline || m.email}</span>
                          </span>
                        </div>
                        <div className="min-w-0 text-left lg:text-right">
                          <span className="text-xs text-muted-foreground lg:hidden">Applied: </span>
                          <span className="text-sm font-semibold tabular-nums">{fmt.format(m.stats.applied)}</span>
                          <div className="mt-1 hidden h-1.5 overflow-hidden rounded-full bg-muted lg:block" aria-hidden>
                            <div className="ml-auto h-full rounded-full bg-status-ready" style={{ width: `${(m.stats.applied / top) * 100}%` }} />
                          </div>
                        </div>
                        <Num label="Jobs added" value={m.stats.jobs_added} />
                        <Num
                          label="Interviews"
                          value={m.stats.active_interviews}
                          hint={m.stats.upcoming_interviews ? `${m.stats.upcoming_interviews} upcoming` : undefined}
                        />
                        <span className="text-xs text-muted-foreground">
                          <span className="lg:hidden">Last active: </span>
                          {relativeAgo(m.stats.last_active_at) ?? 'No activity yet'}
                        </span>
                        <div className="col-span-2 flex justify-end gap-1 lg:col-span-1">
                          <Button variant="outline" size="xs" onClick={() => onOpenMember(m.id)} aria-label={`View ${m.name}'s insights`}>
                            <BarChart3 /> Insights
                          </Button>
                          <Link
                            to={`/app/team/${encodeURIComponent(space.id)}/members/${encodeURIComponent(m.id)}`}
                            className={buttonVariants({ variant: 'ghost', size: 'xs' })}
                            aria-label={`Open ${m.name}'s report`}
                          >
                            Report
                          </Link>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="px-2 py-3 text-sm text-muted-foreground">No members yet.</p>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

const ROW_GRID = 'lg:grid-cols-[minmax(0,2.4fr)_repeat(3,minmax(0,0.9fr))_minmax(0,1fr)_auto]';

function Kpi({
  icon: Icon,
  label,
  value,
  hint,
  tone = 'bg-brand/12 text-brand',
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className="jobs-summary-card min-w-0 rounded-2xl border bg-card/85 p-4 shadow-xs backdrop-blur-sm">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
        <span className={cn('inline-flex size-8 shrink-0 items-center justify-center rounded-lg', tone)} aria-hidden>
          <Icon className="size-4" />
        </span>
      </div>
      <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      {hint ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Mini({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-muted/50 px-3 py-2">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{fmt.format(value)}</dd>
    </div>
  );
}

function Num({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <span className="text-left lg:text-right">
      <span className="text-xs text-muted-foreground lg:hidden">{label}: </span>
      <span className="text-sm font-semibold tabular-nums">{fmt.format(value)}</span>
      {hint ? <span className="block text-[11px] text-muted-foreground">{hint}</span> : null}
    </span>
  );
}
