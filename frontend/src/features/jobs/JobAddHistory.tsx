import { useEffect } from 'react';
import { Check } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useJobAddStore } from '@/stores/jobAddStore';
import { formatAddedAgo, jobAddCountLabel, shareScopeLabel } from './jobAddShare';
import { ShareWithUsersDialog } from './ShareWithUsersDialog';

export function JobAddHistory() {
  const batches = useJobAddStore((s) => s.batches);
  const load = useJobAddStore((s) => s.load);
  const loaded = useJobAddStore((s) => s.loaded);
  const share = useJobAddStore((s) => s.share);
  const openPicker = useJobAddStore((s) => s.openPicker);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  if (batches.length === 0) return <ShareWithUsersDialog />;

  return (
    <div className="mt-5">
      <p className="px-2.5 pb-1 text-xs font-medium text-muted-foreground">Added jobs</p>
      {batches.slice(0, 8).map((batch) => (
        <DropdownMenu key={batch.id}>
          <DropdownMenuTrigger
            className="flex w-full flex-col rounded-lg px-2.5 py-1.5 text-left hover:bg-sidebar-accent"
            title={`${jobAddCountLabel(batch.job_count)}, ${shareScopeLabel(batch.share_scope)}`}
          >
            <span className="truncate text-sm text-sidebar-foreground/90">
              {jobAddCountLabel(batch.job_count)}
            </span>
            <span className="truncate text-[11px] text-muted-foreground">
              {formatAddedAgo(batch.created_at)}
              {batch.created_at ? ' · ' : ''}
              {shareScopeLabel(batch.share_scope)}
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-52">
            <DropdownMenuItem onClick={() => void share(batch.id, 'private')}>
              Keep private
              {batch.share_scope === 'private' ? <Check className="ml-auto" /> : null}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void share(batch.id, 'team')}>
              Share with the team
              {batch.share_scope === 'team' ? <Check className="ml-auto" /> : null}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void share(batch.id, 'all')}>
              Share with everyone
              {batch.share_scope === 'all' ? <Check className="ml-auto" /> : null}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => openPicker(batch.id)}>
              Share with specific people
              {batch.share_scope === 'users' ? <Check className="ml-auto" /> : null}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ))}
      <ShareWithUsersDialog />
    </div>
  );
}
