import { CheckCircle2, Gauge, Send, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DashboardView } from '@/api/scraperApi';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
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
  scored,
  appliedToday,
  activeView,
  onView,
}: {
  ready: number | undefined;
  scored: number | undefined;
  appliedToday: number | undefined;
  activeView: DashboardView;
  onView: (view: DashboardView) => void;
}) {
  const reduceMotion = usePrefersReducedMotion();
  const cards: Card[] = [
    { view: 'ready', label: 'Ready to apply', hint: 'Scored with resume and cover letter', value: ready, icon: CheckCircle2 },
    { view: 'available', label: 'Scored', hint: 'Match scored, not ready to apply yet', value: scored, icon: Gauge },
    { view: 'applied_today', label: 'Applied today', hint: 'Applications sent since midnight', value: appliedToday, icon: Send },
  ];

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" aria-label="Job summary">
      {cards.map((card, index) => {
        const tone = viewTone(card.view);
        const active = activeView === card.view;
        return (
          <button
            key={card.view}
            type="button"
            aria-pressed={active}
            aria-label={`${card.label}: ${card.value == null ? 'loading' : card.value.toLocaleString()}`}
            onClick={() => onView(card.view)}
            style={reduceMotion ? undefined : { animationDelay: `${80 + index * 70}ms` }}
            className={cn(
              'group flex items-center gap-3 rounded-xl border bg-card/90 px-3.5 py-3 text-left shadow-xs outline-none backdrop-blur-sm transition-all',
              'hover:-translate-y-0.5 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring/50',
              active && cn('ring-2', tone.ring),
              !reduceMotion && 'jobs-summary-card',
            )}
          >
            <span
              className={cn(
                'inline-flex size-10 shrink-0 items-center justify-center rounded-lg transition-transform duration-300',
                'group-hover:scale-105',
                tone.soft,
              )}
            >
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
