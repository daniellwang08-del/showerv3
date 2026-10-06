import { CheckCircle2, Clock3, Send, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DashboardView } from '@/api/scraperApi';
import { viewTone } from './viewTone';

interface Card {
  view: DashboardView;
  label: string;
  hint: string;
  value: number | undefined;
  icon: LucideIcon;
}

/** Headline counts above the jobs table; each card opens its view. */
export function JobsSummary({
  ready,
  upcoming,
  appliedToday,
  activeView,
  onView,
}: {
  ready: number | undefined;
  upcoming: number | undefined;
  appliedToday: number | undefined;
  activeView: DashboardView;
  onView: (view: DashboardView) => void;
}) {
  const cards: Card[] = [
    { view: 'ready', label: 'Ready to apply', hint: 'Scored with resume and cover letter', value: ready, icon: CheckCircle2 },
    { view: 'available', label: 'Upcoming', hint: 'Being read, scored and tailored', value: upcoming, icon: Clock3 },
    { view: 'applied_today', label: 'Applied today', hint: 'Applications sent since midnight', value: appliedToday, icon: Send },
  ];

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" aria-label="Job summary">
      {cards.map((card) => {
        const tone = viewTone(card.view);
        const active = activeView === card.view;
        return (
          <button
            key={card.view}
            type="button"
            aria-pressed={active}
            aria-label={`${card.label}: ${card.value == null ? 'loading' : card.value.toLocaleString()}`}
            onClick={() => onView(card.view)}
            className={cn(
              'group flex items-center gap-3 rounded-xl border bg-card px-3.5 py-3 text-left shadow-xs outline-none transition-all',
              'hover:-translate-y-px hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring/50',
              active && cn('ring-2', tone.ring),
            )}
          >
            <span className={cn('inline-flex size-10 shrink-0 items-center justify-center rounded-lg', tone.soft)}>
              <card.icon className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-2xl leading-tight font-semibold tabular-nums">
                {card.value == null ? <span className="text-muted-foreground/50">-</span> : card.value.toLocaleString()}
              </span>
              <span className="block truncate text-sm font-medium">{card.label}</span>
              <span className="block truncate text-xs text-muted-foreground">{card.hint}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
