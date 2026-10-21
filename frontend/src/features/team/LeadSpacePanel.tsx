import { useState, type FormEvent } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Activity,
  BarChart3,
  BriefcaseBusiness,
  CalendarClock,
  ClipboardCheck,
  Crown,
  Lock,
  LockOpen,
  MailPlus,
  Pencil,
  Settings2,
  Trash2,
  UserMinus,
  UsersRound,
  X,
} from 'lucide-react';
import {
  deleteTeamSpace,
  fetchTeamActivity,
  fetchTeamSpace,
  inviteToTeam,
  removeTeamMember,
  revokeTeamInvite,
  updateTeamMember,
  updateTeamSpace,
} from '@/api/teamApi';
import { HeroStat, SectionCard } from '@/components/app/PageLayout';
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
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { JobShareDefault } from '@/types/settings';
import type { TeamMemberRow, TeamSpaceDetail, TeamSpaceSummary } from '@/types/team';
import { extractApiErrorMessage } from '@/utils/profileErrors';
import { relativeAgo } from '../interviews/interviewsModel';
import { shortDate } from '../plans/storeModel';
import { memberInsightsPath } from '../insights/insightsSubject';
import { TeamIdBadge } from './TeamIdBadge';
import {
  activityTone,
  parseEmails,
  POLICY_NONE,
  SHARE_OPTIONS,
  TEAM_KEY,
  teamActivityKey,
  teamSpaceKey,
  teamTotals,
} from './teamModel';

const fmt = new Intl.NumberFormat('en-US');

export function LeadSpacePanel({ spaceId }: { spaceId: string }) {
  const query = useQuery({ queryKey: teamSpaceKey(spaceId), queryFn: () => fetchTeamSpace(spaceId) });
  if (query.isPending) return <Skeleton className="h-96 w-full rounded-2xl" aria-label="Loading team space" />;
  if (query.isError) {
    return (
      <p className="text-sm text-muted-foreground">
        Could not load this team space.{' '}
        <button type="button" className="font-medium text-foreground underline" onClick={() => void query.refetch()}>
          Try again
        </button>
      </p>
    );
  }
  return <SpaceView detail={query.data} />;
}

function useRefresh(spaceId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: teamSpaceKey(spaceId) });
    void queryClient.invalidateQueries({ queryKey: [...TEAM_KEY, 'overview'] });
  };
}

function SpaceView({ detail }: { detail: TeamSpaceDetail }) {
  const { space, members, invites, stats_days: days } = detail;
  const totals = teamTotals(members);
  return (
    <div className="space-y-4">
      <SpaceHeader space={space} />
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <HeroStat icon={UsersRound} label="Members" value={fmt.format(members.length)} />
        <HeroStat
          icon={BriefcaseBusiness}
          label={`Jobs added, ${days} days`}
          value={fmt.format(totals.jobsAdded)}
          tone="bg-chart-4/10 text-chart-4"
        />
        <HeroStat
          icon={ClipboardCheck}
          label={`Applied, ${days} days`}
          value={fmt.format(totals.applied)}
          tone="bg-status-ready/15 text-status-ready"
        />
        <HeroStat
          icon={CalendarClock}
          label="Active interviews"
          value={`${fmt.format(totals.activeInterviews)}${totals.upcoming ? ` (${totals.upcoming} upcoming)` : ''}`}
          tone="bg-chart-2/10 text-chart-2"
        />
      </div>
      <MembersCard groups={[{ space, members }]} days={days} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <TeamActivityCard spaceId={space.id} hasMembers={members.length > 0} />
        <div className="space-y-4">
          <InviteCard spaceId={space.id} invites={invites} />
          <PolicyCard space={space} />
        </div>
      </div>
    </div>
  );
}

