import { Crown } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Gold crown pinned to the top-right of an avatar for team leads. Place it inside
 * a `relative` wrapper around the avatar.
 */
export function LeadCrown({ className, label = 'Team lead' }: { className?: string; label?: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        'pointer-events-none absolute -top-1.5 -right-1.5 z-10 flex size-[18px] rotate-[18deg] items-center justify-center rounded-full',
        'bg-gradient-to-br from-amber-300 via-amber-400 to-amber-600 text-amber-950 shadow-sm ring-2 ring-sidebar',
        className,
      )}
    >
      <Crown className="size-2.5" strokeWidth={2.75} fill="currentColor" aria-hidden />
    </span>
  );
}
