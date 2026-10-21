import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Check, Crown, LogOut, Mail, Package, Plus, UsersRound, X } from 'lucide-react';
import { fetchTeamOverview, leaveTeam, respondToTeamInvite } from '@/api/teamApi';
import { PageLayout, SectionCard } from '@/components/app/PageLayout';
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
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { TeamInvite, TeamMembership } from '@/types/team';
import { extractApiErrorMessage } from '@/utils/profileErrors';
import { STORE_KEY, TEAM_OVERVIEW_KEY } from '../plans/storeModel';
import { AllSpacesPanel, LeadSpacePanel } from './LeadSpacePanel';
import { ALL_SPACES, TeamSpaceTabs } from './TeamSpaceTabs';
import { TEAM_KEY } from './teamModel';
import { TeamIdBadge } from './TeamIdBadge';

export function TeamPage() {
  const query = useQuery({ queryKey: TEAM_OVERVIEW_KEY, queryFn: fetchTeamOverview });
  const [params, setParams] = useSearchParams();

  if (query.isPending) {
    return (
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 lg:p-8" aria-busy="true" aria-label="Loading team">
        <Skeleton className="h-32 w-full rounded-2xl" />
        <Skeleton className="h-72 w-full rounded-2xl" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <PageLayout title="Team" icon={UsersRound}>
        <p className="text-sm text-muted-foreground">
          Could not load your team.{' '}
          <button type="button" className="font-medium text-foreground underline" onClick={() => void query.refetch()}>
            Try again
          </button>
        </p>
      </PageLayout>
    );
  }

  const data = query.data;
  const owned = data.owned;
  const requested = params.get('space');
  const multi = owned.length > 1;
  const selectedId =
    owned.find((s) => s.id === requested)?.id ?? (multi ? ALL_SPACES : (owned[0]?.id ?? null));
  const memberships = data.memberships;
  const nothing = !owned.length && !memberships.length && !data.invites.length;
  const openSpace = (id: string) =>
    setParams(id === ALL_SPACES ? {} : { space: id }, { replace: true });

  return (
    <PageLayout
      title="Team"
      description="Team spaces bring a group search together. The lead invites members, sets how their jobs are shared, and follows their progress."
      variant="hero"
      icon={UsersRound}
    >
      <div className="space-y-6">
        {data.invites.length ? <Invitations invites={data.invites} /> : null}

        {data.team_packages_held ? <UnusedTeamPackages count={data.team_packages_held} /> : null}

        {owned.length ? (
          <section aria-label="Team spaces you lead" className="space-y-4">
            <TeamSpaceTabs
              spaces={owned}
              value={selectedId ?? ''}
              leading={multi ? ALL_SPACES : undefined}
              onChange={openSpace}
            />
            {selectedId === ALL_SPACES ? (
              <AllSpacesPanel spaces={owned} onOpenSpace={openSpace} />
            ) : selectedId ? (
              <LeadSpacePanel key={selectedId} spaceId={selectedId} />
            ) : null}
          </section>
        ) : null}

        {memberships.length ? (
          <section aria-label="Teams you are on" className="space-y-4">
            {memberships.length > 1 ? (
              <p className="text-sm text-muted-foreground">
                You are on {memberships.length} teams. Jobs shared with any of them show up on your Jobs page, filtered by
                your own preferences like everything else.
              </p>
            ) : null}
            {memberships.map((m) => (
              <MembershipCard key={m.id} membership={m} />
            ))}
          </section>
        ) : null}

        {nothing && !data.team_packages_held ? <EmptyTeam /> : null}
      </div>
    </PageLayout>
  );
}

function useRefreshTeam() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: TEAM_KEY });
    void queryClient.invalidateQueries({ queryKey: STORE_KEY });
  };
}