function SpaceHeader({ space }: { space: TeamSpaceSummary }) {
  const refresh = useRefresh(space.id);
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const remove = useMutation({
    mutationFn: () => deleteTeamSpace(space.id),
    onSuccess: () => {
      toast.success(`${space.name} was closed`);
      setConfirmDelete(false);
      void queryClient.invalidateQueries({ queryKey: TEAM_KEY });
    },
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Could not close the team space.')),
  });
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border bg-card/90 px-5 py-4 shadow-xs">
      <div className="min-w-0">
        <p className="flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-300">
          <Crown className="size-3.5" fill="currentColor" aria-hidden />
          You lead
        </p>
        <h2 className="truncate text-lg font-semibold">{space.name}</h2>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <TeamIdBadge publicId={space.public_id} />
          {space.created_at ? <span>Created {shortDate(space.created_at)}</span> : null}
        </div>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => setRenaming(true)}>
          <Pencil /> Rename
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 /> Close space
        </Button>
      </div>
      <RenameDialog space={space} open={renaming} onClose={() => setRenaming(false)} onDone={refresh} />
      <AlertDialog open={confirmDelete} onOpenChange={(open) => !remove.isPending && setConfirmDelete(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close {space.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Every member is removed and open invitations are cancelled. The TEAM package used for this space does not come
              back. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
              {remove.isPending ? 'Closing…' : 'Close space'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function RenameDialog({
  space,
  open,
  onClose,
  onDone,
}: {
  space: TeamSpaceSummary;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(space.name);
  const save = useMutation({
    mutationFn: () => updateTeamSpace(space.id, { name: name.trim() }),
    onSuccess: () => {
      toast.success('Team renamed');
      onDone();
      onClose();
    },
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Could not rename the team.')),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && name.trim() !== space.name) save.mutate();
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !save.isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Rename team</DialogTitle>
            <DialogDescription>The team ID {space.public_id} stays the same.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="rename-team">Team name</Label>
            <Input id="rename-team" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={save.isPending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || name.trim() === space.name || save.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export type SpaceGroup = { space: TeamSpaceSummary; members: TeamMemberRow[] };

const MEMBER_GRID =
  'lg:grid-cols-[minmax(0,2.2fr)_repeat(3,minmax(0,0.8fr))_minmax(0,1fr)_minmax(0,1.9fr)_auto]';

/** One space's members, or several grouped under a heading per team. */
function MembersCard({
  groups,
  days,
  onOpenSpace,
}: {
  groups: SpaceGroup[];
  days: number;
  onOpenSpace?: (spaceId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState<{ space: TeamSpaceSummary; member: TeamMemberRow } | null>(null);
  const remove = useMutation({
    mutationFn: ({ space, member }: { space: TeamSpaceSummary; member: TeamMemberRow }) =>
      removeTeamMember(space.id, member.id),
    onSuccess: (_res, { space, member }) => {
      toast.success(`${member.name} was removed from ${space.name}`);
      setRemoving(null);
      void queryClient.invalidateQueries({ queryKey: teamSpaceKey(space.id) });
      void queryClient.invalidateQueries({ queryKey: [...TEAM_KEY, 'overview'] });
    },
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Could not remove the member.')),
  });
  const grouped = groups.length > 1;
  const total = groups.reduce((sum, g) => sum + g.members.length, 0);
  return (
    <SectionCard
      title="Members"
      icon={UsersRound}
      description={
        total
          ? `Activity over the last ${days} days${grouped ? ', grouped by team' : ''}. Sharing applies to jobs each member adds from now on.`
          : undefined
      }
    >
      {total || grouped ? (
        <>
          <div
            className={cn(
              'hidden gap-3 border-b px-2 pb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase lg:grid',
              MEMBER_GRID,
            )}
          >
            <span>Member</span>
            <span className="text-right">Jobs added</span>
            <span className="text-right">Applied</span>
            <span className="text-right">Interviews</span>
            <span>Last active</span>
            <span>Job sharing</span>
            <span className="sr-only">Actions</span>
          </div>
          {groups.map(({ space, members }) => (
            <section key={space.id} aria-label={grouped ? `${space.name} members` : undefined}>
              {grouped ? (
                <GroupHeading space={space} count={members.length} onOpen={onOpenSpace ? () => onOpenSpace(space.id) : undefined} />
              ) : null}
              {members.length ? (
                <ul aria-label={grouped ? `${space.name} members` : 'Team members'} className="divide-y">
                  {members.map((m) => (
                    <MemberRow key={m.id} spaceId={space.id} member={m} onRemove={() => setRemoving({ space, member: m })} />
                  ))}
                </ul>
              ) : (
                <p className="px-2 py-3 text-sm text-muted-foreground">No members yet.</p>
              )}
            </section>
          ))}
        </>
      ) : (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No members yet. Invite people by email; they show up here once they accept.
        </p>
      )}

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && !remove.isPending && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {removing?.member.name}
              {grouped && removing ? ` from ${removing.space.name}` : ''}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              They leave the team, you stop seeing their activity, and any sharing lock you set is released. They need a new
              invitation to come back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => removing && remove.mutate(removing)}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  );
}

function GroupHeading({ space, count, onOpen }: { space: TeamSpaceSummary; count: number; onOpen?: () => void }) {
  return (
    <div className="mt-3 flex items-center gap-2 rounded-lg bg-muted/50 px-2 py-1.5 first:mt-2">
      <Crown className="size-3.5 shrink-0 text-amber-500" fill="currentColor" aria-hidden />
      <h3 className="min-w-0 truncate text-sm font-semibold">{space.name}</h3>
      <span className="font-mono text-[11px] text-muted-foreground">{space.public_id}</span>
      <span className="text-xs text-muted-foreground">
        {count} member{count === 1 ? '' : 's'}
      </span>
      {onOpen ? (
        <Button variant="ghost" size="xs" className="ml-auto" onClick={onOpen}>
          Open team
        </Button>
      ) : null}
    </div>
  );
}

/** Every space a lead runs on one screen: members and activity grouped by team. */
export function AllSpacesPanel({
  spaces,
  onOpenSpace,
}: {
  spaces: TeamSpaceSummary[];
  onOpenSpace: (spaceId: string) => void;
}) {
  const details = useQueries({
    queries: spaces.map((space) => ({ queryKey: teamSpaceKey(space.id), queryFn: () => fetchTeamSpace(space.id) })),
  });
  if (details.some((d) => d.isPending)) {
    return <Skeleton className="h-96 w-full rounded-2xl" aria-label="Loading team spaces" />;
  }
  const failed = details.filter((d) => d.isError);
  if (failed.length) {
    return (
      <p className="text-sm text-muted-foreground">
        Could not load every team space.{' '}
        <button
          type="button"
          className="font-medium text-foreground underline"
          onClick={() => failed.forEach((d) => void d.refetch())}
        >
          Try again
        </button>
      </p>
    );
  }
  const loaded = details.map((d) => d.data).filter((d): d is TeamSpaceDetail => !!d);
  const groups: SpaceGroup[] = loaded.map((d) => ({ space: d.space, members: d.members }));
  const totals = teamTotals(groups.flatMap((g) => g.members));
  const days = loaded[0]?.stats_days ?? 30;
  const memberCount = groups.reduce((sum, g) => sum + g.members.length, 0);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <HeroStat icon={UsersRound} label={`Members in ${groups.length} teams`} value={fmt.format(memberCount)} />
        <HeroStat
          icon={BriefcaseBusiness}
          label={`Jobs added, ${days} days`}
          value={fmt.format(totals.jobsAdded)}
          tone="bg-chart-4/10 text-chart-4"
        />
        <HeroStat
          icon={ClipboardCheck}
          label={`Applied, ${days} days`}
          value={fmt.format(totals.applied)}
          tone="bg-status-ready/15 text-status-ready"
        />
        <HeroStat
          icon={CalendarClock}
          label="Active interviews"
          value={`${fmt.format(totals.activeInterviews)}${totals.upcoming ? ` (${totals.upcoming} upcoming)` : ''}`}
          tone="bg-chart-2/10 text-chart-2"
        />
      </div>
      <MembersCard groups={groups} days={days} onOpenSpace={onOpenSpace} />
      <GroupedActivityCard groups={groups} />
    </div>
  );
}

function MemberRow({ spaceId, member, onRemove }: { spaceId: string; member: TeamMemberRow; onRemove: () => void }) {
  const refresh = useRefresh(spaceId);
  const save = useMutation({
    mutationFn: (changes: { share_default?: JobShareDefault; share_locked?: boolean }) =>
      updateTeamMember(spaceId, member.id, changes),
    onSuccess: () => {
      toast.success(`Sharing updated for ${member.name}`);
      refresh();
    },
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Could not update sharing.')),
  });
  const { stats } = member;
  const lockId = `lock-${member.id}`;
  return (
    <li className="grid grid-cols-2 items-center gap-x-3 gap-y-2 px-2 py-3 lg:grid-cols-[minmax(0,2.2fr)_repeat(3,minmax(0,0.8fr))_minmax(0,1fr)_minmax(0,1.9fr)_auto]">
      <div className="col-span-2 min-w-0 lg:col-span-1">
        <p className="truncate text-sm font-medium">{member.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {member.email}
          {member.headline ? ` · ${member.headline}` : ''}
        </p>
      </div>
      <Stat label="Jobs added" value={stats.jobs_added} />
      <Stat label="Applied" value={stats.applied} />
      <Stat
        label="Interviews"
        value={stats.active_interviews}
        hint={stats.upcoming_interviews ? `${stats.upcoming_interviews} upcoming` : undefined}
      />
      <span className="text-xs text-muted-foreground" title={stats.last_active_at ? shortDate(stats.last_active_at) : undefined}>
        <span className="lg:hidden">Last active: </span>
        {relativeAgo(stats.last_active_at) ?? 'No activity yet'}
      </span>
      <div className="col-span-2 flex items-center gap-2 lg:col-span-1">
        <Select
          items={SHARE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          value={member.share_default}
          disabled={save.isPending}
          onValueChange={(v) => v != null && v !== member.share_default && save.mutate({ share_default: v as JobShareDefault })}
        >
          <SelectTrigger aria-label={`Job sharing for ${member.name}`} className="h-8 min-w-0 flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {SHARE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{o.label}</span>
                  <span className="text-xs text-muted-foreground">{o.description}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="flex shrink-0 items-center gap-1.5">
          <Switch
            id={lockId}
            checked={member.share_locked}
            disabled={save.isPending}
            onCheckedChange={(next) => save.mutate({ share_locked: next })}
          />
          <label htmlFor={lockId} className="flex cursor-pointer items-center text-xs text-muted-foreground">
            {member.share_locked ? <Lock className="size-3.5" aria-hidden /> : <LockOpen className="size-3.5" aria-hidden />}
            <span className="sr-only">Lock sharing for {member.name}</span>
          </label>
        </span>
      </div>
      <div className="col-span-2 flex justify-end gap-1 lg:col-span-1">
        <Link
          to={memberInsightsPath(member.id)}
          className={buttonVariants({ variant: 'outline', size: 'xs' })}
          aria-label={`Open ${member.name}'s insights`}
        >
          <Activity /> Insights
        </Link>
        <Link
          to={`/app/team/${encodeURIComponent(spaceId)}/members/${encodeURIComponent(member.id)}`}
          className={buttonVariants({ variant: 'outline', size: 'xs' })}
          aria-label={`Open ${member.name}'s report`}
        >
          <BarChart3 /> Report
        </Link>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Remove ${member.name}`}
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={onRemove}
        >
          <UserMinus />
        </Button>
      </div>
    </li>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <span className="text-left lg:text-right">
      <span className="text-xs text-muted-foreground lg:hidden">{label}: </span>
      <span className="text-sm font-semibold tabular-nums">{fmt.format(value)}</span>
      {hint ? <span className="block text-[11px] text-muted-foreground">{hint}</span> : null}
    </span>
  );
}

function InviteCard({ spaceId, invites }: { spaceId: string; invites: TeamSpaceDetail['invites'] }) {
  const refresh = useRefresh(spaceId);
  const [raw, setRaw] = useState('');
  const emails = parseEmails(raw);
  const send = useMutation({
    mutationFn: () => inviteToTeam(spaceId, emails),
    onSuccess: (res) => {
      if (res.invites.length) {
        toast.success(`Invited ${res.invites.length} ${res.invites.length === 1 ? 'person' : 'people'}`);
      }
      for (const s of res.skipped) toast.message(`${s.email}: ${s.reason}`);
      const elsewhere = res.invites.filter((i) => i.in_other_team).map((i) => i.email);
      if (elsewhere.length) toast.message(`On another team right now: ${elsewhere.join(', ')}. They must leave it to join.`);
      setRaw('');
      refresh();
    },
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Could not send the invitations.')),
  });
  const revoke = useMutation({
    mutationFn: (inviteId: string) => revokeTeamInvite(spaceId, inviteId),
    onSuccess: () => refresh(),
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Could not cancel the invitation.')),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (emails.length) send.mutate();
  };
  return (
    <SectionCard title="Invite members" icon={MailPlus} description="They accept from their Team page. Emails without an account can sign up first.">
      <form onSubmit={submit} className="space-y-2">
        <Label htmlFor="invite-emails" className="sr-only">
          Emails to invite
        </Label>
        <Textarea
          id="invite-emails"
          rows={2}
          placeholder="name@company.com, another@company.com"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">Up to 10 at a time.</span>
          <Button type="submit" size="sm" disabled={!emails.length || emails.length > 10 || send.isPending}>
            {send.isPending ? 'Inviting…' : emails.length > 1 ? `Invite ${emails.length}` : 'Invite'}
          </Button>
        </div>
      </form>
      {invites.length ? (
        <div className="mt-4">
          <p className="text-xs font-medium text-muted-foreground">Waiting for an answer ({invites.length})</p>
          <ul className="mt-1 divide-y">
            {invites.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                <span className="min-w-0">
                  <span className="block truncate">{i.email}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {i.has_account ? 'Has an account' : 'No account yet'}
                    {i.created_at ? ` · sent ${relativeAgo(i.created_at) ?? ''}` : ''}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Cancel the invitation to ${i.email}`}
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(i.id)}
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </SectionCard>
  );
}

function PolicyCard({ space }: { space: TeamSpaceSummary }) {
  const refresh = useRefresh(space.id);
  const save = useMutation({
    mutationFn: (changes: { default_share_scope?: JobShareDefault | ''; default_share_locked?: boolean }) =>
      updateTeamSpace(space.id, changes),
    onSuccess: () => {
      toast.success('New member sharing saved');
      refresh();
    },
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Could not save.')),
  });
  const items = [
    { value: POLICY_NONE, label: "Keep the member's choice" },
    ...SHARE_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
  ];
  const current = space.default_share_scope ?? POLICY_NONE;
  return (
    <SectionCard
      title="Sharing for new members"
      icon={Settings2}
      description="Applied when someone joins. Change any member later from the members list."
    >
      <div className="space-y-3">
        <Select
          items={items}
          value={current}
          disabled={save.isPending}
          onValueChange={(v) => {
            if (v == null || v === current) return;
            save.mutate({ default_share_scope: v === POLICY_NONE ? '' : (v as JobShareDefault) });
          }}
        >
          <SelectTrigger aria-label="Sharing for new members" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {items.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={`policy-lock-${space.id}`} className={cn('text-sm', !space.default_share_scope && 'text-muted-foreground')}>
            Lock it so members cannot change it
          </label>
          <Switch
            id={`policy-lock-${space.id}`}
            checked={space.default_share_locked}
            disabled={save.isPending || !space.default_share_scope}
            onCheckedChange={(next) => save.mutate({ default_share_locked: next })}
          />
        </div>
      </div>
    </SectionCard>
  );
}

function useTeamActivity(spaceId: string, hasMembers: boolean) {
  return useQuery({
    queryKey: teamActivityKey(spaceId),
    queryFn: () => fetchTeamActivity(spaceId),
    enabled: hasMembers,
    staleTime: 60_000,
  });
}

export function TeamActivityCard({ spaceId, hasMembers }: { spaceId: string; hasMembers: boolean }) {
  const query = useTeamActivity(spaceId, hasMembers);
  return (
    <SectionCard
      title="Team activity"
      icon={Activity}
      description={query.data ? `Job adds, applications, and interview steps from the last ${query.data.days} days.` : undefined}
    >
      <ActivityList spaceId={spaceId} hasMembers={hasMembers} />
    </SectionCard>
  );
}

function GroupedActivityCard({ groups }: { groups: SpaceGroup[] }) {
  return (
    <SectionCard
      title="Team activity"
      icon={Activity}
      description="Job adds, applications, and interview steps, grouped by team."
    >
      <div className="grid gap-4 xl:grid-cols-2">
        {groups.map(({ space, members }) => (
          <section key={space.id} aria-label={`${space.name} activity`} className="min-w-0 rounded-xl border bg-background/40 p-2">
            <div className="flex items-center gap-2 px-2 pt-1 pb-2">
              <Crown className="size-3.5 shrink-0 text-amber-500" fill="currentColor" aria-hidden />
              <h3 className="min-w-0 truncate text-sm font-semibold">{space.name}</h3>
              <span className="text-xs text-muted-foreground">
                {members.length} member{members.length === 1 ? '' : 's'}
              </span>
            </div>
            <ActivityList spaceId={space.id} hasMembers={members.length > 0} label={`${space.name} activity`} />
          </section>
        ))}
      </div>
    </SectionCard>
  );
}

function ActivityList({ spaceId, hasMembers, label = 'Team activity' }: { spaceId: string; hasMembers: boolean; label?: string }) {
  const query = useTeamActivity(spaceId, hasMembers);
  return (
    <>
      {!hasMembers ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Activity appears here once members join.</p>
      ) : query.isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : query.isError ? (
        <p className="text-sm text-muted-foreground">Could not load activity.</p>
      ) : query.data.items.length ? (
        <ul aria-label={label} className="max-h-[28rem] space-y-1 overflow-y-auto pr-1">
          {query.data.items.map((item) => (
            <li key={item.id} className="flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-muted/40">
              <span className={cn('mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-lg', activityTone(item))}>
                {item.kind === 'applied' ? (
                  <ClipboardCheck className="size-3.5" aria-hidden />
                ) : item.kind === 'interview' ? (
                  <CalendarClock className="size-3.5" aria-hidden />
                ) : (
                  <BriefcaseBusiness className="size-3.5" aria-hidden />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">
                  <span className="font-medium">{item.member?.name ?? 'A member'}</span>{' '}
                  <span className="text-muted-foreground">{item.title.charAt(0).toLowerCase() + item.title.slice(1)}</span>
                </span>
                {item.detail ? <span className="block truncate text-xs text-muted-foreground">{item.detail}</span> : null}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{relativeAgo(item.at) ?? '-'}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-6 text-center text-sm text-muted-foreground">Nothing in this window yet.</p>
      )}
    </>
  );
}
