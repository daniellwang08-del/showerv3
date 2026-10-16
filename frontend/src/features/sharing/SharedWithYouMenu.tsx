import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Users } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { fetchIncomingShares } from '@/api/reportShareApi';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { relativeAgo } from '../interviews/interviewsModel';
import { INCOMING_SHARES_KEY, initials, sharedReportPath } from './shareModel';

/** Reports other people shared with this account. Hidden when there are none. */
export function SharedWithYouMenu() {
  const navigate = useNavigate();
  const query = useQuery({ queryKey: INCOMING_SHARES_KEY, queryFn: fetchIncomingShares, staleTime: 60_000 });
  const shares = query.data?.shares ?? [];
  if (!shares.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" aria-label={`Shared with you, ${shares.length}`} />}>
        <Users />
        <span className="max-sm:hidden">Shared with you</span>
        <span className="rounded-full bg-brand/10 px-1.5 text-[11px] font-semibold text-brand tabular-nums">{shares.length}</span>
        <ChevronDown className="opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Reports shared with you</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {shares.map((s) => (
          <DropdownMenuItem key={s.id} onClick={() => navigate(sharedReportPath(s.id))}>
            <span
              aria-hidden
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-brand/10 text-[10px] font-semibold text-brand"
            >
              {initials(s.owner_name)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{s.owner_name}</span>
              <span className="block truncate text-[11px] text-muted-foreground">
                Shared {relativeAgo(s.shared_at) ?? 'recently'}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate('/app/shared')}>See all shared reports</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