function Invitations({ invites }: { invites: TeamInvite[] }) {
  const refresh = useRefreshTeam();
  const respond = useMutation({
    mutationFn: ({ id, accept }: { id: string; accept: boolean }) => respondToTeamInvite(id, accept),
    onSuccess: (res) => {
      toast.success(res.status === 'accepted' ? 'Welcome to the team' : 'Invitation declined');
      refresh();
    },
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Could not answer the invitation.')),
  });
  return (
    <SectionCard
      title="Invitations"
      icon={Mail}
      description="Accept to join. You can be on several teams; each lead sees your job adds, applications, and interviews."
    >
      <ul className="divide-y">
        {invites.map((invite) => (
          <li key={invite.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{invite.space?.name ?? 'A team space'}</p>
              <p className="truncate text-xs text-muted-foreground">
                Led by {invite.space?.lead?.name ?? 'a NAO user'}
                {invite.space?.lead?.email ? ` (${invite.space.lead.email})` : ''}
                {invite.space?.public_id ? ` · ${invite.space.public_id}` : ''}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={respond.isPending}
                onClick={() => respond.mutate({ id: invite.id, accept: false })}
              >
                <X /> Decline
              </Button>
              <Button size="sm" disabled={respond.isPending} onClick={() => respond.mutate({ id: invite.id, accept: true })}>
                <Check /> Accept
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function UnusedTeamPackages({ count }: { count: number }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-chart-2/40 bg-chart-2/5 px-5 py-4">
      <div className="flex items-center gap-3">
        <span aria-hidden className="inline-flex size-10 items-center justify-center rounded-xl bg-chart-2/15 text-chart-2">
          <Package className="size-5" />
        </span>
        <div>
          <p className="text-sm font-semibold">
            {count === 1 ? 'You have an unused TEAM package' : `You have ${count} unused TEAM packages`}
          </p>
          <p className="text-xs text-muted-foreground">Create a team space from your store, or give the package to another lead.</p>
        </div>
      </div>
      <Link to="/app/plans" className={buttonVariants({ size: 'sm' })}>
        <Plus /> Create team space
      </Link>
    </div>
  );
}

function MembershipCard({ membership }: { membership: TeamMembership }) {
  const refresh = useRefreshTeam();
  const [confirm, setConfirm] = useState(false);
  const leave = useMutation({
    mutationFn: () => leaveTeam(membership.id),
    onSuccess: () => {
      toast.success(`You left ${membership.name}`);
      setConfirm(false);
      refresh();
    },
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Could not leave the team.')),
  });
  return (
    <SectionCard
      title="Member of"
      icon={UsersRound}
      actions={
        <Button
          variant="outline"
          size="sm"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          aria-label={`Leave ${membership.name}`}
          onClick={() => setConfirm(true)}
        >
          <LogOut /> Leave team
        </Button>
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-lg font-semibold">{membership.name}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <TeamIdBadge publicId={membership.public_id} />
            <span>
              {membership.member_count} member{membership.member_count === 1 ? '' : 's'}
            </span>
          </div>
        </div>
        {membership.lead ? (
          <div className="flex items-center gap-2 rounded-xl border bg-background/60 px-3 py-2 text-sm">
            <Crown className="size-4 text-chart-4" aria-hidden />
            <span>
              <span className="block font-medium">{membership.lead.name}</span>
              <span className="block text-xs text-muted-foreground">{membership.lead.email}</span>
            </span>
          </div>
        ) : null}
      </div>
      <ul className="mt-4 space-y-1.5 text-sm text-muted-foreground">
        <li>Your lead sees your job adds, applications, and interviews. Private interview notes stay private.</li>
        <li>
          {membership.share_locked
            ? 'Your lead set how the jobs you add are shared. You can see it under Preferences.'
            : 'You choose how the jobs you add are shared, under Preferences. "Team space" shares them with everyone on your teams.'}
        </li>
      </ul>

      <AlertDialog open={confirm} onOpenChange={(open) => !leave.isPending && setConfirm(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave {membership.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This lead stops seeing your activity, and jobs you shared with the team are no longer visible to its members.
              Your other teams are not affected. You need a new invitation to come back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={leave.isPending}>Stay</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={leave.isPending} onClick={() => leave.mutate()}>
              {leave.isPending ? 'Leaving…' : 'Leave team'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  );
}

function EmptyTeam() {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed bg-card/60 px-6 py-12 text-center">
      <span className="flex size-12 items-center justify-center rounded-2xl bg-chart-2/10 text-chart-2">
        <UsersRound className="size-6" aria-hidden />
      </span>
      <h2 className="mt-4 text-base font-semibold">You are not on a team</h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        Team leads use a TEAM package to open a team space, then invite members by email. When someone invites you, the
        invitation shows up here.
      </p>
      <Link to="/app/plans" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'mt-4')}>
        See the TEAM plan
      </Link>
    </div>
  );
}
