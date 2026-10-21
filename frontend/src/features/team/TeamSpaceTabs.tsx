import type { ReactNode } from 'react';
import { Crown, LayoutGrid, UserRound } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TeamSpaceSummary } from '@/types/team';

export const ALL_SPACES = 'all';
export const MY_SEARCH = 'me';

type Extra = typeof ALL_SPACES | typeof MY_SEARCH;

/**
 * Navigation tabs over the spaces a lead runs, each labelled with the team
 * name. ``leading`` adds a first tab: every team together, or the lead's own search.
 */
export function TeamSpaceTabs({
  spaces,
  value,
  onChange,
  leading,
  label = 'Your team spaces',
}: {
  spaces: TeamSpaceSummary[];
  value: string;
  onChange: (value: string) => void;
  leading?: Extra;
  label?: string;
}) {
  return (
    <nav aria-label={label} className="scrollbar-thin -mx-1 overflow-x-auto px-1">
      <div role="tablist" aria-label={label} className="flex min-w-max gap-1 border-b">
        {leading === ALL_SPACES ? (
          <Tab active={value === ALL_SPACES} onClick={() => onChange(ALL_SPACES)} icon={<LayoutGrid className="size-3.5" />}>
            All teams
            <Count n={spaces.reduce((sum, s) => sum + s.member_count, 0)} />
          </Tab>
        ) : leading === MY_SEARCH ? (
          <Tab active={value === MY_SEARCH} onClick={() => onChange(MY_SEARCH)} icon={<UserRound className="size-3.5" />}>
            You
          </Tab>
        ) : null}
        {spaces.map((s) => (
          <Tab
            key={s.id}
            active={value === s.id}
            onClick={() => onChange(s.id)}
            icon={<Crown className="size-3.5 text-amber-500" fill="currentColor" />}
          >
            <span className="max-w-48 truncate">{s.name}</span>
            <Count n={s.member_count} />
          </Tab>
        ))}
      </div>
    </nav>
  );
}

function Tab({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        '-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors',
        active
          ? 'border-brand text-foreground'
          : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground',
      )}
    >
      <span aria-hidden className="inline-flex">
        {icon}
      </span>
      {children}
    </button>
  );
}

function Count({ n }: { n: number }) {
  return (
    <span className="rounded-full bg-muted px-1.5 text-[11px] font-medium text-muted-foreground tabular-nums">{n}</span>
  );
}
