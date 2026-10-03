import { AlertTriangle, CheckCircle2, X, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { SpiderInfo, SyncResultNotice } from '@/types/scraper';
import { formatPostedWindowShort } from '@/utils/postedSyncWindow';

function platformLabel(name: string, spiders: SpiderInfo[]): string {
  const meta = spiders.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (meta?.label) return meta.label;
  if (!name || name === 'all') return 'all platforms';
  return name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatSources(platforms: string[], spiders: SpiderInfo[]): string {
  const unique = [...new Set(platforms.filter(Boolean))];
  if (unique.length === 0 || (unique.length === 1 && unique[0] === 'all')) return 'all platforms';
  const labels = unique.map((p) => platformLabel(p, spiders));
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  if (labels.length <= 4) return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
  return `${labels.slice(0, 3).join(', ')}, and ${labels.length - 3} more`;
}

export function syncHeadline(notice: SyncResultNotice, sources: string): string {
  const scraped = notice.itemsScraped;
  const word = scraped === 1 ? 'listing' : 'listings';
  const breakdown = [
    notice.itemsNew > 0 && `${notice.itemsNew.toLocaleString()} new`,
    notice.itemsUpdated > 0 && `${notice.itemsUpdated.toLocaleString()} updated`,
    notice.exactDuplicatesDropped > 0 && `${notice.exactDuplicatesDropped.toLocaleString()} exact-URL drops`,
  ]
    .filter(Boolean)
    .join(', ');
  const n = scraped.toLocaleString();
  if (notice.kind === 'error' && notice.error === 'stopped') {
    if (scraped <= 0) return 'Job sync was stopped before any listings were scraped';
    return `Job sync stopped after scraping ${n} ${word} from ${sources}${breakdown ? ` (${breakdown})` : ''}`;
  }
  if (notice.kind === 'error') {
    if (scraped <= 0) return `Job sync failed for ${sources}`;
    return `Job sync finished with errors, scraped ${n} ${word} from ${sources}${breakdown ? ` (${breakdown})` : ''}`;
  }
  if (scraped === 0) return `Sync finished, no listings scraped from ${sources}`;
  const suffix = notice.kind === 'warning' ? ' with some platform issues' : '';
  return `Scraped ${n} ${word} from ${sources}${breakdown ? ` · ${breakdown}` : ''}${suffix}`;
}

const KIND = {
  success: { Icon: CheckCircle2, tone: 'text-status-ready', bar: 'bg-status-ready' },
  warning: { Icon: AlertTriangle, tone: 'text-status-preparing', bar: 'bg-status-preparing' },
  error: { Icon: XCircle, tone: 'text-status-failed', bar: 'bg-status-failed' },
} as const;

export function SyncNoticeBanner({
  notice,
  spiders,
  onDismiss,
}: {
  notice: SyncResultNotice;
  spiders: SpiderInfo[];
  onDismiss: () => void;
}) {
  const { Icon, tone, bar } = KIND[notice.kind];
  const dropped = notice.exactDuplicatesDropped || notice.promotionLinkedExisting || 0;
  const windowLabel =
    notice.syncMode === 'date_backfill' && notice.postedSince
      ? `${formatPostedWindowShort(notice.postedSince)} → ${notice.postedUntil ? formatPostedWindowShort(notice.postedUntil) : 'today'}`
      : null;

  const details: string[] = [];
  if (notice.itemsNew > 0) details.push(`${notice.itemsNew.toLocaleString()} new in scrape DB`);
  if (notice.itemsUpdated > 0) details.push(`${notice.itemsUpdated.toLocaleString()} already known (kept existing JD)`);
  if (dropped > 0) details.push(`${dropped.toLocaleString()} dropped, exact source URL already saved`);
  if (notice.extractionEnqueued > 0) details.push(`${notice.extractionEnqueued.toLocaleString()} queued for JD extraction`);
  else if (notice.itemsScraped > 0 && notice.itemsNew === 0 && notice.itemsUpdated > 0 && dropped === 0) {
    details.push('No new extraction queue, updates reuse existing JD');
  }
  if (notice.promotionNew > 0) details.push(`${notice.promotionNew.toLocaleString()} new jobs saved`);
  if (notice.syncMode === 'incremental' && !windowLabel) details.push('Incremental sync');

  const platformRows = (notice.platformResults ?? []).filter((r) => r.itemsScraped > 0 || r.exactDuplicatesDropped > 0);
  const chip = 'inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground';

  return (
    <div role="status" aria-live="polite" className="relative flex items-start gap-3 overflow-hidden rounded-xl border bg-card py-3 pr-2 pl-4">
      <span aria-hidden className={cn('absolute inset-y-0 left-0 w-1', bar)} />
      <Icon className={cn('mt-0.5 size-4 shrink-0', tone)} />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-sm font-medium">{syncHeadline(notice, formatSources(notice.platforms, spiders))}</p>
        {notice.kind !== 'error' && notice.extractionEnqueued > 0 && (
          <p className="text-xs text-muted-foreground">
            Auto-extraction is running. Jobs move to JD ready when done, Extraction backlog is the live unfinished
            pool, not this sync&apos;s scrape total.
          </p>
        )}
        <div className="flex flex-wrap gap-1.5">
          {windowLabel && <span className={chip}>{windowLabel}</span>}
          {details.map((d) => (
            <span key={d} className={chip}>
              {d}
            </span>
          ))}
          {platformRows.map((row) => (
            <span key={row.spider} className={chip}>
              {platformLabel(row.spider, spiders)}: {row.itemsScraped.toLocaleString()} fetched
              {row.exactDuplicatesDropped > 0 ? ` · ${row.exactDuplicatesDropped.toLocaleString()} dropped` : ''}
            </span>
          ))}
          {notice.kind === 'error' && notice.error && notice.error !== 'stopped' && (
            <span className="text-xs text-destructive">{notice.message || notice.error}</span>
          )}
        </div>
      </div>
      <Button variant="ghost" size="icon-sm" aria-label="Dismiss sync notification" onClick={onDismiss}>
        <X />
      </Button>
    </div>
  );
}
