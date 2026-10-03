import { useNavigate } from 'react-router-dom';
import { ChevronsUpDown, LogOut, Moon, Puzzle, SlidersHorizontal, Sun, UserCircle } from 'lucide-react';
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
        {variant === 'applicant' ? (
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => navigate('/app/profile')}>
              <UserCircle />
              Profile
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate('/app/preferences')}>
              <SlidersHorizontal />
              Preferences
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate('/app/integrations')}>
              <Puzzle />
              Integrations
            </DropdownMenuItem>
          </DropdownMenuGroup>
        ) : null}
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
