import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { CheckCircle, Loader2, Search, Sparkles, X } from 'lucide-react';
import { SubmittedUrlItem } from '../types/ui';
import JobTimeline from './JobTimeline';
import { apiClient } from '../api/client';

type Props = {
  items: SubmittedUrlItem[];
  compareValidJobId?: string | null;
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
  onTriggerJobMatch?: (item: SubmittedUrlItem, opts?: { force?: boolean }) => void | Promise<void>;
  onRerunMatchAnalysis?: (items: SubmittedUrlItem[]) => void | Promise<void>;
  onBatchRescrapePipeline?: (items: SubmittedUrlItem[]) => void | Promise<void>;
  onJobUrlClick?: (item: SubmittedUrlItem) => void;
  onRescrape?: (item: SubmittedUrlItem) => void;
  jobListHasMore?: boolean;
  loadingMoreJobs?: boolean;
  onLoadMoreJobs?: () => void;
  jobsLoadedCount?: number;
};

type AiSearchResponse = {
  matching_job_ids: string[];
  query: { rationale?: string | null };
  total_candidates: number;
};

export function ValidJobsPanel({
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
}: Props) {
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');
  const [aiRationale, setAiRationale] = useState<string | null>(null);
  const [aiFilterSet, setAiFilterSet] = useState<Set<string> | null>(null);
  const [aiMeta, setAiMeta] = useState<{ candidates: number } | null>(null);

  const displayedItems = useMemo(() => {
    if (aiFilterSet === null) return items;
    return items.filter((i) => aiFilterSet.has(i.id));
  }, [items, aiFilterSet]);

  const clearAiFilter = useCallback(() => {
    setAiFilterSet(null);
    setAiRationale(null);
    setAiMeta(null);
    setAiError('');
  }, []);

  const runAiSearch = useCallback(async () => {
    const prompt = aiPrompt.trim();
    if (!prompt) {
      setAiError('Enter a short description of what you’re looking for.');
      return;
    }
    setAiLoading(true);
    setAiError('');
    setAiRationale(null);
    try {
      const res = await apiClient.post<AiSearchResponse>('/jobs/valid/ai-search', { prompt });
      const data = res.data;
      if (!data?.matching_job_ids) {
        setAiError('Unexpected response from AI search.');
        return;
      }
      setAiFilterSet(new Set(data.matching_job_ids));
      setAiRationale(data.query?.rationale?.trim() || null);
      setAiMeta({ candidates: data.total_candidates });
    } catch (err: unknown) {
      const detail =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : undefined;
      setAiError(typeof detail === 'string' ? detail : 'AI search failed. Check OpenAI configuration and try again.');
      setAiFilterSet(null);
      setAiMeta(null);
    } finally {
      setAiLoading(false);
    }
  }, [aiPrompt]);

  const onSearchSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      void runAiSearch();
    },
    [runAiSearch],
  );

  return (
    <div className="glass-card flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-blue-200/60 px-4 py-4 md:bg-white/70 md:px-6 md:py-6">
      <div className="mb-4 shrink-0 md:mb-5">
        <div className="flex flex-wrap items-center gap-2">
          <CheckCircle className="h-6 w-6 shrink-0 text-blue-600" />
          <h2 className="text-2xl font-bold text-slate-900">To do jobs</h2>
        </div>
        <p className="mt-1 text-sm text-slate-500">List of valid job postings to process</p>
        <form onSubmit={onSearchSubmit} className="mt-4 space-y-2">
          <label htmlFor="ai-job-search" className="sr-only">
            AI job search
          </label>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
            <div className="relative min-h-[44px] min-w-0 flex-1">
              <Sparkles className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-indigo-500" />
              <input
                id="ai-job-search"
                type="text"
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                placeholder='e.g. "senior Python remote, match score at least 70"'
                disabled={aiLoading}
                className="blue-outline-input w-full rounded-xl border border-blue-200/80 bg-white/90 py-2.5 pl-10 pr-3 text-sm text-slate-900 placeholder:text-slate-400 outline-none transition focus:border-blue-400 disabled:opacity-60"
                autoComplete="off"
              />
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="submit"
                disabled={aiLoading}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 to-blue-600 px-4 py-2.5 text-sm font-bold text-white shadow-md shadow-blue-500/20 transition hover:from-indigo-500 hover:to-blue-500 disabled:cursor-not-allowed disabled:opacity-60 sm:flex-initial"
              >
                {aiLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                AI search
              </button>
              {aiFilterSet !== null ? (
                <button
                  type="button"
                  onClick={clearAiFilter}
                  className="inline-flex items-center justify-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
                  title="Show all jobs"
                >
                  <X className="h-4 w-4" />
                  <span className="hidden sm:inline">Clear</span>
                </button>
              ) : null}
            </div>
          </div>
          {aiError ? (
            <p className="text-xs font-medium text-rose-600" role="alert">
              {aiError}
            </p>
          ) : null}
          {aiMeta && aiFilterSet !== null ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
              <span className="rounded-full bg-indigo-50 px-2.5 py-1 font-semibold text-indigo-900 ring-1 ring-indigo-100">
                Showing {displayedItems.length} of {items.length} loaded
                {aiMeta.candidates > items.length ? ` (${aiMeta.candidates} on server)` : ''}
              </span>
              {aiRationale ? (
                <span className="max-w-full text-slate-500">
                  <span className="font-semibold text-slate-600">AI: </span>
                  {aiRationale}
                </span>
              ) : null}
            </div>
          ) : null}
        </form>
      </div>

      {/* Timeline with integrated job list */}
      <div className="min-h-0 flex flex-1">
        <JobTimeline
          items={displayedItems}
          openMenuId={openMenuId}
          compareValidJobId={compareValidJobId}
          onToggleMenu={onToggleMenu}
          onEdit={onEdit}
          onReportInvalid={onReportInvalid}
          onReportDuplicate={onReportDuplicate}
          onDelete={onDelete}
          onBatchDelete={onBatchDelete}
          onMarkApplied={onMarkApplied}
          onMarkUnapplied={onMarkUnapplied}
          onOpenSelectedUrls={onOpenSelectedUrls}
          onOpenJobAnalysis={onOpenJobAnalysis}
          onTriggerJobMatch={onTriggerJobMatch}
          onRerunMatchAnalysis={onRerunMatchAnalysis}
          onBatchRescrapePipeline={onBatchRescrapePipeline}
          onJobUrlClick={onJobUrlClick}
          onRescrape={onRescrape}
          jobListHasMore={jobListHasMore}
          loadingMoreJobs={loadingMoreJobs}
          onLoadMoreJobs={onLoadMoreJobs}
          jobsLoadedCount={jobsLoadedCount}
        />
      </div>
    </div>
  );
}
