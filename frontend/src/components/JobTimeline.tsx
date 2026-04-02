import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown,
  Pencil,
  Flag,
  Copy,
  Trash2,
  RotateCw,
  RefreshCw,
  Eye,
  Check,
  X,
  Loader2,
} from 'lucide-react';
import type { SubmittedUrlItem } from '../types/ui';
import { jobMarkedApplied } from '../utils/appliedStatus';
import { getJobPipelineVisual, pipelineRingAriaLabel } from '../utils/jobPipelineVisual';
import { logger } from '../utils/logger';
import { MatchScoreChip, PipelineQuarterRing } from './PipelineProgressRing';

type Props = {
  items: SubmittedUrlItem[];
  openMenuId: string | null;
  onToggleMenu: (id: string) => void;
  onEdit: (item: SubmittedUrlItem) => void;
  onReportInvalid: (item: SubmittedUrlItem) => void;
  onReportDuplicate: (item: SubmittedUrlItem) => void;
  onDelete: (item: SubmittedUrlItem) => void;
  onBatchDelete?: (items: SubmittedUrlItem[]) => void;
  onMarkApplied: (items: SubmittedUrlItem[]) => void | Promise<void>;
  onMarkUnapplied: (items: SubmittedUrlItem[]) => void | Promise<void>;
  onOpenSelectedUrls?: (items: SubmittedUrlItem[]) => void;
  onOpenJobAnalysis?: (item: SubmittedUrlItem) => void;
  /** First-time match uses default; pass `{ force: true }` to re-run after profile changes. */
  onTriggerJobMatch?: (item: SubmittedUrlItem, opts?: { force?: boolean }) => void | Promise<void>;
  /** Bulk re-queue match analysis for selected jobs (async on server). */
  onRerunMatchAnalysis?: (items: SubmittedUrlItem[]) => void | Promise<void>;
  /** Bulk re-queue job page extraction + full pipeline (match after scrape), same as new job post. */
  onBatchRescrapePipeline?: (items: SubmittedUrlItem[]) => void | Promise<void>;
  onJobUrlClick?: (item: SubmittedUrlItem) => void;
  onRescrape?: (item: SubmittedUrlItem) => void;
  compareValidJobId?: string | null;
  /** Infinite scroll: load older jobs when user nears list bottom */
  jobListHasMore?: boolean;
  loadingMoreJobs?: boolean;
  onLoadMoreJobs?: () => void;
  jobsLoadedCount?: number;
  children?: React.ReactNode;
};

