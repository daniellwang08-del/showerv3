import { Coins, Hourglass, PackageCheck, PackageOpen, UsersRound, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { AdminPackageStatus, AdminStoreOverview, PackageCode } from '@/types/store';
import { CODE_TONE, fmt, packageSummary, STATUS_META, usd } from './packagesModel';

export function PackagesOverview({
  overview,
  loading,
  error,
  onRetry,
  status,
  code,
  onStatus,
  onCode,
}: {
  overview: AdminStoreOverview | undefined;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  status: AdminPackageStatus | null;
  code: PackageCode | null;
  onStatus: (s: AdminPackageStatus | null) => void;
  onCode: (c: PackageCode | null) => void;
}) {
  if (!overview) {
    if (error && !loading) {
      return (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3 text-sm">
          <span className="text-destructive">Could not load package totals.</span>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      );
    }
    return (
      <div aria-busy="true" aria-label="Loading package totals" className="space-y-3">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
          <Skeleton className="h-40 rounded-2xl" />
          <div className="grid grid-cols-2 gap-3">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-[4.6rem] rounded-xl" />
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  const t = overview.totals;
  const toggleStatus = (s: AdminPackageStatus) => onStatus(status === s ? null : s);
  const granted14 = overview.grant_trend.reduce((a, d) => a + d.count, 0);

  return (
    <section aria-label="Package totals" className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <button
          type="button"
          aria-pressed={status === 'held'}
          onClick={() => toggleStatus('held')}
          className={tile(
            status === 'held',
            'relative flex flex-col gap-3 overflow-hidden rounded-2xl p-4',
          )}
        >
          <span
            aria-hidden
            className="pointer-events-none absolute -top-16 -right-16 size-44 rounded-full bg-gradient-to-br from-brand/20 to-transparent blur-2xl"
          />
          <span className="relative flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <PackageOpen className="size-3.5" /> Unused packages
          </span>
          <span className="relative flex items-baseline gap-2">
            <span className="text-4xl font-semibold tracking-tight tabular-nums">{fmt(t.held)}</span>
            <span className="text-xs text-muted-foreground">
              held by {fmt(overview.holders)} {overview.holders === 1 ? 'person' : 'people'}
            </span>
          </span>
          <GrantBars trend={overview.grant_trend} />
          <span className="relative flex justify-between gap-2 text-xs text-muted-foreground">
            <span>{fmt(granted14)} granted in 14 days</span>
            <span className="tabular-nums">{usd(overview.granted_value_cents)} granted value</span>
          </span>
        </button>

        <div className="grid grid-cols-2 gap-3">
          <Stat
            icon={Hourglass}
            label={STATUS_META.waiting.label}
            value={fmt(t.waiting)}
            hint={STATUS_META.waiting.hint}
            active={status === 'waiting'}
            onClick={() => toggleStatus('waiting')}
            valueClass={t.waiting ? 'text-status-preparing' : undefined}
          />
          <Stat
            icon={PackageCheck}
            label={STATUS_META.redeemed.label}
            value={fmt(t.redeemed)}
            hint={t.revoked ? `${fmt(t.revoked)} revoked` : STATUS_META.redeemed.hint}
            active={status === 'redeemed'}
            onClick={() => toggleStatus('redeemed')}
          />
          <Stat
            icon={Coins}
            label="Credits in balances"
            value={fmt(overview.credit_balance_total)}
            hint={`${fmt(overview.users_with_credits)} users · ${fmt(overview.unused_credits)} more in unused packs`}
          />
          <Stat
            icon={UsersRound}
            label="Team spaces"
            value={fmt(overview.team_spaces)}
            hint={`${fmt((overview.by_code.team?.held ?? 0) + (overview.by_code.team?.waiting ?? 0))} TEAM packages unused`}
          />
        </div>
      </div>

      <div role="group" aria-label="Packages by type" className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {overview.catalog.map((c) => {
          const counts = overview.by_code[c.code] ?? { held: 0, waiting: 0, redeemed: 0, revoked: 0 };
          const live = counts.held + counts.waiting + counts.redeemed;
          const tone = CODE_TONE[c.code];
          const active = code === c.code;
          return (
            <button
              key={c.code}
              type="button"
              aria-pressed={active}
              onClick={() => onCode(active ? null : c.code)}
              className={tile(active, 'flex flex-col gap-2 rounded-xl px-3 py-2.5')}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
                  <span aria-hidden className={cn('size-2 shrink-0 rounded-full', tone.swatch)} />
                  <span className="truncate">{c.name}</span>
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">{usd(c.price_cents)}</span>
              </span>
              <span className="text-xs text-muted-foreground">{packageSummary(c)}</span>
              <span
                className="flex h-1.5 overflow-hidden rounded-full bg-muted"
                role="img"
                aria-label={`${c.name}: ${counts.held} unused, ${counts.waiting} awaiting signup, ${counts.redeemed} used`}
              >
                {live > 0 && (
                  <>
                    <span className={STATUS_META.held.dot} style={{ width: `${(counts.held / live) * 100}%` }} />
                    <span className={STATUS_META.waiting.dot} style={{ width: `${(counts.waiting / live) * 100}%` }} />
                    <span className={STATUS_META.redeemed.dot} style={{ width: `${(counts.redeemed / live) * 100}%` }} />
                  </>
                )}
              </span>
              <span className="flex gap-3 text-[11px] text-muted-foreground tabular-nums">
                <span>
                  <b className="font-semibold text-foreground">{fmt(counts.held + counts.waiting)}</b> unused
                </span>
                <span>
                  <b className="font-semibold text-foreground">{fmt(counts.redeemed)}</b> used
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function GrantBars({ trend }: { trend: AdminStoreOverview['grant_trend'] }) {
  const max = Math.max(1, ...trend.map((d) => d.count));
  return (
    <span
      role="img"
      aria-label={`Packages granted per day: ${trend.map((d) => `${d.date} ${d.count}`).join(', ')}`}
      className="relative flex h-10 items-end gap-[3px]"
    >
      {trend.map((d) => (
        <span
          key={d.date}
          title={`${d.date}: ${d.count} granted`}
          className={cn('flex-1 rounded-sm', d.count ? 'bg-brand/70' : 'bg-muted')}
          style={{ height: `${Math.max(8, (d.count / max) * 100)}%` }}
        />
      ))}
    </span>
  );
}

function tile(active: boolean, extra: string) {
  return cn(
    'min-w-0 border bg-card text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
    'enabled:hover:bg-muted/40',
    active && 'border-brand/50 bg-brand-soft/40 shadow-[inset_0_0_0_1px_var(--brand)]',
    extra,
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
  active = false,
  onClick,
  valueClass,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint: string;
  active?: boolean;
  onClick?: () => void;
  valueClass?: string;
}) {
  const body = (
    <>
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </span>
      <span className={cn('text-xl font-semibold tracking-tight tabular-nums', valueClass)}>{value}</span>
      <span className="truncate text-xs text-muted-foreground" title={hint}>
        {hint}
      </span>
    </>
  );
  const cls = tile(active, 'flex flex-col gap-1 rounded-xl px-3 py-2.5');
  return onClick ? (
    <button type="button" aria-pressed={active} onClick={onClick} className={cls}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}
