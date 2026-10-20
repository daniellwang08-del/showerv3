import { useQuery } from '@tanstack/react-query';
import { fetchTeamOverview } from '@/api/teamApi';
import { TEAM_OVERVIEW_KEY } from '@/features/plans/storeModel';

/** The signed-in applicant's spaces, membership and invites. Admins have no team. */
export function useTeamOverview(enabled = true) {
  return useQuery({ queryKey: TEAM_OVERVIEW_KEY, queryFn: fetchTeamOverview, staleTime: 5 * 60_000, enabled });
}

/** True once the overview shows the user leads at least one team space. */
export function useIsTeamLead(enabled = true): boolean {
  const overview = useTeamOverview(enabled);
  return (overview.data?.owned.length ?? 0) > 0;
}
