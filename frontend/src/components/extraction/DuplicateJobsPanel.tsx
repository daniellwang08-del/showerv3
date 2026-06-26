import type { ReactNode } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeftRight,
  Search,
  Trash2,
  MoreHorizontal,
  X,
  ClipboardCheck,
  Loader2,
  ChevronDown,
  Square,
  CheckSquare,
  RotateCcw,
  FileText,
  Copy,
  Globe,
  TrendingDown,
  FileWarning,
  ExternalLink,
  Layers,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { SubmittedUrlItem } from '../../types/ui';
import type { ExclusionType } from '../../types/index';
import { useJobsStore } from '../../stores/jobsStore';
import { useModalStore } from '../../stores/modalStore';
import { useUIStore } from '../../stores/uiStore';
import { Z_INDEX } from '../../constants/zIndex';

// ── Exclusion-type badge helpers ──────────────────────────────────────────────

const EXCLUSION_TYPE_LABELS: Record<NonNullable<ExclusionType>, string> = {
  applied_company: 'Applied',
  lower_score: 'Lower score',
  superseded_by_higher: 'Superseded',
  no_score_comparison: 'Auto-excluded',
  below_min_score: 'Low match',
  strict_similarity: 'Same title',
  same_url: 'Same URL',
  extraction_failed: 'Extraction failed',
  non_us_location: 'Non-US',
  location_unknown: 'Location review',
  blocked_domain: 'Blocked domain',
  manual_invalid: 'Hidden',
  manual_duplicate: 'Manual dup',
};

const EXCLUSION_TYPE_COLORS: Record<NonNullable<ExclusionType>, string> = {
  applied_company: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  lower_score: 'bg-amber-100 text-amber-800 border-amber-200',
  superseded_by_higher: 'bg-purple-100 text-purple-800 border-purple-200',
  no_score_comparison: 'bg-slate-100 text-slate-600 border-slate-200',
  below_min_score: 'bg-rose-100 text-rose-800 border-rose-200',
  strict_similarity: 'bg-blue-100 text-blue-800 border-blue-200',
  same_url: 'bg-cyan-100 text-cyan-800 border-cyan-200',
  extraction_failed: 'bg-slate-200 text-slate-800 border-slate-300',
  non_us_location: 'bg-orange-100 text-orange-800 border-orange-200',
  location_unknown: 'bg-amber-100 text-amber-900 border-amber-200',
  blocked_domain: 'bg-zinc-200 text-zinc-800 border-zinc-300',
  manual_invalid: 'bg-rose-100 text-rose-800 border-rose-200',
  manual_duplicate: 'bg-orange-100 text-orange-800 border-orange-200',
};