export function JobTimeline({
  items,
  openMenuId,
  onToggleMenu,
  onEdit,
  onReportInvalid,
  onReportDuplicate,
  onDelete,
  onBatchDelete,
  onMarkApplied,
  onMarkUnapplied,
  onOpenSelectedUrls,
  onOpenJobAnalysis,
  onTriggerJobMatch,
  onRerunMatchAnalysis,
  onBatchRescrapePipeline,
  onJobUrlClick,
  onRescrape,
  compareValidJobId,
  jobListHasMore,
  loadingMoreJobs,
  onLoadMoreJobs,
  jobsLoadedCount,
  children,
}: Props) {
  const [sortByDate, setSortByDate] = useState<Record<string, 'platform' | 'matchRate' | 'postedDate'>>({});
  const [sortOpenDate, setSortOpenDate] = useState<string | null>(null);
  const [selectedJobsByDate, setSelectedJobsByDate] = useState<Record<string, Set<string>>>({});
  const [isSelectingMode, setIsSelectingMode] = useState(false);
  const [dragStartDateKey, setDragStartDateKey] = useState<string | null>(null);
  const [bulkActionOpen, setBulkActionOpen] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const bulkActionRef = useRef<HTMLDivElement>(null);
  const selectionTimeoutFiredRef = useRef(false);
  /** Single pending long-press timer (do not store per-row on DOM nodes: mouseup may occur on another row or outside the list). */
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  /** Stops drag-painting (hover-select) without clearing `selectionTimeoutFiredRef` — row `mouseup` may run after window capture and still needs `preventDefault`. */
  const exitDragPaintMode = useCallback(() => {
    setIsSelectingMode(false);
    setDragStartDateKey(null);
  }, []);

  /** Full reset (new press on a row, or explicit cleanup). */
  const endDragSelectGesture = useCallback(() => {
    clearLongPressTimer();
    selectionTimeoutFiredRef.current = false;
    exitDragPaintMode();
  }, [clearLongPressTimer, exitDragPaintMode]);

  useEffect(() => {
    /** Window capture runs before row `mouseup`; only clear timer + paint mode so bubble handler can still read `selectionTimeoutFiredRef` for preventDefault. */
    const onWindowPointerEnd = () => {
      clearLongPressTimer();
      exitDragPaintMode();
    };
    window.addEventListener('mouseup', onWindowPointerEnd, true);
    window.addEventListener('pointerup', onWindowPointerEnd, true);
    window.addEventListener('pointercancel', onWindowPointerEnd, true);
    return () => {
      window.removeEventListener('mouseup', onWindowPointerEnd, true);
      window.removeEventListener('pointerup', onWindowPointerEnd, true);
      window.removeEventListener('pointercancel', onWindowPointerEnd, true);
    };
  }, [clearLongPressTimer, exitDragPaintMode]);

  /** When set, job action menu is shown fixed at this point (right-click); otherwise anchored to the … button. */
  const [jobMenuPoint, setJobMenuPoint] = useState<{ x: number; y: number } | null>(null);
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);

  const closeMenu = () => {
    setJobMenuPoint(null);
    if (openMenuId) onToggleMenu(openMenuId);
  };

  // Function to extract domain from URL
  const getPlatformDomain = (url: string): string => {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.replace('www.', '').split('.')[0];
    } catch {
      return url;
    }
  };

  // Toggle job selection for a specific date group
  const toggleJobSelection = (dateKey: string, jobId: string) => {
    setSelectedJobsByDate(prev => {
      const existingSet = prev[dateKey] || new Set<string>();
      const dateSet = new Set(existingSet);
      if (dateSet.has(jobId)) {
        dateSet.delete(jobId);
      } else {
        dateSet.add(jobId);
      }
      const newState = {
        ...prev,
        [dateKey]: dateSet
      };
      logger.debug('ui_job_selection_toggled', {
        job_id: jobId,
        date_key: dateKey,
        selected_ids: Array.from(dateSet),
      });
      return newState;
    });
  };

  // Toggle select all for a date group
  const toggleSelectAll = (dateKey: string) => {
    const jobIds = sortedGroupedByDate[dateKey]?.map(job => job.id) || [];
    const currentSelection = selectedJobsByDate[dateKey] || new Set<string>();
    const currentSize = currentSelection.size;
    
    if (currentSize === jobIds.length && currentSize > 0) {
      // Unselect all
      setSelectedJobsByDate(prev => ({
        ...prev,
        [dateKey]: new Set<string>()
      }));
    } else {
      // Select all
      setSelectedJobsByDate(prev => ({
        ...prev,
        [dateKey]: new Set(jobIds)
      }));
    }
  };

  // Check if all jobs in a date group are selected
  const isAllSelected = (dateKey: string): boolean => {
    const jobIds = sortedGroupedByDate[dateKey]?.map(job => job.id) || [];
    const currentSelection = selectedJobsByDate[dateKey] || new Set<string>();
    return jobIds.length > 0 && currentSelection.size === jobIds.length;
  };

  // Handle mouse down on job - start selection mode
  const handleJobMouseDown = (dateKey: string, jobId: string, e: React.MouseEvent) => {
    if (e.button !== 0) return; // Only left click

    // End any stale session: missed mouseup (released outside rows/scroll), or timer still pending on another row.
    endDragSelectGesture();

    // Long press simulation - set selecting mode after a short delay
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      selectionTimeoutFiredRef.current = true;
      setIsSelectingMode(true);
      setDragStartDateKey(dateKey);
      toggleJobSelection(dateKey, jobId);
    }, 300); // 300ms for long press
  };

  // Handle mouse move - detect drag and prevent link if dragging
  const handleJobMouseMove = (e: React.MouseEvent) => {
    if (longPressTimerRef.current) {
      e.preventDefault();
    }
  };

  // Bubble phase: window capture already ended paint mode; clear long-press ref and cancel any stray timer
  const handleJobMouseUp = (e: React.MouseEvent) => {
    if (selectionTimeoutFiredRef.current) {
      e.preventDefault();
    }
    endDragSelectGesture();
  };

  // Handle mouse enter during drag - select jobs
  const handleJobMouseEnter = (dateKey: string, jobId: string) => {
    if (!isSelectingMode || !dragStartDateKey) return;

    // Only select if hovering in same date group
    if (dateKey === dragStartDateKey) {
      const isCurrentSelected = selectedJobsByDate[dateKey]?.has(jobId) || false;
      
      // If job is not selected, select it
      if (!isCurrentSelected) {
        toggleJobSelection(dateKey, jobId);
      }
    }
  };

  // Get all selected jobs across all date groups
  const getAllSelectedJobs = (): SubmittedUrlItem[] => {
    const selectedIds = new Set<string>();

    // Collect all selected IDs from all date groups
    Object.entries(selectedJobsByDate).forEach(([, dateSet]) => {
      if (dateSet instanceof Set) {
        dateSet.forEach(id => {
          selectedIds.add(id);
        });
      }
    });

    // Get selected jobs from items (the original props)
    const result = items.filter(item => selectedIds.has(item.id));
    logger.debug('ui_get_selected_jobs', { selected_count: result.length });
    return result;
  };

  const handleMarkApplied = async () => {
    const selectedJobs = getAllSelectedJobs();
    if (selectedJobs.length === 0) return;
    try {
      await onMarkApplied(selectedJobs);
      setSelectedJobsByDate({});
      setBulkActionOpen(null);
    } catch {
      /* error surfaced by parent */
    }
  };

  const handleMarkUnapplied = async () => {
    const selectedJobs = getAllSelectedJobs();
    if (selectedJobs.length === 0) return;
    try {
      await onMarkUnapplied(selectedJobs);
      setSelectedJobsByDate({});
      setBulkActionOpen(null);
    } catch {
      /* error surfaced by parent */
    }
  };

  // Handle delete all selected
  const handleDeleteAll = () => {
    const selectedJobs = getAllSelectedJobs();

    if (selectedJobs.length === 0) {
      logger.debug('ui_delete_selected_skipped_empty_selection');
      return;
    }
    
    // Use batch delete if available, otherwise fallback to individual deletes
    if (onBatchDelete) {
      logger.info('ui_delete_selected_batch', { count: selectedJobs.length });
      onBatchDelete(selectedJobs);
    } else {
      logger.info('ui_delete_selected_individual_fallback', { count: selectedJobs.length });
      selectedJobs.forEach(job => {
        onDelete(job);
      });
    }
    
    // Clear selections
    setSelectedJobsByDate({});
    setBulkActionOpen(null);
  };

  // Handle opening all selected job URLs
  const handleOpenSelectedUrls = () => {
    const selectedJobs = getAllSelectedJobs();
    if (selectedJobs.length === 0) return;

    if (onOpenSelectedUrls) {
      onOpenSelectedUrls(selectedJobs);
    } else {
      const uniqueUrls = Array.from(new Set(selectedJobs.map((job) => job.url)));
      uniqueUrls.forEach((jobUrl) => {
        window.open(jobUrl, '_blank', 'noopener,noreferrer');
      });
    }

    setSelectedJobsByDate({});
    setBulkActionOpen(null);
  };

  const handleRerunMatchAnalysis = () => {
    const selectedJobs = getAllSelectedJobs();
    const eligible = selectedJobs.filter(
      (j) =>
        j.table === 'valid' &&
        !!j.extraction_id &&
        (j.extraction_status === 'completed' || j.scraped_at_ms != null),
    );
    if (eligible.length === 0 || !onRerunMatchAnalysis) {
      setBulkActionOpen(null);
      return;
    }
    void Promise.resolve(onRerunMatchAnalysis(eligible));
    setSelectedJobsByDate({});
    setBulkActionOpen(null);
  };

  const handleBatchRescrapePipeline = () => {
    const selectedJobs = getAllSelectedJobs();
    const eligible = selectedJobs.filter((j) => j.table === 'valid');
    if (eligible.length === 0 || !onBatchRescrapePipeline) {
      setBulkActionOpen(null);
      return;
    }
    void Promise.resolve(onBatchRescrapePipeline(eligible));
    setSelectedJobsByDate({});
    setBulkActionOpen(null);
  };

  useEffect(() => {
    if (!openMenuId) setJobMenuPoint(null);
  }, [openMenuId]);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        closeMenu();
      }
    };

    if (openMenuId) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [openMenuId]);

  // Close bulk action dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (bulkActionRef.current && !bulkActionRef.current.contains(event.target as Node)) {
        setBulkActionOpen(null);
      }
    };

    if (bulkActionOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [bulkActionOpen]);

  // Filter to show only actual jobs (exclude submission success notifications)
  const filteredItems = items.filter(item => {
    const hasValidJob = item.job_id !== null || item.duplicate_job_id !== null;
    return hasValidJob;
  });

  // Group items by date
  const groupedByDate = filteredItems.reduce(
    (acc, item) => {
      const date = new Date(item.created_at_ms);
      const dateKey = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      if (!acc[dateKey]) acc[dateKey] = [];
      acc[dateKey].push(item);
      return acc;
    },
    {} as Record<string, SubmittedUrlItem[]>
  );

  // Sort jobs within each date group based on sortByDate option for that group
  const sortedGroupedByDate = Object.entries(groupedByDate).reduce(
    (acc, [dateKey, items]) => {
      const currentSort = sortByDate[dateKey] || 'postedDate';
      const sortedItems = [...items].sort((a, b) => {
        switch (currentSort) {
          case 'platform': {
            const platformA = getPlatformDomain(a.url);
            const platformB = getPlatformDomain(b.url);
            return platformA.localeCompare(platformB);
          }
          case 'matchRate': {
            const scoreA = a.match_overall_score ?? -1;
            const scoreB = b.match_overall_score ?? -1;
            return scoreB - scoreA; // Descending: higher scores first
          }
          case 'postedDate': {
            const dateA = a.posted_date_ms ?? a.created_at_ms ?? 0;
            const dateB = b.posted_date_ms ?? b.created_at_ms ?? 0;
            return dateB - dateA; // Descending: newest first
          }
          default:
            return 0;
        }
      });
      acc[dateKey] = sortedItems;
      return acc;
    },
    {} as Record<string, SubmittedUrlItem[]>
  );

  const sortedDates = Object.keys(groupedByDate).sort((a, b) => {
    return new Date(b).getTime() - new Date(a).getTime();
  });

  const sortLabel = {
    platform: 'By Job Platform',
    matchRate: 'By Match Rate',
    postedDate: 'By Posted Date',
  };

  useEffect(() => {
    if (!onLoadMoreJobs || !jobListHasMore || filteredItems.length === 0) return;
    const root = timelineScrollRef.current;
    const target = loadMoreSentinelRef.current;
    if (!root || !target) return;

    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries.some((e) => e.isIntersecting);
        if (hit && !loadingMoreJobs) {
          onLoadMoreJobs();
        }
      },
      { root, rootMargin: '160px 0px', threshold: 0 },
    );
    io.observe(target);
    return () => io.disconnect();
  }, [onLoadMoreJobs, jobListHasMore, loadingMoreJobs, filteredItems.length]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* Timeline with job links */}
      <div ref={timelineScrollRef} className="timeline-scroll relative min-h-0 flex-1 overflow-y-auto pr-1">
        <div className="pointer-events-none sticky top-0 z-10 h-5 bg-gradient-to-b from-white via-white/80 to-transparent" />
        {filteredItems.length === 0 ? (
          <div className="text-center py-8 text-slate-400 text-sm">No jobs yet</div>
        ) : (
          // Show with date grouping for all filters
          <div className="space-y-6 pb-2">
            {sortedDates.map((dateKey) => (
              <div key={dateKey} className="relative">
                {/* Timeline marker and date with sort dropdown beside it */}
                <div className="flex items-start gap-3 mb-4">
                  <div className="w-2 h-2 rounded-full bg-blue-500 border-2 border-white shadow-md mt-1"></div>
                  <div className="flex items-center gap-3">
                    <div>
                      <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{dateKey}</div>
                      <div className="text-xs text-slate-400">
                        {sortedGroupedByDate[dateKey].length} job{sortedGroupedByDate[dateKey].length !== 1 ? 's' : ''}
                      </div>
                    </div>

                    {/* Sort dropdown for this date group - right beside date */}
                    <div className="relative">
                      <button
                        onClick={() => setSortOpenDate(sortOpenDate === dateKey ? null : dateKey)}
                        className="flex items-center gap-1 px-2 py-1 text-xs border border-slate-300 bg-white hover:bg-slate-50 transition rounded whitespace-nowrap"
                      >
                        <span className="text-slate-600 font-medium">Sort: {sortLabel[sortByDate[dateKey] || 'postedDate']}</span>
                        <ChevronDown className="h-3 w-3 text-slate-500" />
                      </button>

                      {sortOpenDate === dateKey && (
                        <div 
                          ref={sortMenuRef}
                          className="absolute left-0 top-full mt-1 z-50 rounded-md border border-slate-200 bg-white shadow-lg"
                        >
                          {(['platform', 'matchRate', 'postedDate'] as const).map((option) => (
                            <button
                              key={option}
                              onClick={() => {
                                setSortByDate({
                                  ...sortByDate,
                                  [dateKey]: option
                                });
                                setSortOpenDate(null);
                              }}
                              className={`w-full text-left px-3 py-2 text-sm hover:bg-slate-100 transition whitespace-nowrap ${
                                (sortByDate[dateKey] || 'postedDate') === option ? 'bg-blue-50 text-blue-700 font-medium' : 'text-slate-700'
                              }`}
                            >
                              {sortLabel[option]}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Select All / Unselect All button */}
                    <button
                      onClick={() => toggleSelectAll(dateKey)}
                      className="px-2 py-1 text-xs border border-slate-300 bg-white hover:bg-slate-50 transition rounded whitespace-nowrap font-medium"
                    >
                      {isAllSelected(dateKey) ? 'Unselect All' : 'Select All'}
                    </button>

                    {/* Actions button - shows when jobs are selected in this date group */}
                    {selectedJobsByDate[dateKey] && selectedJobsByDate[dateKey].size > 0 && (
                      <div className="relative">
                        <button
                          onClick={() => setBulkActionOpen(bulkActionOpen === dateKey ? null : dateKey)}
                          className="flex items-center gap-1 px-2 py-1 text-xs border border-slate-300 bg-white hover:bg-slate-50 transition rounded whitespace-nowrap font-medium"
                        >
                          <span>Actions</span>
                          <ChevronDown className="h-3 w-3" />
                        </button>

                        {bulkActionOpen === dateKey && (
                          <div
                            ref={bulkActionRef}
                            className="absolute right-0 top-full mt-1 z-50 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-slate-200 bg-white shadow-lg"
                          >
                            <button
                              type="button"
                              className="block w-full border-b border-slate-100 px-3 py-2 text-left text-sm text-slate-700 hover:bg-blue-50/80"
                              onClick={() => void handleMarkApplied()}
                            >
                              <span className="inline-flex items-center gap-2">
                                <Check className="h-4 w-4 shrink-0 text-blue-600" strokeWidth={2.5} aria-hidden />
                                Mark as Applied
                              </span>
                            </button>
                            <button
                              type="button"
                              className="block w-full border-b border-slate-100 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100"
                              onClick={() => void handleMarkUnapplied()}
                            >
                              <span className="inline-flex items-center gap-2">
                                <X className="h-4 w-4 shrink-0 text-slate-500" strokeWidth={2.5} aria-hidden />
                                Mark as Unapplied
                              </span>
                            </button>
                            <button
                              type="button"
                              className="block w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 border-b border-slate-100"
                              onClick={handleOpenSelectedUrls}
                            >
                              Open Selected Job URLs
                            </button>
                            {onRerunMatchAnalysis ? (
                              <button
                                type="button"
                                className="block w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 border-b border-slate-100"
                                onClick={handleRerunMatchAnalysis}
                              >
                                <span className="inline-flex items-center gap-2">
                                  <RefreshCw className="h-4 w-4 shrink-0" />
                                  Re-run match analysis
                                </span>
                              </button>
                            ) : null}
                            {onBatchRescrapePipeline ? (
                              <button
                                type="button"
                                className="block w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 border-b border-slate-100"
                                onClick={handleBatchRescrapePipeline}
                              >
                                <span className="inline-flex items-center gap-2">
                                  <RotateCw className="h-4 w-4 shrink-0" />
                                  Re-scrape page & re-analyze
                                </span>
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="block w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                              onClick={handleDeleteAll}
                            >
                              Delete
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Job links list */}
                <div className="ml-4 border-l-2 border-slate-200 pl-4 space-y-2">
                  {sortedGroupedByDate[dateKey].map((item) => {
                    const isSelected = selectedJobsByDate[dateKey]?.has(item.id) || false;
                    const isApplied = jobMarkedApplied(item);
                    return (
                    <div key={item.id} className="group">
                      <div className="relative">
                        <div 
                          className={`relative flex items-center gap-3 border px-3 py-2 transition rounded cursor-pointer select-none ${
                            isSelected && isApplied
                              ? 'border-white/35 bg-gradient-to-br from-blue-500 via-blue-600 to-indigo-800 text-white shadow-lg shadow-blue-900/25 ring-2 ring-white/75 hover:brightness-[1.02]'
                              : isSelected
                                ? 'border-blue-500 bg-blue-50'
                                : isApplied
                                  ? 'border-blue-300/55 bg-gradient-to-br from-blue-400 via-blue-500 to-indigo-700 text-white shadow-md shadow-blue-900/18 hover:brightness-[1.02]'
                                  : 'border-transparent hover:bg-blue-50'
                          } ${
                            item.id === compareValidJobId
                              ? isApplied
                                ? ' ring-2 ring-amber-300/95 ring-offset-2 ring-offset-blue-700'
                                : ' ring-2 ring-blue-500'
                              : ''
                          }`}
                          onMouseDown={(e) => handleJobMouseDown(dateKey, item.id, e)}
                          onMouseMove={handleJobMouseMove}
                          onMouseUp={handleJobMouseUp}
                          onMouseEnter={() => handleJobMouseEnter(dateKey, item.id)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            const { left, top } = clampJobContextMenuPosition(e.clientX, e.clientY);
                            setJobMenuPoint({ x: left, y: top });
                            if (openMenuId !== item.id) {
                              onToggleMenu(item.id);
                            }
                          }}
                          title="Right-click for actions"
                        >
                          <div className="flex items-center gap-3 min-w-0 flex-1">
                            {/* Checkbox - only show when selected */}
                            {isSelected && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  toggleJobSelection(dateKey, item.id);
                                }}
                                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded transition ${
                                  isApplied
                                    ? 'border border-white/95 bg-white text-blue-700 shadow-sm hover:bg-blue-50/95'
                                    : 'border border-blue-600 bg-blue-600 hover:bg-blue-700'
                                }`}
                                aria-label="Unselect job"
                              >
                                <svg
                                  className={`h-3 w-3 ${isApplied ? 'text-blue-700' : 'text-white'}`}
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                </svg>
                              </button>
                            )}
                            <span
                              className={`text-xs font-medium shrink-0 ${isApplied ? 'text-blue-100/95' : 'text-slate-400'}`}
                            >
                              {new Date(item.created_at_ms).toLocaleTimeString('en-US', {
                                hour: '2-digit',
                                minute: '2-digit',
                                hour12: false,
                              })}
                            </span>
                            <a
                              href={item.url}
                              target="_blank"
                              rel="noreferrer"
                              className="min-w-0 flex-1 cursor-pointer"
                              title={item.url}
                              onContextMenu={(e) => {
                                e.preventDefault();
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                e.preventDefault();
                                onJobUrlClick?.(item);
                                window.open(item.url, '_blank', 'noreferrer');
                              }}
                            >
                              <div
                                className={`truncate text-sm font-medium hover:underline ${
                                  isApplied
                                    ? 'text-white decoration-white/40 underline-offset-2 hover:text-white'
                                    : 'text-slate-700 hover:text-blue-600'
                                }`}
                              >
                                {item.url}
                              </div>
                            </a>
                            {isApplied && (
                              <span className="group/applied relative shrink-0">
                                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-white/45 bg-white/15 text-white shadow-inner backdrop-blur-[2px] ring-1 ring-white/20">
                                  <Check className="h-3.5 w-3.5 text-white" strokeWidth={2.75} aria-hidden />
                                </span>
                                <span className="pointer-events-none absolute bottom-full left-1/2 z-[80] mb-1 hidden w-52 -translate-x-1/2 rounded-lg border border-blue-200 bg-white/95 p-2 text-[11px] text-slate-700 shadow-xl backdrop-blur-sm group-hover/applied:block">
                                  <span className="block font-semibold text-blue-800">Applied</span>
                                  <span className="mt-0.5 block">
                                    <span className="font-medium text-slate-600">Applied by: </span>
                                    {item.appliedBy}
                                  </span>
                                  <span className="block text-slate-500">
                                    {new Date(item.appliedAt!).toLocaleString()}
                                  </span>
                                </span>
                              </span>
                            )}
                            {item.table === 'valid' && (() => {
                              const seenCount = item.click_count ?? 0;
                              const seenBadge = (
                                <span
                                  className={`flex items-center gap-0.5 shrink-0 rounded px-1.5 py-0.5 text-xs ${
                                    isApplied
                                      ? 'border border-white/25 bg-white/15 text-white backdrop-blur-sm'
                                      : 'bg-slate-100 text-slate-600'
                                  }`}
                                  title={`Clicked ${seenCount} time${seenCount !== 1 ? 's' : ''}`}
                                >
                                  <Eye className={`h-3.5 w-3 ${isApplied ? 'text-white/95' : ''}`} />
                                  <span>{seenCount}</span>
                                </span>
                              );
                              const visual = getJobPipelineVisual(item);
                              if (!visual) {
                                return <div className="flex items-center gap-1 shrink-0">{seenBadge}</div>;
                              }

                              if (visual.kind === 'failed') {
                                return (
                                  <div className="flex items-center gap-1 shrink-0">
                                    {seenBadge}
                                    <span
                                      className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                                        isApplied
                                          ? 'border border-red-300/40 bg-red-500/25 text-red-50'
                                          : 'bg-red-100 text-red-700'
                                      }`}
                                      title="Scraping failed"
                                    >
                                      Failed
                                    </span>
                                    {onRescrape && (
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.preventDefault();
                                          e.stopPropagation();
                                          onRescrape(item);
                                        }}
                                        className={`rounded px-1.5 py-0.5 text-xs font-medium transition ${
                                          isApplied
                                            ? 'border border-amber-300/50 bg-amber-400/90 text-amber-950 hover:bg-amber-300'
                                            : 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                                        }`}
                                        title="Re-scrape this job"
                                      >
                                        <RotateCw className="h-3 w-3 inline-block mr-0.5" />
                                        Rescrape
                                      </button>
                                    )}
                                  </div>
                                );
                              }

                              const hasExtraction = !!item.extraction_id;
                              const queueTitle =
                                item.extraction_status === 'processing'
                                  ? 'Extracting job posting from the page…'
                                  : 'In the extraction queue…';

                              const ringNode =
                                visual.kind === 'ring' ? (
                                  visual.phase === 'queue' ? (
                                    <span
                                      className="inline-flex shrink-0"
                                      title={queueTitle}
                                      aria-label={pipelineRingAriaLabel(visual)}
                                    >
                                      <PipelineQuarterRing
                                        filled={visual.filled}
                                        phase={visual.phase}
                                        aria-hidden
                                      />
                                    </span>
                                  ) : (onOpenJobAnalysis || onTriggerJobMatch) && hasExtraction ? (
                                    <button
                                      type="button"
                                      className={`inline-flex shrink-0 rounded-full p-0.5 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 ${
                                        isApplied
                                          ? 'hover:bg-white/15 focus-visible:ring-white/60 focus-visible:ring-offset-blue-900'
                                          : 'hover:bg-slate-100/90 focus-visible:ring-blue-400'
                                      }`}
                                      title={
                                        visual.phase === 'analyzing'
                                          ? 'AI profile match running — open analysis'
                                          : 'Posting extracted — open to run profile match'
                                      }
                                      aria-label={pipelineRingAriaLabel(visual)}
                                      onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        if (visual.phase === 'analyzing') {
                                          onOpenJobAnalysis?.(item);
                                        } else {
                                          onOpenJobAnalysis?.(item);
                                          onTriggerJobMatch?.(item);
                                        }
                                      }}
                                    >
                                      <PipelineQuarterRing
                                        filled={visual.filled}
                                        phase={visual.phase}
                                        aria-hidden
                                      />
                                    </button>
                                  ) : (
                                    <span
                                      className="inline-flex shrink-0"
                                      title={
                                        visual.phase === 'analyzing'
                                          ? 'AI profile match running'
                                          : 'Posting extracted — match not started yet'
                                      }
                                      aria-label={pipelineRingAriaLabel(visual)}
                                    >
                                      <PipelineQuarterRing
                                        filled={visual.filled}
                                        phase={visual.phase}
                                        aria-hidden
                                      />
                                    </span>
                                  )
                                ) : null;

                              const scoreNode =
                                visual.kind === 'score' ? (
                                  (onOpenJobAnalysis || onTriggerJobMatch) && hasExtraction ? (
                                    <MatchScoreChip
                                      score={visual.score}
                                      title={`Match score ${visual.score} — open job match analysis`}
                                      onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        onOpenJobAnalysis?.(item);
                                      }}
                                    />
                                  ) : (
                                    <MatchScoreChip
                                      score={visual.score}
                                      title={`Match score ${visual.score}`}
                                    />
                                  )
                                ) : null;

                              return (
                                <div className="flex items-center gap-1.5 shrink-0">
                                  {seenBadge}
                                  {ringNode}
                                  {scoreNode}
                                </div>
                              );
                            })()}
                          </div>
                        </div>

                        {openMenuId === item.id &&
                          (() => {
                            const menuPanel = (
                              <>
                                {item.table === 'valid' && (
                                  <>
                                    {!isApplied ? (
                                      <button
                                        type="button"
                                        className="block w-full border-b border-blue-100 px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-blue-50"
                                        onClick={() => {
                                          closeMenu();
                                          void onMarkApplied([item]);
                                        }}
                                      >
                                        <span className="inline-flex items-center gap-2">
                                          <Check className="h-4 w-4 shrink-0 text-blue-600" strokeWidth={2.5} aria-hidden />
                                          Mark as applied
                                        </span>
                                      </button>
                                    ) : (
                                      <button
                                        type="button"
                                        className="block w-full border-b border-blue-100 px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-50"
                                        onClick={() => {
                                          closeMenu();
                                          void onMarkUnapplied([item]);
                                        }}
                                      >
                                        <span className="inline-flex items-center gap-2">
                                          <X className="h-4 w-4 shrink-0 text-slate-500" strokeWidth={2.5} aria-hidden />
                                          Unmark as applied
                                        </span>
                                      </button>
                                    )}
                                  </>
                                )}
                                <button
                                  type="button"
                                  className="block w-full border-b border-blue-100 px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-blue-50"
                                  onClick={() => {
                                    closeMenu();
                                    onEdit(item);
                                  }}
                                >
                                  <span className="inline-flex items-center gap-2">
                                    <Pencil className="h-4 w-4" />
                                    Edit
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  className="block w-full border-b border-blue-100 px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-blue-50"
                                  onClick={() => {
                                    closeMenu();
                                    onReportInvalid(item);
                                  }}
                                >
                                  <span className="inline-flex items-center gap-2">
                                    <Flag className="h-4 w-4" />
                                    Report Invalid
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  className="block w-full border-b border-blue-100 px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-blue-50"
                                  onClick={() => {
                                    closeMenu();
                                    onReportDuplicate(item);
                                  }}
                                >
                                  <span className="inline-flex items-center gap-2">
                                    <Copy className="h-4 w-4" />
                                    Report Duplicate
                                  </span>
                                </button>
                                {onTriggerJobMatch &&
                                  item.table === 'valid' &&
                                  item.extraction_id &&
                                  (item.extraction_status === 'completed' || item.scraped_at_ms != null) && (
                                    <button
                                      type="button"
                                      className="block w-full border-b border-blue-100 px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-blue-50"
                                      onClick={() => {
                                        closeMenu();
                                        void onTriggerJobMatch(item, { force: true });
                                      }}
                                    >
                                      <span className="inline-flex items-center gap-2">
                                        <RefreshCw className="h-4 w-4" />
                                        Re-run match analysis
                                      </span>
                                    </button>
                                  )}
                                {onRescrape && item.table === 'valid' && (
                                  <button
                                    type="button"
                                    className={`block w-full border-b border-blue-100 px-3 py-2 text-left text-sm transition hover:bg-slate-50 ${
                                      item.extraction_status === 'failed' ? 'text-amber-800 hover:bg-amber-50' : 'text-slate-700'
                                    }`}
                                    onClick={() => {
                                      closeMenu();
                                      void onRescrape(item);
                                    }}
                                  >
                                    <span className="inline-flex items-center gap-2">
                                      <RotateCw className="h-4 w-4" />
                                      Re-scrape page & re-analyze
                                    </span>
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="block w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                                  onClick={() => {
                                    closeMenu();
                                    onDelete(item);
                                  }}
                                >
                                  <span className="inline-flex items-center gap-2">
                                    <Trash2 className="h-4 w-4" />
                                    Delete
                                  </span>
                                </button>
                              </>
                            );
                            return jobMenuPoint && typeof document !== 'undefined'
                              ? createPortal(
                                  <div
                                    ref={menuRef}
                                    role="menu"
                                    className="glass-card w-56 overflow-hidden rounded-xl border border-blue-200/70 bg-white/95 shadow-xl"
                                    style={{ position: 'fixed', left: jobMenuPoint.x, top: jobMenuPoint.y, zIndex: 100 }}
                                    data-job-menu-root="true"
                                  >
                                    {menuPanel}
                                  </div>,
                                  document.body,
                                )
                              : (
                                  <div
                                    ref={menuRef}
                                    role="menu"
                                    className="glass-card absolute right-0 top-full z-[100] mt-1 w-56 overflow-hidden rounded-xl border border-blue-200/70 bg-white/95 shadow-xl"
                                    data-job-menu-root="true"
                                  >
                                    {menuPanel}
                                  </div>
                                );
                          })()}
                      </div>
                    </div>
                  );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
        {jobListHasMore && onLoadMoreJobs ? (
          <div className="px-1 pb-6 pt-4">
            <div
              ref={loadMoreSentinelRef}
              className="flex min-h-[56px] flex-col items-center justify-center gap-2 rounded-2xl border border-blue-100/80 bg-gradient-to-b from-blue-50/90 to-white/60 px-4 py-3 shadow-inner"
            >
              {loadingMoreJobs ? (
                <>
                  <Loader2 className="h-6 w-6 animate-spin text-blue-600" aria-hidden />
                  <span className="text-xs font-medium text-slate-600">Loading older jobs…</span>
                </>
              ) : (
                <span className="text-center text-[11px] font-medium leading-snug text-slate-500">
                  Scroll for more — older jobs load automatically
                  {jobsLoadedCount != null ? (
                    <span className="mt-1 block tabular-nums text-slate-400">{jobsLoadedCount} loaded</span>
                  ) : null}
                </span>
              )}
            </div>
          </div>
        ) : null}
        <div className="pointer-events-none sticky bottom-0 z-10 h-6 bg-gradient-to-t from-white via-white/80 to-transparent" />
      </div>

      {children}
    </div>
  );
}

function clampJobContextMenuPosition(clientX: number, clientY: number) {
  const menuWidth = 224;
  const menuHeight = 360;
  const pad = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = clientX;
  let top = clientY;
  if (left + menuWidth + pad > vw) left = vw - menuWidth - pad;
  if (top + menuHeight + pad > vh) top = vh - menuHeight - pad;
  if (left < pad) left = pad;
  if (top < pad) top = pad;
  return { left, top };
}

export default JobTimeline;

