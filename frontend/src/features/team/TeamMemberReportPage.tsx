import { useQuery } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { Link, useParams } from 'react-router-dom';
import { UserX } from 'lucide-react';
import { fetchTeamMemberReport } from '@/api/teamApi';
import { buttonVariants } from '@/components/ui/button';
import { ReportLoading, SharedReportView } from '../sharing/SharedReportPage';
import { TEAM_KEY } from './teamModel';

/** A team lead's read-only view of one member's interviews and applications. */
export function TeamMemberReportPage() {
  const { spaceId = '', userId = '' } = useParams();
  const back = `/app/team?space=${encodeURIComponent(spaceId)}`;
  const query = useQuery({
    queryKey: [...TEAM_KEY, 'report', spaceId, userId],
    queryFn: () => fetchTeamMemberReport(spaceId, userId),
    retry: false,
    staleTime: 60_000,
  });
  if (query.isPending) return <ReportLoading />;
  if (query.isError) {
    const gone = isAxiosError(query.error) && query.error.response?.status === 404;
    return (
      <div className="flex flex-1 items-center justify-center px-4">
        <div className="max-w-sm text-center">
          <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
            <UserX className="size-5" aria-hidden />
          </span>
          <h1 className="mt-4 text-lg font-semibold">{gone ? 'This person is not on your team' : 'Could not load the report'}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {gone ? 'They left the team or were removed.' : 'Check your connection and try again.'}
          </p>
          <Link to={back} className={`${buttonVariants({ variant: 'outline', size: 'sm' })} mt-4`}>
            Back to the team
          </Link>
        </div>
      </div>
    );
  }
  const { team } = query.data;
  return (
    <SharedReportView
      data={query.data}
      back={{ to: back, label: team.name }}
      context={`Member of ${team.name} (${team.public_id}).`}
    />
  );
}