function ExclusionBadge({ type }: { type: ExclusionType }) {
  if (!type) {
    return (
      <span className="inline-flex items-center rounded-full border border-blue-200 bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700">
        Content
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${EXCLUSION_TYPE_COLORS[type]}`}
    >
      {EXCLUSION_TYPE_LABELS[type]}
    </span>
  );
}

type DupTabId = 'duplicates' | 'non_us' | 'low_score' | 'extraction_failed';
type AccentKey = 'blue' | 'orange' | 'rose' | 'slate';

const DUP_TABS: { id: DupTabId; label: string; icon: LucideIcon; accent: AccentKey; noun: string; emptyHint: string }[] = [
  {
    id: 'duplicates',
    label: 'Duplicates',
    icon: Copy,
    accent: 'blue',
    noun: 'duplicates',
    emptyHint: 'Potential duplicate jobs and jobs needing location review appear here after AI analysis.',
  },
  {
    id: 'non_us',
    label: 'Non-US',
    icon: Globe,
    accent: 'orange',
    noun: 'non-US jobs',
    emptyHint: 'Jobs outside the United States are moved here after AI analysis.',
  },
  {
    id: 'low_score',
    label: 'Low match',
    icon: TrendingDown,
    accent: 'rose',
    noun: 'low-match jobs',
    emptyHint: 'Jobs below your minimum match score will appear here after AI analysis.',
  },
  {
    id: 'extraction_failed',
    label: 'Extraction failed',
    icon: FileWarning,
    accent: 'slate',
    noun: 'extraction failures',
    emptyHint: 'Expired or invalid postings that failed extraction appear here.',
  },
];

const TAB_ACCENT: Record<AccentKey, { active: string; icon: string; badgeActive: string; badgeIdle: string }> = {
  blue: {
    active: 'border-blue-300 bg-blue-50 text-blue-700 shadow-sm',
    icon: 'text-blue-600',
    badgeActive: 'bg-blue-600 text-white',
    badgeIdle: 'bg-slate-100 text-slate-500',
  },
  orange: {
    active: 'border-orange-300 bg-orange-50 text-orange-700 shadow-sm',
    icon: 'text-orange-600',
    badgeActive: 'bg-orange-600 text-white',
    badgeIdle: 'bg-slate-100 text-slate-500',
  },
  rose: {
    active: 'border-rose-300 bg-rose-50 text-rose-700 shadow-sm',
    icon: 'text-rose-600',
    badgeActive: 'bg-rose-600 text-white',
    badgeIdle: 'bg-slate-100 text-slate-500',
  },
  slate: {
    active: 'border-slate-300 bg-slate-100 text-slate-800 shadow-sm',
    icon: 'text-slate-600',
    badgeActive: 'bg-slate-700 text-white',
    badgeIdle: 'bg-slate-100 text-slate-500',
  },
};

const MENU_WIDTH = 224;
const MENU_EST_HEIGHT = 200;

type Props = {
  onClosePanel: () => void;
  children: ReactNode;
};

function clampDupContextMenu(clientX: number, clientY: number) {
  const pad = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = clientX;
  let top = clientY;
  if (left + MENU_WIDTH + pad > vw) left = vw - MENU_WIDTH - pad;
  if (top + MENU_EST_HEIGHT + pad > vh) top = vh - MENU_EST_HEIGHT - pad;
  if (left < pad) left = pad;
  if (top < pad) top = pad;
  return { left, top };
}

function DuplicateActionsMenuPortal({
  openMenuId,
  items,
  overridePosition,
  onCloseMenu,
  onCompare,
  onReplace,
  onReportAsValid,
  onDelete,
  onRestore,
}: {
  openMenuId: string | null;
  items: SubmittedUrlItem[];
  overridePosition: { left: number; top: number } | null;
  onCloseMenu: () => void;
  onCompare: (item: SubmittedUrlItem) => void;
  onReplace: (item: SubmittedUrlItem) => void;
  onReportAsValid: (item: SubmittedUrlItem) => void;
  onDelete: (item: SubmittedUrlItem) => void;
  onRestore: (item: SubmittedUrlItem) => void;
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!openMenuId) {
      setPos(null);
      return;
    }

    if (overridePosition) {
      setPos({ top: overridePosition.top, left: overridePosition.left });
      return;
    }

    const update = () => {
      const el = document.querySelector<HTMLElement>(`[data-dup-menu-anchor="${CSS.escape(openMenuId)}"]`);
      if (!el) {
        setPos(null);
        return;
      }
      const rect = el.getBoundingClientRect();
      let left = rect.right - MENU_WIDTH;
      left = Math.max(8, Math.min(left, window.innerWidth - MENU_WIDTH - 8));
      let top = rect.bottom + 4;
      if (top + MENU_EST_HEIGHT > window.innerHeight - 8) {
        top = Math.max(8, rect.top - MENU_EST_HEIGHT - 4);
      }
      setPos({ top, left });
    };

    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [openMenuId, overridePosition]);

  const item = items.find((i) => i.id === openMenuId);
  if (!openMenuId || !pos || !item) return null;

  return createPortal(
    <div
      className="glass-card fixed w-56 overflow-hidden rounded-xl border border-blue-200/70 bg-white/95 shadow-xl backdrop-blur-sm"
      style={{ top: pos.top, left: pos.left, zIndex: Z_INDEX.duplicateContextMenu }}
      data-job-menu-root="true"
      role="menu"
    >
      <button
        type="button"
        className="block w-full border-b border-slate-100 px-3 py-2 text-left text-sm text-slate-700 hover:bg-blue-50"
        onClick={() => {
          onCloseMenu();
          onCompare(item);
        }}
      >
        <span className="inline-flex items-center gap-2">
          <Search className="h-4 w-4" />
          Compare
        </span>
      </button>
      <button
        type="button"
        className="block w-full border-b border-slate-100 px-3 py-2 text-left text-sm text-slate-700 hover:bg-blue-50"
        onClick={() => {
          onCloseMenu();
          onReplace(item);
        }}
      >
        <span className="inline-flex items-center gap-2">
          <ArrowLeftRight className="h-4 w-4" />
          Replace
        </span>
      </button>
      <button
        type="button"
        className="block w-full border-b border-slate-100 px-3 py-2 text-left text-sm text-indigo-700 hover:bg-indigo-50"
        onClick={() => {
          onCloseMenu();
          onRestore(item);
        }}
      >
        <span className="inline-flex items-center gap-2">
          <RotateCcw className="h-4 w-4 text-indigo-600" />
          Restore to active pool
        </span>
      </button>
      <button
        type="button"
        className="block w-full border-b border-slate-100 px-3 py-2 text-left text-sm text-slate-700 hover:bg-emerald-50"
        onClick={() => {
          onCloseMenu();
          onReportAsValid(item);
        }}
      >
        <span className="inline-flex items-center gap-2">
          <ClipboardCheck className="h-4 w-4 text-emerald-600" />
          Report as valid job
        </span>
      </button>
      <button
        type="button"
        className="block w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
        onClick={() => {
          onCloseMenu();
          onDelete(item);
        }}
      >
        <span className="inline-flex items-center gap-2">
          <Trash2 className="h-4 w-4" />
          Dismiss
        </span>
      </button>
    </div>,
    document.body,
  );
}

export function DuplicateJobsPanel({
  onClosePanel,
  children,
}: Props) {
  const [activeTab, setActiveTab] = useState<'duplicates' | 'non_us' | 'low_score' | 'extraction_failed'>('duplicates');

  const loadingLists = useJobsStore((s) => s.loadingLists);
  const duplicateItems = useJobsStore((s) => s.duplicateUrls);
  const nonUsItems = useJobsStore((s) => s.nonUsUrls);
  const lowScoreItems = useJobsStore((s) => s.lowScoreUrls);
  const extractionFailedItems = useJobsStore((s) => s.extractionFailedUrls);
  const invalidCounts = useJobsStore((s) => s.invalidCounts);
  const duplicateListHasMore = useJobsStore((s) => s.invalidHasMore);
  const lowScoreListHasMore = useJobsStore((s) => s.lowScoreHasMore);
  const extractionFailedListHasMore = useJobsStore((s) => s.extractionFailedHasMore);
  const loadingMoreDuplicates = useJobsStore((s) => s.loadingMoreInvalid);
  const loadingMoreLowScore = useJobsStore((s) => s.loadingMoreLowScore);
  const loadingMoreExtractionFailed = useJobsStore((s) => s.loadingMoreExtractionFailed);
  const onLoadMoreDuplicates = useJobsStore((s) => s.loadMoreInvalidJobs);
  const onLoadMoreLowScore = useJobsStore((s) => s.loadMoreLowScoreJobs);
  const onLoadMoreExtractionFailed = useJobsStore((s) => s.loadMoreExtractionFailedJobs);
  const nonUsListHasMore = useJobsStore((s) => s.nonUsHasMore);
  const loadingMoreNonUs = useJobsStore((s) => s.loadingMoreNonUs);
  const onLoadMoreNonUs = useJobsStore((s) => s.loadMoreNonUsJobs);
  const onBatchDeleteInvalid = useJobsStore((s) => s.openBatchDeleteConfirm);

  const tabItems =
    activeTab === 'non_us'
      ? nonUsItems
      : activeTab === 'low_score'
        ? lowScoreItems
        : activeTab === 'extraction_failed'
          ? extractionFailedItems
          : duplicateItems;
  const duplicateListHasMoreActive =
    activeTab === 'non_us'
      ? nonUsListHasMore
      : activeTab === 'low_score'
        ? lowScoreListHasMore
        : activeTab === 'extraction_failed'
          ? extractionFailedListHasMore
          : duplicateListHasMore;
  const loadingMoreActive =
    activeTab === 'non_us'
      ? loadingMoreNonUs
      : activeTab === 'low_score'
        ? loadingMoreLowScore
        : activeTab === 'extraction_failed'
          ? loadingMoreExtractionFailed
          : loadingMoreDuplicates;
  const onLoadMoreActive =
    activeTab === 'non_us'
      ? onLoadMoreNonUs
      : activeTab === 'low_score'
        ? onLoadMoreLowScore
        : activeTab === 'extraction_failed'
          ? onLoadMoreExtractionFailed
          : onLoadMoreDuplicates;
  const tabCount =
    activeTab === 'non_us'
      ? invalidCounts.non_us
      : activeTab === 'low_score'
        ? invalidCounts.low_score
        : activeTab === 'extraction_failed'
          ? invalidCounts.extraction_failed
          : invalidCounts.duplicates;
  const loadedCount = tabItems.length;
  const items = tabItems;

  const openMenuRaw = useUIStore((s) => s.openMenu);
  const openMenuId = openMenuRaw?.table === 'duplicated' ? openMenuRaw.id : null;
  const onToggleMenu = useCallback((id: string) => {
    useUIStore.getState().toggleMenu('duplicated', id);
  }, []);
  const onCloseMenu = useCallback(() => {
    useUIStore.getState().setOpenMenu(null);
  }, []);

  const onCompare = useUIStore((s) => s.compareDuplicate);
  const onReplace = useUIStore((s) => s.replaceDuplicate);
  const onReportAsValid = useModalStore((s) => s.openPromoteModal);
  const onDelete = useModalStore((s) => s.openDeleteModal);
  const onRestore = useJobsStore((s) => s.restoreExcludedJob);
  const [dupMenuOverride, setDupMenuOverride] = useState<{ left: number; top: number } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const closeDupMenu = () => {
    setDupMenuOverride(null);
    onCloseMenu();
  };

  useEffect(() => {
    if (!openMenuId) setDupMenuOverride(null);
  }, [openMenuId]);

  useEffect(() => {
    const valid = new Set(items.map((i) => i.id));
    setSelectedIds((prev) => {
      const next = new Set<string>();
      prev.forEach((id) => {
        if (valid.has(id)) next.add(id);
      });
      return next;
    });
  }, [items]);

  const allSelected = items.length > 0 && selectedIds.size === items.length;
  const someSelected = selectedIds.size > 0;

  const toggleSelectAll = () => {
    if (items.length === 0) return;
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(items.map((i) => i.id)));
    }
  };

  const toggleRow = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBatchDelete = () => {
    if (!onBatchDeleteInvalid || !someSelected) return;
    const selectedItems = items.filter((i) => selectedIds.has(i.id));
    if (selectedItems.length === 0) return;
    onBatchDeleteInvalid(selectedItems);
  };

  const dupScrollRef = useRef<HTMLDivElement | null>(null);
  const dupSentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!onLoadMoreActive || !duplicateListHasMoreActive || items.length === 0) return;
    const root = dupScrollRef.current;
    const target = dupSentinelRef.current;
    if (!root || !target) return;

    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries.some((e) => e.isIntersecting);
        if (hit && !loadingMoreActive) {
          onLoadMoreActive();
        }
      },
      { root, rootMargin: '120px 0px', threshold: 0 },
    );
    io.observe(target);
    return () => io.disconnect();
  }, [onLoadMoreActive, duplicateListHasMoreActive, loadingMoreActive, items.length, activeTab]);

  const activeMeta = DUP_TABS.find((t) => t.id === activeTab) ?? DUP_TABS[0];
  const countFor = (id: DupTabId): number =>
    id === 'non_us'
      ? invalidCounts.non_us
      : id === 'low_score'
        ? invalidCounts.low_score
        : id === 'extraction_failed'
          ? invalidCounts.extraction_failed
          : invalidCounts.duplicates;

  return (
    <>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/* Header */}
        <div className="shrink-0 border-b border-slate-200 bg-gradient-to-r from-white via-white to-slate-50/60 px-5 pt-5 pb-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-slate-800 to-slate-900 text-white shadow-sm">
                <Layers className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-xl font-bold tracking-tight text-slate-900">Hidden jobs</h2>
                <p className="mt-0.5 text-sm text-slate-500">
                  Review duplicates, non-US, low-match, and failed extractions - restore, replace, or dismiss.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClosePanel}
              className="rounded-lg border border-slate-200 bg-white p-2 text-slate-500 shadow-sm transition hover:bg-slate-50 hover:text-slate-900"
              aria-label="Close duplicates panel"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Tabs */}
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {DUP_TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              const count = countFor(tab.id);
              const accent = TAB_ACCENT[tab.accent];
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    setActiveTab(tab.id);
                    setSelectedIds(new Set());
                  }}
                  className={[
                    'flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-semibold transition',
                    isActive
                      ? accent.active
                      : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:text-slate-700',
                  ].join(' ')}
                >
                  <Icon className={`h-4 w-4 shrink-0 ${isActive ? accent.icon : 'text-slate-400'}`} />
                  <span className="truncate">{tab.label}</span>
                  <span
                    className={[
                      'inline-flex min-w-[1.5rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-bold tabular-nums',
                      isActive ? accent.badgeActive : accent.badgeIdle,
                    ].join(' ')}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-white px-5 py-2.5">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleSelectAll}
              disabled={items.length === 0}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {allSelected ? (
                <>
                  <CheckSquare className="h-3.5 w-3.5 text-blue-600" aria-hidden />
                  Deselect all
                </>
              ) : (
                <>
                  <Square className="h-3.5 w-3.5 text-slate-500" aria-hidden />
                  Select all
                </>
              )}
            </button>
            {someSelected && (
              <button
                type="button"
                onClick={handleBatchDelete}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-bold text-red-700 shadow-sm transition hover:bg-red-100"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                Dismiss ({selectedIds.size})
              </button>
            )}
          </div>
          <div className="text-[11px] text-slate-500">
            <span className="font-semibold tabular-nums text-slate-700">{loadedCount}</span> loaded
            {tabCount > loadedCount ? <span className="text-slate-400"> · {tabCount} total</span> : null}
            {duplicateListHasMoreActive ? (
              <span className="ml-1 inline-flex items-center gap-0.5 font-semibold text-indigo-600">
                <ChevronDown className="h-3 w-3" aria-hidden /> scroll for more
              </span>
            ) : items.length > 0 ? (
              <span className="text-slate-400"> · all loaded</span>
            ) : null}
          </div>
        </div>

        {children}

        {/* List */}
        <div ref={dupScrollRef} className="min-h-0 flex-1 overflow-y-auto bg-slate-50/60 px-4 py-4">
          {loadingLists ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin text-slate-400" /> Loading…
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-slate-300 shadow-sm ring-1 ring-slate-200">
                <activeMeta.icon className="h-6 w-6" />
              </div>
              <p className="mt-3 text-sm font-semibold text-slate-700">No {activeMeta.noun}.</p>
              <p className="mt-1 max-w-sm text-xs text-slate-500">{activeMeta.emptyHint}</p>
            </div>
          ) : (
            <ul className="space-y-2">
              {items.map((item) => {
                const selected = selectedIds.has(item.id);
                return (
                  <li key={item.id} className="group" data-job-menu-root="true">
                    <div
                      className={[
                        'relative flex items-start gap-3 rounded-xl border bg-white px-3 py-3 shadow-sm transition',
                        selected
                          ? 'border-blue-300 ring-1 ring-inset ring-blue-200'
                          : 'border-slate-200 hover:border-slate-300 hover:shadow',
                      ].join(' ')}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const p = clampDupContextMenu(e.clientX, e.clientY);
                        setDupMenuOverride(p);
                        if (openMenuId !== item.id) {
                          onToggleMenu(item.id);
                        }
                      }}
                    >
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleRow(item.id);
                        }}
                        className="mt-0.5 shrink-0 rounded-md p-0.5 text-slate-400 transition hover:text-slate-700"
                        aria-label={selected ? 'Deselect row' : 'Select row'}
                        aria-pressed={selected}
                      >
                        {selected ? (
                          <CheckSquare className="h-5 w-5 text-blue-600" aria-hidden />
                        ) : (
                          <Square className="h-5 w-5" aria-hidden />
                        )}
                      </button>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <ExclusionBadge type={item.exclusion_type ?? null} />
                          {item.company && (
                            <span className="truncate text-xs font-semibold text-slate-700">{item.company}</span>
                          )}
                          <span className="ml-auto shrink-0 text-[11px] text-slate-400">
                            {new Date(item.created_at_ms).toLocaleDateString(undefined, {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                            })}
                          </span>
                        </div>

                        <a
                          href={item.url}
                          target="_blank"
                          rel="noreferrer"
                          className="group/link mt-1 block"
                          title={item.url}
                          onContextMenu={(e) => e.preventDefault()}
                        >
                          <div
                            className={[
                              'truncate text-sm font-semibold',
                              item.title ? 'text-slate-900 group-hover/link:text-blue-700' : 'italic text-slate-500',
                            ].join(' ')}
                          >
                            {item.title || 'Untitled job'}
                          </div>
                          <div className="mt-0.5 flex items-center gap-1 text-xs text-slate-400 group-hover/link:text-blue-500">
                            <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
                            <span className="truncate">{item.url}</span>
                          </div>
                        </a>

                        {item.duplication_reason && (
                          <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-slate-50 px-2 py-1.5 text-xs text-slate-600">
                            <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
                            <span className="line-clamp-2">{item.duplication_reason}</span>
                          </div>
                        )}
                      </div>

                      <button
                        type="button"
                        data-dup-menu-anchor={item.id}
                        className="shrink-0 rounded-lg border border-slate-200 bg-white p-1.5 text-slate-500 shadow-sm transition hover:bg-slate-100 hover:text-slate-800"
                        aria-label="Actions"
                        aria-expanded={openMenuId === item.id}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setDupMenuOverride(null);
                          onToggleMenu(item.id);
                        }}
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {duplicateListHasMoreActive && items.length > 0 ? (
            <div
              ref={dupSentinelRef}
              className="mt-2 flex min-h-[48px] items-center justify-center gap-2 rounded-xl border border-dashed border-slate-200 bg-white px-3 py-3"
            >
              {loadingMoreActive ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin text-blue-600" aria-hidden />
                  <span className="text-xs font-medium text-slate-600">Loading more…</span>
                </>
              ) : (
                <span className="text-xs text-slate-400">Scroll for more {activeMeta.noun}</span>
              )}
            </div>
          ) : null}
        </div>
      </div>

      <DuplicateActionsMenuPortal
        openMenuId={openMenuId}
        items={items}
        overridePosition={dupMenuOverride}
        onCloseMenu={closeDupMenu}
        onCompare={onCompare}
        onReplace={onReplace}
        onReportAsValid={onReportAsValid}
        onDelete={onDelete}
        onRestore={onRestore}
      />
    </>
  );
}
