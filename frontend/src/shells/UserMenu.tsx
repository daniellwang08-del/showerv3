import { ChevronsUpDown, LogOut, Moon, Sun } from 'lucide-react';
import { LeadCrown } from '@/features/team/LeadCrown';
import { useIsTeamLead } from '@/features/team/useTeamOverview';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useProfilePhoto } from '@/hooks/useProfilePhoto';
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
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const displayName = user.name || user.email || 'Account';
  const initial = displayName.charAt(0).toUpperCase();
  const isLead = useIsTeamLead(variant === 'applicant');
  const photo = useProfilePhoto(variant === 'applicant');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'flex h-11 w-full items-center gap-2.5 rounded-lg px-1.5 text-left outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-sidebar-accent',
          collapsed && 'justify-center px-0',
        )}
        aria-label={isLead ? 'Account menu, team lead' : 'Account menu'}
      >
        <span className="relative shrink-0">
          <Avatar className={cn('size-8', isLead && 'ring-2 ring-amber-400/70 ring-offset-1 ring-offset-sidebar')}>
            {photo.data ? <AvatarImage src={photo.data} alt="" /> : null}
            <AvatarFallback className="bg-brand text-xs font-semibold text-brand-foreground">{initial}</AvatarFallback>
          </Avatar>
          {isLead ? <LeadCrown /> : null}
        </span>
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium">{displayName}</span>
                {isLead ? (
                  <span className="shrink-0 rounded-full bg-amber-400/15 px-1.5 py-px text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                    Lead
                  </span>
                ) : null}
              </span>
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
