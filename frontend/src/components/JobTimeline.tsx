import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Calendar, Pencil, Flag, Copy, Trash2, RotateCw, Eye } from 'lucide-react';
import type { SubmittedUrlItem } from '../types/ui';

type Props = {
  items: SubmittedUrlItem[];
  openMenuId: string | null;
  onToggleMenu: (id: string) => void;
  onDateRangeChange?: (range: 'all' | '7d' | '30d' | 'custom') => void;
  onEdit: (item: SubmittedUrlItem) => void;
  onReportInvalid: (item: SubmittedUrlItem) => void;
  onReportDuplicate: (item: SubmittedUrlItem) => void;
  onDelete: (item: SubmittedUrlItem) => void;
  onBatchDelete?: (items: SubmittedUrlItem[]) => void;
  onMarkApplied: (items: SubmittedUrlItem[], userInitial: string) => void;
  onMarkUnapplied: (items: SubmittedUrlItem[]) => void;
  onOpenSelectedUrls?: (items: SubmittedUrlItem[]) => void;
  onShowScrapedContent?: (item: SubmittedUrlItem) => void;
  onShowJobMatch?: (item: SubmittedUrlItem) => void;
  onTriggerJobMatch?: (item: SubmittedUrlItem) => void;
  onJobUrlClick?: (item: SubmittedUrlItem) => void;
  onRescrape?: (item: SubmittedUrlItem) => void;
  userInitial?: string;
  compareValidJobId?: string | null;
  children?: React.ReactNode;
};

