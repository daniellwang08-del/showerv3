import { Link } from 'react-router-dom';
import { useJobSiteActivity } from '@/features/integrations/queries';
import { SyncProgress } from '@/features/integrations/SyncProgress';

/** Jobs header line bar for job-site syncs (fetching listings, then scoring the new jobs). */
export function JobSyncStatus() {
  const { data } = useJobSiteActivity();
  if (!data?.length) return null;
  return (
    <div className="flex basis-full items-end gap-3">
      <SyncProgress activity={data} className="min-w-0 flex-1" />
      <Link to="/app/integrations" className="shrink-0 text-xs text-muted-foreground hover:text-foreground hover:underline">
        Manage syncs
      </Link>
    </div>
  );
}
