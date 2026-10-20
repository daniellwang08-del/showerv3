import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ChevronsUpDown, Coins, LogOut, Moon, Sun, UsersRound } from 'lucide-react';
import { fetchStore } from '@/api/storeApi';
import { fetchTeamOverview } from '@/api/teamApi';
import { STORE_KEY, TEAM_OVERVIEW_KEY } from '@/features/plans/storeModel';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useThemeStore } from '@/stores/themeStore';

export type ShellUser = { name?: string | null; email?: string | null };

const credits = new Intl.NumberFormat('en-US');

function ApplicantItems({ onNavigate }: { onNavigate: (to: string) => void }) {
  const store = useQuery({ queryKey: STORE_KEY, queryFn: fetchStore, staleTime: 5 * 60_000 });
  const team = useQuery({ queryKey: TEAM_OVERVIEW_KEY, queryFn: fetchTeamOverview, staleTime: 5 * 60_000 });
  const invites = team.data?.invites.length ?? 0;
  return (
    <DropdownMenuGroup>
      <DropdownMenuItem onClick={() => onNavigate('/app/plans')}>
        <Coins />
        Plans
        {store.data ? (
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">{credits.format(store.data.balance)} credits</span>
        ) : null}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => onNavigate('/app/team')}>
        <UsersRound />
        Team
        {invites ? (
          <span className="ml-auto rounded-full bg-brand px-1.5 text-[11px] font-semibold text-brand-foreground tabular-nums">
            {invites}
          </span>
        ) : null}
      </DropdownMenuItem>
    </DropdownMenuGroup>
  );
}

export function UserMenu({
  user,
  onLogout,
  collapsed,
  variant,
}: {
  user: ShellUser;
  onLogout: () => void;
  collapsed?: boolean;
  variant: 'applicant' | 'admin';
}) {
  const navigate = useNavigate();
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const displayName = user.name || user.email || 'Account';
  const initial = displayName.charAt(0).toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'flex h-11 w-full items-center gap-2.5 rounded-lg px-1.5 text-left outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-sidebar-accent',
          collapsed && 'justify-center px-0',
        )}
        aria-label="Account menu"
      >
        <Avatar className="size-8">
          <AvatarFallback className="bg-brand text-xs font-semibold text-brand-foreground">{initial}</AvatarFallback>
        </Avatar>
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{displayName}</span>
              {user.email && user.email !== displayName ? (
                <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
              ) : null}
            </span>
            <ChevronsUpDown className="size-4 text-muted-foreground" />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="truncate">{user.email || displayName}</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {variant === 'applicant' ? <ApplicantItems onNavigate={navigate} /> : null}
        <DropdownMenuItem onClick={toggleTheme} closeOnClick={false}>
          {theme === 'dark' ? <Sun /> : <Moon />}
          {theme === 'dark' ? 'Light mode' : 'Dark mode'}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onLogout}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
