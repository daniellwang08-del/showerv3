import type { ReactNode } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeftRight,
  Search,
  Trash2,
  AlertCircle,
  MoreHorizontal,
  X,
  ClipboardCheck,
  Loader2,
  ChevronDown,
  Square,
  CheckSquare,
} from 'lucide-react';
import { SubmittedUrlItem } from '../types/ui';

const MENU_WIDTH = 224;
const MENU_EST_HEIGHT = 200;

type Props = {
  loadingLists: boolean;
  items: SubmittedUrlItem[];
  openMenuId: string | null;
  onToggleMenu: (id: string) => void;
  onCloseMenu: () => void;
  onCompare: (item: SubmittedUrlItem) => void;
  onReplace: (item: SubmittedUrlItem) => void;
  onReportAsValid: (item: SubmittedUrlItem) => void;
  onDelete: (item: SubmittedUrlItem) => void;
  /** Bulk delete selected invalid jobs (server removes invalid row + shadow valid rows + orphan extractions). */
  onBatchDeleteInvalid?: (items: SubmittedUrlItem[]) => void | Promise<void>;
  onClosePanel: () => void;
  children: ReactNode;
  duplicateListHasMore?: boolean;
  loadingMoreDuplicates?: boolean;
  onLoadMoreDuplicates?: () => void;
  duplicatesLoadedCount?: number;
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
}: {
  openMenuId: string | null;
  items: SubmittedUrlItem[];
  /** When set (e.g. right-click), menu is fixed here instead of anchoring to the … button. */
  overridePosition: { left: number; top: number } | null;
  onCloseMenu: () => void;
  onCompare: (item: SubmittedUrlItem) => void;
  onReplace: (item: SubmittedUrlItem) => void;
  onReportAsValid: (item: SubmittedUrlItem) => void;
  onDelete: (item: SubmittedUrlItem) => void;
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
      className="glass-card fixed z-[200] w-56 overflow-hidden rounded-xl border border-blue-200/70 bg-white/95 shadow-xl backdrop-blur-sm"
      style={{ top: pos.top, left: pos.left }}
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
          Delete
        </span>
      </button>
    </div>,
    document.body,
  );
}

export function DuplicateJobsPanel({
  loadingLists,
  items,
  openMenuId,
  onToggleMenu,
  onCloseMenu,
  onCompare,
  onReplace,
  onReportAsValid,
  onDelete,
  onBatchDeleteInvalid,
  onClosePanel,
  children,
  duplicateListHasMore,
  loadingMoreDuplicates,
  onLoadMoreDuplicates,
  duplicatesLoadedCount,
}: Props) {
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
    if (!onLoadMoreDuplicates || !duplicateListHasMore || items.length === 0) return;
    const root = dupScrollRef.current;
    const target = dupSentinelRef.current;
    if (!root || !target) return;

    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries.some((e) => e.isIntersecting);
        if (hit && !loadingMoreDuplicates) {
          onLoadMoreDuplicates();
        }
      },
      { root, rootMargin: '120px 0px', threshold: 0 },
    );
    io.observe(target);
    return () => io.disconnect();
  }, [onLoadMoreDuplicates, duplicateListHasMore, loadingMoreDuplicates, items.length]);

  return (
    <>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="mb-4 flex items-start justify-between gap-3 border-b border-blue-100 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-blue-600" />
              <h2 className="text-lg font-bold text-slate-900">Duplicates found</h2>
              <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-700">
                {items.length}
              </span>
            </div>
            <p className="mt-1 text-sm text-slate-500">Review and resolve duplicate job postings</p>
            {items.length > 0 && duplicateListHasMore != null ? (
              <p className="mt-2 text-[11px] text-slate-500">
                <span className="font-semibold tabular-nums text-slate-700">{duplicatesLoadedCount ?? items.length}</span>{' '}
                loaded
                {duplicateListHasMore ? (
                  <span className="ml-1 inline-flex items-center gap-0.5 font-semibold text-indigo-600">
                    <ChevronDown className="h-3 w-3" aria-hidden />
                    scroll for more
                  </span>
                ) : (
                  <span className="text-slate-400"> · all loaded</span>
                )}
              </p>
            ) : null}
            {items.length > 0 ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={toggleSelectAll}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50"
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
                {someSelected && onBatchDeleteInvalid ? (
                  <button
                    type="button"
                    onClick={handleBatchDelete}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-700 shadow-sm transition hover:bg-red-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    Delete ({selectedIds.size})
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClosePanel}
            className="rounded-lg border border-slate-200 bg-white p-2 text-slate-600 hover:bg-slate-50 hover:text-slate-900 transition"
            aria-label="Close duplicates panel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mb-4 shrink-0 min-w-0">
          {children}
        </div>

        <div ref={dupScrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="glass-card rounded-xl border border-blue-200/70 bg-gradient-to-b from-white to-blue-50/30 shadow-sm">
            {loadingLists ? (
              <div className="p-4 text-sm text-slate-500">Loading...</div>
            ) : items.length === 0 ? (
              <div className="p-8 text-center">
                <p className="text-sm font-medium text-slate-600">No duplicates yet.</p>
                <p className="mt-1 text-xs text-slate-500">Potential duplicate jobs will appear here after AI analysis.</p>
              </div>
            ) : (
              <ul className="divide-y divide-blue-100/60">
                {items.map((item) => (
                  <li key={item.id} className="group">
                    <div className="relative" data-job-menu-root="true">
                      <div
                        className="flex items-center justify-between gap-2 border border-transparent px-2 py-2 transition hover:bg-blue-50/70"
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
                          className="shrink-0 rounded-md p-1 text-slate-500 transition hover:bg-slate-100 hover:text-slate-800"
                          aria-label={selectedIds.has(item.id) ? 'Deselect row' : 'Select row'}
                          aria-pressed={selectedIds.has(item.id)}
                        >
                          {selectedIds.has(item.id) ? (
                            <CheckSquare className="h-4 w-4 text-blue-600" aria-hidden />
                          ) : (
                            <Square className="h-4 w-4" aria-hidden />
                          )}
                        </button>
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noreferrer"
                          className="min-w-0 flex-1 cursor-pointer"
                          title={item.url}
                          onContextMenu={(e) => e.preventDefault()}
                        >
                          <div className="truncate text-xs font-medium text-slate-700 hover:text-blue-700 hover:underline">{item.url}</div>
                          <div className="mt-0.5 text-[11px] text-slate-500">
                            {new Date(item.created_at_ms).toLocaleString()}
                          </div>
                        </a>

                        <button
                          type="button"
                          data-dup-menu-anchor={item.id}
                          className="shrink-0 rounded-md border border-slate-300 bg-white p-1 text-slate-700 opacity-0 transition-opacity duration-200 hover:bg-slate-100 group-hover:opacity-100"
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
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {duplicateListHasMore && onLoadMoreDuplicates && items.length > 0 ? (
            <div
              ref={dupSentinelRef}
              className="mt-2 flex min-h-[48px] flex-col items-center justify-center gap-2 rounded-xl border border-blue-100/90 bg-gradient-to-b from-blue-50/80 to-white/70 px-3 py-2"
            >
              {loadingMoreDuplicates ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin text-blue-600" aria-hidden />
                  <span className="text-[11px] font-medium text-slate-600">Loading more…</span>
                </>
              ) : (
                <span className="text-center text-[10px] text-slate-500">Scroll for older duplicates</span>
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
      />
    </>
  );
}