export function JobTimeline({
  items,
  openMenuId,
  onToggleMenu,
  onDateRangeChange,
  onEdit,
  onReportInvalid,
  onReportDuplicate,
  onDelete,
  onBatchDelete,
  onMarkApplied,
  onMarkUnapplied,
  onOpenSelectedUrls,
  onShowScrapedContent,
  onShowJobMatch,
  onTriggerJobMatch,
  onJobUrlClick,
  onRescrape,
  userInitial,
  compareValidJobId,
  children,
}: Props) {
  const [dateRange, setDateRange] = useState<'all' | '7d' | '30d' | 'custom'>('all');
  const [open, setOpen] = useState(false);
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');
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

  const handleDateChange = (range: 'all' | '7d' | '30d' | 'custom') => {
    setDateRange(range);
    onDateRangeChange?.(range);
    setOpen(false);
  };

  const closeMenu = () => {
    onToggleMenu('');
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
      console.log('After toggle selection - jobId:', jobId, 'dateKey:', dateKey, 'selectedIds:', Array.from(dateSet));
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
    
    selectionTimeoutFiredRef.current = false;
    
    // Long press simulation - set selecting mode after a short delay
    const timeoutId = setTimeout(() => {
      selectionTimeoutFiredRef.current = true;
      setIsSelectingMode(true);
      setDragStartDateKey(dateKey);
      toggleJobSelection(dateKey, jobId);
    }, 300); // 300ms for long press

    // Store timeout ID for cleanup on mouse up
    (e.currentTarget as any).timeoutId = timeoutId;
  };

  // Handle mouse move - detect drag and prevent link if dragging
  const handleJobMouseMove = (e: React.MouseEvent) => {
    const timeoutId = (e.currentTarget as any).timeoutId;
    // If timeout is still pending and user moved mouse, they're dragging
    if (timeoutId) {
      e.preventDefault();
    }
  };

  // Handle mouse up - end drag selection
  const handleJobMouseUp = (e: React.MouseEvent) => {
    const timeoutId = (e.currentTarget as any).timeoutId;
    if (timeoutId) {
      // Clear the timeout (in case it hasn't fired yet)
      clearTimeout(timeoutId);
      (e.currentTarget as any).timeoutId = null;
    }
    
    // If the timeout already fired (selection mode was activated), prevent link opening
    if (selectionTimeoutFiredRef.current) {
      e.preventDefault();
      selectionTimeoutFiredRef.current = false;
    }
    
    setIsSelectingMode(false);
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
    
    console.log('getAllSelectedJobs START - selectedJobsByDate:', selectedJobsByDate);
    
    // Collect all selected IDs from all date groups
    Object.entries(selectedJobsByDate).forEach(([dateKey, dateSet]) => {
      console.log(`  dateKey: ${dateKey}, dateSet:`, dateSet, 'isSet:', dateSet instanceof Set);
      if (dateSet instanceof Set) {
        dateSet.forEach(id => {
          console.log(`    Adding id: ${id}`);
          selectedIds.add(id);
        });
      }
    });
    
    console.log('getAllSelectedJobs - All selectedIds:', Array.from(selectedIds));
    console.log('getAllSelectedJobs - items.length:', items.length);
    console.log('getAllSelectedJobs - items IDs:', items.map(i => i.id));
    
    // Get selected jobs from items (the original props)
    const result = items.filter(item => selectedIds.has(item.id));
    
    console.log('getAllSelectedJobs - Found jobs count:', result.length);
    console.log('getAllSelectedJobs - Found jobs URLs:', result.map(j => j.url));
    return result;
  };

  // Handle mark as applied
  const handleMarkApplied = () => {
    const selectedJobs = getAllSelectedJobs();
    if (selectedJobs.length > 0 && userInitial) {
      onMarkApplied(selectedJobs, userInitial);
      // Clear selections after action
      setSelectedJobsByDate({});
      setBulkActionOpen(null);
    }
  };

  // Handle mark as unapplied
  const handleMarkUnapplied = () => {
    const selectedJobs = getAllSelectedJobs();
    if (selectedJobs.length > 0) {
      onMarkUnapplied(selectedJobs);
      // Clear selections after action
      setSelectedJobsByDate({});
      setBulkActionOpen(null);
    }
  };

  // Handle delete all selected
  const handleDeleteAll = () => {
    const selectedJobs = getAllSelectedJobs();
    
    console.log('handleDeleteAll - Total jobs to delete:', selectedJobs.length);
    console.log('handleDeleteAll - Jobs:', selectedJobs);
    
    if (selectedJobs.length === 0) {
      console.log('No jobs selected to delete!');
      return;
    }
    
    // Use batch delete if available, otherwise fallback to individual deletes
    if (onBatchDelete) {
      console.log('Using batch delete...');
      onBatchDelete(selectedJobs);
    } else {
      console.log('Using individual deletes (fallback)...');
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
    if (!hasValidJob) return false;

    // Apply date range filtering
    const itemDate = new Date(item.created_at_ms);
    const now = new Date();
    const daysDiff = Math.floor((now.getTime() - itemDate.getTime()) / (1000 * 60 * 60 * 24));

    switch (dateRange) {
      case '7d':
        return daysDiff <= 7;
      case '30d':
        return daysDiff <= 30;
      case 'custom': {
        if (!customStartDate || !customEndDate) return true;
        const startDate = new Date(customStartDate);
        const endDate = new Date(customEndDate);
        endDate.setHours(23, 59, 59, 999);
        return itemDate >= startDate && itemDate <= endDate;
      }
      case 'all':
      default:
        return true;
    }
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
      const currentSort = sortByDate[dateKey] || 'platform';
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

  const dateRangeLabel = {
    all: 'All dates',
    '7d': 'Last 7 days',
    '30d': 'Last 30 days',
    custom: 'Custom range',
  };

  const sortLabel = {
    platform: 'By Job Platform',
    matchRate: 'By Match Rate',
    postedDate: 'By Posted Date',
  };

  return (
    <div className="flex flex-col h-full">
      {/* Date selector dropdown */}
      <div className="mb-6 relative">
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center justify-between px-3 py-2 text-sm rounded-md border border-slate-300 bg-white hover:bg-slate-50 transition w-full"
        >
          <div className="flex items-center gap-2">
            <Calendar className="h-4 w-4 text-slate-600" />
            <span className="text-slate-700 font-medium">{dateRangeLabel[dateRange]}</span>
          </div>
          <ChevronDown className="h-4 w-4 text-slate-500" />
        </button>

        {open && (
          <div className="absolute top-full mt-1 left-0 right-0 z-10 rounded-md border border-slate-200 bg-white shadow-lg">
            {(['all', '7d', '30d', 'custom'] as const).map((range) => (
              <div key={range}>
                <button
                  onClick={() => handleDateChange(range)}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-slate-100 transition ${
                    dateRange === range ? 'bg-blue-50 text-blue-700 font-medium' : 'text-slate-700'
                  }`}
                >
                  {dateRangeLabel[range]}
                </button>
                
                {/* Custom date range picker */}
                {dateRange === 'custom' && range === 'custom' && (
                  <div className="border-t border-slate-200 px-3 py-3 space-y-3">
                    <div className="space-y-1">
                      <label className="block text-xs font-medium text-slate-600">Start Date</label>
                      <input
                        type="date"
                        value={customStartDate}
                        onChange={(e) => setCustomStartDate(e.target.value)}
                        className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="block text-xs font-medium text-slate-600">End Date</label>
                      <input
                        type="date"
                        value={customEndDate}
                        onChange={(e) => setCustomEndDate(e.target.value)}
                        className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => setOpen(false)}
                      className="w-full px-2 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 transition font-medium"
                    >
                      Apply
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Timeline with job links */}
      <div className="flex-1 overflow-y-auto">
        {filteredItems.length === 0 ? (
          <div className="text-center py-8 text-slate-400 text-sm">No jobs yet</div>
        ) : (
          // Show with date grouping for all filters
          <div className="space-y-6">
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
                        <span className="text-slate-600 font-medium">Sort: {sortLabel[sortByDate[dateKey] || 'platform']}</span>
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
                                (sortByDate[dateKey] || 'platform') === option ? 'bg-blue-50 text-blue-700 font-medium' : 'text-slate-700'
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
                            className="absolute right-0 top-full mt-1 z-50 w-48 rounded-lg border border-slate-200 bg-white shadow-lg"
                          >
                            <button
                              type="button"
                              className="block w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 border-b border-slate-100"
                              onClick={handleMarkApplied}
                            >
                              Mark as Applied
                            </button>
                            <button
                              type="button"
                              className="block w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 border-b border-slate-100"
                              onClick={handleMarkUnapplied}
                            >
                              Mark as Unapplied
                            </button>
                            <button
                              type="button"
                              className="block w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 border-b border-slate-100"
                              onClick={handleOpenSelectedUrls}
                            >
                              Open Selected Job URLs
                            </button>
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
                    return (
                    <div key={item.id} className="group">
                      <div className="relative">
                        <div 
                          className={`flex items-center justify-between gap-3 border px-3 py-2 transition rounded cursor-pointer select-none ${
                            isSelected
                              ? 'border-blue-500 bg-blue-50'
                              : ('border-transparent hover:bg-blue-50')
                          } ${
                            item.id === compareValidJobId ? 'ring-2 ring-blue-500' : ''
                          }`}
                          onMouseDown={(e) => handleJobMouseDown(dateKey, item.id, e)}
                          onMouseMove={handleJobMouseMove}
                          onMouseUp={handleJobMouseUp}
                          onMouseEnter={() => handleJobMouseEnter(dateKey, item.id)}
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
                                className="w-4 h-4 flex items-center justify-center bg-blue-600 border border-blue-600 rounded shrink-0 hover:bg-blue-700 transition"
                                aria-label="Unselect job"
                              >
                                <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                </svg>
                              </button>
                            )}
                            <span className="text-xs font-medium text-slate-400 shrink-0">
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
                              onClick={(e) => {
                                e.stopPropagation();
                                e.preventDefault();
                                onJobUrlClick?.(item);
                                window.open(item.url, '_blank', 'noreferrer');
                              }}
                            >
                              <div className="truncate text-sm font-medium text-slate-700 hover:text-blue-600 hover:underline">{item.url}</div>
                            </a>
                            {item.table === 'valid' && (() => {
                              const status = item.extraction_status;
                              const seenCount = item.click_count ?? 0;
                              const seenBadge = (
                                <span className="flex items-center gap-0.5 shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600" title={`Clicked ${seenCount} time${seenCount !== 1 ? 's' : ''}`}>
                                  <Eye className="h-3.5 w-3" />
                                  <span>{seenCount}</span>
                                </span>
                              );
                              if (status === 'pending') {
                                return (
                                  <div className="flex items-center gap-1 shrink-0">
                                    {seenBadge}
                                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600" title="Queued">Pending</span>
                                  </div>
                                );
                              }
                              if (status === 'processing') {
                                return (
                                  <div className="flex items-center gap-1 shrink-0">
                                    {seenBadge}
                                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700" title="Scraping in progress">Processing</span>
                                  </div>
                                );
                              }
                              if (status === 'completed' || item.scraped_at_ms != null) {
                                const hasExtraction = !!item.extraction_id;
                                const badgeClass = `shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-700 ${hasExtraction ? 'cursor-pointer hover:bg-emerald-200' : ''}`;
                                const matchScore = item.match_overall_score;
                                const matchProcessing = item.match_status === 'processing';
                                const matchLabel = matchProcessing
                                  ? 'Processing'
                                  : matchScore != null
                                    ? String(matchScore)
                                    : '—';
                                const matchBadgeClass = matchProcessing
                                  ? 'shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700'
                                  : 'shrink-0 rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-700 cursor-pointer hover:bg-blue-200';
                                const handleMatchClick = () => {
                                  if (matchScore != null) {
                                    onShowJobMatch?.(item);
                                  } else {
                                    onTriggerJobMatch?.(item);
                                  }
                                };
                                return (
                                  <div className="flex items-center gap-1 shrink-0">
                                    {hasExtraction && onShowScrapedContent ? (
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.preventDefault();
                                          e.stopPropagation();
                                          onShowScrapedContent(item);
                                        }}
                                        className={badgeClass}
                                        title="Click to view scraped content"
                                      >
                                        Scraped
                                      </button>
                                    ) : (
                                      <span className={badgeClass} title="Content scraped">
                                        Scraped
                                      </span>
                                    )}
                                    {seenBadge}
                                    {(onShowJobMatch || onTriggerJobMatch) && hasExtraction && (
                                      matchProcessing ? (
                                        <span
                                          className={matchBadgeClass}
                                          title="AI analyzing job match"
                                        >
                                          {matchLabel}
                                        </span>
                                      ) : (
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            handleMatchClick();
                                          }}
                                          className={matchBadgeClass}
                                          title={
                                            matchScore != null
                                              ? `Match score: ${matchScore}. Click to view details`
                                              : 'Click to analyze job match'
                                          }
                                        >
                                          {matchLabel}
                                        </button>
                                      )
                                    )}
                                  </div>
                                );
                              }
                              if (status === 'failed') {
                                return (
                                  <div className="flex items-center gap-1 shrink-0">
                                    {seenBadge}
                                    <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700" title="Scraping failed">
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
                                        className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700 hover:bg-amber-200 transition"
                                        title="Re-scrape this job"
                                      >
                                        <RotateCw className="h-3 w-3 inline-block mr-0.5" />
                                        Rescrape
                                      </button>
                                    )}
                                  </div>
                                );
                              }
                              return null;
                            })()}
                          </div>

                          <button
                            type="button"
                            className="shrink-0 border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 opacity-0 transition-opacity duration-200 hover:bg-slate-100 group-hover:opacity-100"
                            aria-label="Actions"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              onToggleMenu(item.id);
                            }}
                          >
                            ...
                          </button>
                        </div>

                        {openMenuId === item.id && (
                          <div 
                            ref={menuRef}
                            className="absolute right-0 top-full z-50 mt-1 w-56 rounded-lg border border-slate-200 bg-white shadow-lg"
                            data-job-menu-root="true"
                          >
                            <button
                              type="button"
                              className="block w-full border-b border-slate-100 px-3 py-2 text-left text-sm text-slate-700 hover:bg-blue-50"
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
                              className="block w-full border-b border-slate-100 px-3 py-2 text-left text-sm text-slate-700 hover:bg-blue-50"
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
                              className="block w-full border-b border-slate-100 px-3 py-2 text-left text-sm text-slate-700 hover:bg-blue-50"
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
                            {onRescrape && item.extraction_status === 'failed' && (
                              <button
                                type="button"
                                className="block w-full border-b border-slate-100 px-3 py-2 text-left text-sm text-amber-700 hover:bg-amber-50"
                                onClick={() => {
                                  closeMenu();
                                  onRescrape(item);
                                }}
                              >
                                <span className="inline-flex items-center gap-2">
                                  <RotateCw className="h-4 w-4" />
                                  Rescrape
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
                          </div>
                        )}
                      </div>

                      {/* Applied indicator - shown below job link */}
                      {item.appliedAt && item.appliedBy && (
                        <div className="mt-1 ml-4 text-xs text-green-600 font-medium flex items-center gap-1">
                          ✓ Applied by {item.appliedBy}
                        </div>
                      )}
                    </div>
                  );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {children}
    </div>
  );
}

export default JobTimeline;

