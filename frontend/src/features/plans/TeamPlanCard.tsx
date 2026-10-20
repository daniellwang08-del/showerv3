import { Check, Eye, Fingerprint, Share2, UsersRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatUsd, TEAM_PLAN } from './plansModel';

const FEATURES = [
  { icon: Fingerprint, text: 'A private team space with its own ID, like nao-48203917' },
  { icon: UsersRound, text: 'Invite members by email, with no member limit' },
  { icon: Share2, text: "Set each member's job sharing and lock it" },
  { icon: Eye, text: "See each member's job adds, applications, and interviews" },
];

export function TeamPlanCard({ onBuy }: { onBuy: () => void }) {
  return (
    <article
      aria-label="TEAM package"
      className="relative grid gap-6 overflow-hidden rounded-2xl border bg-card/90 p-6 shadow-xs backdrop-blur-sm md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute -top-24 -right-24 size-64 rounded-full bg-gradient-to-br from-chart-2/25 to-transparent blur-2xl"
      />
      <div className="relative flex flex-col">
        <span className="inline-flex w-fit items-center gap-1 rounded-full bg-chart-2/15 px-2 py-0.5 text-[11px] font-semibold text-chart-2">
          <UsersRound className="size-3" aria-hidden />
          For team leads
        </span>
        <h3 className="mt-3 text-base font-semibold tracking-tight">{TEAM_PLAN.name}</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">{TEAM_PLAN.tagline}</p>
        <p className="mt-5 flex items-baseline gap-1.5">
          <span className="text-4xl font-semibold tracking-tight tabular-nums">{formatUsd(TEAM_PLAN.priceCents)}</span>
          <span className="text-sm font-medium text-muted-foreground">one time, per team space</span>
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Each package opens one team space and is used up when you create it. Members use their own credits.
        </p>
        <Button size="lg" variant="outline" className="mt-5 h-10 w-full rounded-xl font-semibold md:mt-auto" onClick={onBuy}>
          Buy TEAM
        </Button>
      </div>
      <ul className="relative grid content-center gap-3 text-sm sm:grid-cols-2 md:grid-cols-1">
        {FEATURES.map((f) => (
          <li key={f.text} className="flex gap-3 rounded-xl border border-border/60 bg-background/50 px-3.5 py-3">
            <span aria-hidden className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-chart-2/10 text-chart-2">
              <f.icon className="size-4" />
            </span>
            <span className="self-center">{f.text}</span>
          </li>
        ))}
        <li className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <Check className="size-3.5 text-status-ready" aria-hidden />
          Buy several to run several teams, or give one to another lead by email.
        </li>
      </ul>
    </article>
  );
}
