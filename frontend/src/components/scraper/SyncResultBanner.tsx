import { CheckCircle2, AlertTriangle, XCircle, X, CalendarRange, Layers, FileSearch, CopyX } from 'lucide-react';
import type { SpiderInfo, SyncResultNotice } from '../../types/scraper';

interface SyncResultBannerProps {
  notice: SyncResultNotice;
  spiders?: SpiderInfo[];
  onDismiss: () => void;
}

function formatShortDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function platformLabel(name: string, spiders: SpiderInfo[]): string {
  const meta = spiders.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (meta?.label) return meta.label;
  if (!name || name === 'all') return 'all platforms';
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatSources(platforms: string[], spiders: SpiderInfo[]): string {
  const unique = [...new Set(platforms.filter(Boolean))];
  if (unique.length === 0 || (unique.length === 1 && unique[0] === 'all')) {
    return 'all platforms';
  }
  const labels = unique.map((p) => platformLabel(p, spiders));
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  if (labels.length <= 4) {
    return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
  }
  return `${labels.slice(0, 3).join(', ')}, and ${labels.length - 3} more`;
}

function formatWindow(notice: SyncResultNotice): string | null {
  if (notice.syncMode === 'date_backfill' && notice.postedSince) {
    const since = formatShortDate(notice.postedSince);
    const until = notice.postedUntil ? formatShortDate(notice.postedUntil) : 'today';
    return `${since} → ${until}`;
  }
  return null;
}

/**
 * Dark-mode text must NOT use *-50 / *-100 accent tokens.
 * `style.css` remaps those CSS variables to dark background tints, so
 * `dark:text-emerald-50` (etc.) renders near-black and disappears on the banner.
 * Use 300+ steps (unremapped light hues) or inverted slate-600+ for light text.
 */
const KIND_STYLES = {
  success: {
    wrap: 'border-emerald-200/90 bg-gradient-to-r from-emerald-50 via-white to-teal-50/70 dark:border-emerald-500/35 dark:from-emerald-950/60 dark:via-slate-900 dark:to-teal-950/45',
    accent: 'bg-gradient-to-b from-emerald-500 to-teal-600',
    iconWrap: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/25 dark:text-emerald-300',
    Icon: CheckCircle2,
    chip: 'bg-emerald-600/10 text-emerald-800 dark:bg-emerald-500/25 dark:text-emerald-300',
    headline: 'text-emerald-950 dark:text-emerald-300',
    note: 'text-emerald-900/80 dark:text-emerald-200/80',
  },
  warning: {
    wrap: 'border-amber-200/90 bg-gradient-to-r from-amber-50 via-white to-orange-50/70 dark:border-amber-500/35 dark:from-amber-950/60 dark:via-slate-900 dark:to-orange-950/45',
    accent: 'bg-gradient-to-b from-amber-500 to-orange-600',
    iconWrap: 'bg-amber-100 text-amber-700 dark:bg-amber-500/25 dark:text-amber-300',
    Icon: AlertTriangle,
    chip: 'bg-amber-600/10 text-amber-800 dark:bg-amber-500/25 dark:text-amber-300',
    headline: 'text-amber-950 dark:text-amber-300',
    note: 'text-amber-900/80 dark:text-amber-200/80',
  },
  error: {
    wrap: 'border-rose-200/90 bg-gradient-to-r from-rose-50 via-white to-red-50/70 dark:border-rose-500/35 dark:from-rose-950/60 dark:via-slate-900 dark:to-red-950/45',
    accent: 'bg-gradient-to-b from-rose-500 to-red-600',
    iconWrap: 'bg-rose-100 text-rose-700 dark:bg-rose-500/25 dark:text-rose-300',
    Icon: XCircle,
    chip: 'bg-rose-600/10 text-rose-800 dark:bg-rose-500/25 dark:text-rose-300',
    headline: 'text-rose-950 dark:text-rose-300',
    note: 'text-rose-900/80 dark:text-rose-200/80',
  },
} as const;

function buildHeadline(notice: SyncResultNotice, sources: string): string {
  const scraped = notice.itemsScraped;
  const listingsWord = scraped === 1 ? 'listing' : 'listings';
  const newPart =
    notice.itemsNew > 0
      ? `${notice.itemsNew.toLocaleString()} new`
      : null;
  const updatedPart =
    notice.itemsUpdated > 0
      ? `${notice.itemsUpdated.toLocaleString()} updated`
      : null;
  const droppedPart =
    notice.exactDuplicatesDropped > 0
      ? `${notice.exactDuplicatesDropped.toLocaleString()} exact-URL drops`
      : null;
  const breakdown = [newPart, updatedPart, droppedPart].filter(Boolean).join(', ');

  if (notice.kind === 'error' && notice.error === 'stopped') {
    if (scraped <= 0) return 'Job sync was stopped before any listings were scraped';
    return breakdown
      ? `Job sync stopped after scraping ${scraped.toLocaleString()} ${listingsWord} from ${sources} (${breakdown})`
      : `Job sync stopped after scraping ${scraped.toLocaleString()} ${listingsWord} from ${sources}`;
  }
  if (notice.kind === 'error') {
    if (scraped <= 0) return `Job sync failed for ${sources}`;
    return breakdown
      ? `Job sync finished with errors — scraped ${scraped.toLocaleString()} ${listingsWord} from ${sources} (${breakdown})`
      : `Job sync finished with errors — scraped ${scraped.toLocaleString()} ${listingsWord} from ${sources}`;
  }
  if (scraped === 0) {
    return `Sync finished — no listings scraped from ${sources}`;
  }
  const prefix = 'Scraped';
  const suffix = notice.kind === 'warning' ? ' with some platform issues' : '';
  return breakdown
    ? `${prefix} ${scraped.toLocaleString()} ${listingsWord} from ${sources} · ${breakdown}${suffix}`
    : `${prefix} ${scraped.toLocaleString()} ${listingsWord} from ${sources}${suffix}`;
}

export function SyncResultBanner({ notice, spiders = [], onDismiss }: SyncResultBannerProps) {
  const style = KIND_STYLES[notice.kind];
  const Icon = style.Icon;
  const sources = formatSources(notice.platforms, spiders);
  const windowLabel = formatWindow(notice);
  const headline = buildHeadline(notice, sources);
  const dropped =
    notice.exactDuplicatesDropped || notice.promotionLinkedExisting || 0;

  const detailParts: string[] = [];
  if (notice.itemsNew > 0) detailParts.push(`${notice.itemsNew.toLocaleString()} new in scrape DB`);
  if (notice.itemsUpdated > 0) {
    detailParts.push(`${notice.itemsUpdated.toLocaleString()} already known (kept existing JD)`);
  }
  if (dropped > 0) {
    detailParts.push(
      `${dropped.toLocaleString()} dropped — exact source URL already saved`,
    );
  }
  if (notice.extractionEnqueued > 0) {
    detailParts.push(`${notice.extractionEnqueued.toLocaleString()} queued for JD extraction`);
  } else if (notice.itemsScraped > 0 && notice.itemsNew === 0 && notice.itemsUpdated > 0 && dropped === 0) {
    detailParts.push('No new extraction queue — updates reuse existing JD');
  }
  if (notice.syncMode === 'incremental' && !windowLabel) {
    detailParts.push('Incremental sync');
  }

  const showExtractNote =
    notice.kind !== 'error' &&
    notice.extractionEnqueued > 0;

  const platformRows = (notice.platformResults ?? []).filter(
    (row) => row.itemsScraped > 0 || row.exactDuplicatesDropped > 0,
  );

  return (
    <div
      role="status"
      aria-live="polite"
      className={`relative w-full overflow-hidden rounded-2xl border shadow-sm ${style.wrap}`}
    >
      <span aria-hidden className={`pointer-events-none absolute inset-y-0 left-0 w-1.5 ${style.accent}`} />
      <div className="flex items-start gap-3 px-4 py-3 sm:items-center sm:gap-4 sm:px-5">
        <div
          className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl sm:mt-0 ${style.iconWrap}`}
        >
          <Icon size={18} strokeWidth={2.25} />
        </div>

        <div className="min-w-0 flex-1">
          <p
            className={`text-sm font-semibold leading-snug tracking-tight sm:text-[15px] ${style.headline}`}
          >
            {headline}
          </p>
          {showExtractNote ? (
            <p className={`mt-1 text-[12px] font-medium leading-snug ${style.note}`}>
              Auto-extraction is running. Jobs move to <span className="font-semibold">JD ready</span> when
              done — <span className="font-semibold">Extraction backlog</span> is the live unfinished pool,
              not this sync&apos;s scrape total.
            </p>
          ) : null}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {windowLabel ? (
              <span
                className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold ${style.chip}`}
              >
                <CalendarRange size={11} className="shrink-0 opacity-90" />
                {windowLabel}
              </span>
            ) : null}
            {detailParts.length > 0 ? (
              <span
                className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold ${style.chip}`}
              >
                <Layers size={11} className="shrink-0 opacity-90" />
                {detailParts.join(' · ')}
              </span>
            ) : null}
            {dropped > 0 ? (
              <span
                className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold ${style.chip}`}
              >
                <CopyX size={11} className="shrink-0 opacity-90" />
                {dropped.toLocaleString()} exact URL duplicate
                {dropped === 1 ? '' : 's'} not saved
              </span>
            ) : null}
            {notice.extractionEnqueued > 0 ? (
              <span
                className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold ${style.chip}`}
              >
                <FileSearch size={11} className="shrink-0 opacity-90" />
                {notice.promotionNew > 0
                  ? `${notice.promotionNew.toLocaleString()} new jobs saved`
                  : null}
                {notice.promotionNew > 0 && dropped > 0 ? ' · ' : null}
                {dropped > 0 && notice.promotionNew === 0
                  ? `${dropped.toLocaleString()} skipped as duplicates`
                  : null}
                {notice.promotionNew === 0 && dropped === 0
                  ? 'Extraction queued'
                  : null}
              </span>
            ) : null}
            {platformRows.map((row) => (
              <span
                key={row.spider}
                className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold ${style.chip}`}
                title={`${platformLabel(row.spider, spiders)}: ${row.itemsScraped} fetched, ${row.exactDuplicatesDropped} exact-URL drops`}
              >
                {platformLabel(row.spider, spiders)}:{' '}
                {row.itemsScraped.toLocaleString()} fetched
                {row.exactDuplicatesDropped > 0
                  ? ` · ${row.exactDuplicatesDropped.toLocaleString()} dropped`
                  : ''}
              </span>
            ))}
            {notice.kind === 'error' && notice.error && notice.error !== 'stopped' ? (
              <span className="truncate text-[11px] font-medium text-rose-700 dark:text-rose-300">
                {notice.message || notice.error}
              </span>
            ) : null}
          </div>
        </div>

        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss sync notification"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-black/5 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/50 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-slate-100"
        >
          <X size={16} strokeWidth={2.25} />
        </button>
      </div>
    </div>
  );
}
