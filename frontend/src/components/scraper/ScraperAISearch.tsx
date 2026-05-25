import {
  useCallback,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import {
  Sparkles,
  Search,
  X,
  Loader2,
  ChevronDown,
  ChevronUp,
  Info,
} from 'lucide-react';
import type { DashboardJob } from '../../types/scraper';
import { scraperAiSearch } from '../../api/scraperApi';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AiSearchState {
  active: boolean;
  results: DashboardJob[];
  total: number;
  rationale: string | null;
}

interface Props {
  onResults: (state: AiSearchState) => void;
  onClear: () => void;
  isActive: boolean;
  resultCount?: number;
  totalMatching?: number;
  rationale?: string | null;
}

// ---------------------------------------------------------------------------
// Example prompts — illustrate edge-case capabilities
// ---------------------------------------------------------------------------

const EXAMPLES = [
  'Remote Python senior jobs with match score above 70',
  'Adzuna jobs scraped in the last 3 days',
  'Contract React or Vue positions paying over $120k',
  'Jobs I have a high score on but no resume yet',
  'Full-stack roles in NYC or SF posted this month',
  'Unprocessed DevOps jobs (not yet extracted)',
  'Jobs at startups with weak match recommendation',
  'Junior frontend roles — entry level',
  'Healthcare or fintech jobs fully extracted',
  'Part-time or freelance positions paying $80k+',
];

// ---------------------------------------------------------------------------
// Filter tag builder — show which filters are active
// ---------------------------------------------------------------------------

type FilterTag = { label: string; color: string };

function buildFilterTags(query: Record<string, unknown>): FilterTag[] {
  const tags: FilterTag[] = [];

  const push = (label: string, color: string) => tags.push({ label, color });

  if (query.is_remote === true) push('Remote only', 'emerald');
  if (query.is_remote === false) push('On-site only', 'orange');

  const expLevels = query.experience_level_any as string[] | undefined;
  if (expLevels?.length) push(expLevels.join(' / '), 'violet');

  const sources = query.source_any as string[] | undefined;
  if (sources?.length) push(`Source: ${sources.join(', ')}`, 'sky');

  const jobTypes = query.job_type_any as string[] | undefined;
  if (jobTypes?.length) push(jobTypes.join(', '), 'amber');

  const min = query.min_match_score as number | null | undefined;
  const max = query.max_match_score as number | null | undefined;
  if (min != null && max != null) push(`Score ${min}–${max}`, 'indigo');
  else if (min != null) push(`Score ≥ ${min}`, 'indigo');
  else if (max != null) push(`Score ≤ ${max}`, 'indigo');

  const minSal = query.min_salary_k as number | null | undefined;
  const maxSal = query.max_salary_k as number | null | undefined;
  if (minSal != null) push(`$${minSal}k+`, 'green');
  else if (maxSal != null) push(`Up to $${maxSal}k`, 'green');

  if (query.extraction_completed_only) push('Fully extracted', 'teal');
  if (query.has_extraction === false) push('Not yet extracted', 'rose');
  if (query.has_match_score === true) push('Has score', 'blue');
  if (query.has_match_score === false) push('No score yet', 'yellow');
  if (query.has_resume === true) push('Resume built', 'cyan');
  if (query.has_resume === false) push('No resume', 'slate');

  const postedDays = query.posted_within_days as number | null | undefined;
  if (postedDays != null) push(`Posted ≤${postedDays}d ago`, 'purple');

  const scrapedDays = query.scraped_within_days as number | null | undefined;
  if (scrapedDays != null) push(`Scraped ≤${scrapedDays}d ago`, 'pink');

  const sortBy = query.sort_by as string | undefined;
  if (sortBy === 'match_score') push('Sorted by score', 'indigo');
  else if (sortBy === 'posted_at') push('Sorted by post date', 'slate');

  return tags;
}

const TAG_BG: Record<string, string> = {
  emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  orange:  'bg-orange-50  text-orange-700  ring-orange-200',
  violet:  'bg-violet-50  text-violet-700  ring-violet-200',
  sky:     'bg-sky-50     text-sky-700     ring-sky-200',
  amber:   'bg-amber-50   text-amber-700   ring-amber-200',
  indigo:  'bg-indigo-50  text-indigo-700  ring-indigo-200',
  green:   'bg-green-50   text-green-700   ring-green-200',
  teal:    'bg-teal-50    text-teal-700    ring-teal-200',
  rose:    'bg-rose-50    text-rose-700    ring-rose-200',
  blue:    'bg-blue-50    text-blue-700    ring-blue-200',
  yellow:  'bg-yellow-50  text-yellow-700  ring-yellow-200',
  cyan:    'bg-cyan-50    text-cyan-700    ring-cyan-200',
  slate:   'bg-slate-100  text-slate-600   ring-slate-200',
  purple:  'bg-purple-50  text-purple-700  ring-purple-200',
  pink:    'bg-pink-50    text-pink-700    ring-pink-200',
};

function FilterTag({ label, color }: FilterTag) {
  const cls = TAG_BG[color] ?? TAG_BG.slate;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium ring-1 ${cls}`}>
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ScraperAISearch({
  onResults,
  onClear,
  isActive,
  resultCount = 0,
  totalMatching = 0,
  rationale,
}: Props) {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showExamples, setShowExamples] = useState(false);
  const [activeQuery, setActiveQuery] = useState<Record<string, unknown> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const runSearch = useCallback(async (searchPrompt: string) => {
    const p = searchPrompt.trim();
    if (!p) {
      setError('Enter a search request to continue.');
      inputRef.current?.focus();
      return;
    }
    setLoading(true);
    setError('');
    setActiveQuery(null);

    try {
      const data = await scraperAiSearch(p);
      setActiveQuery(data.query);
      const mapped: DashboardJob[] = data.matching_jobs.map((raw) => ({
        id: String(raw.id ?? ''),
        source_url: String(raw.source_url ?? ''),
        normalized_url: String(raw.normalized_url ?? ''),
        domain: String(raw.domain ?? ''),
        title: raw.title != null ? String(raw.title) : null,
        company: String(raw.company ?? ''),
        location: raw.location != null ? String(raw.location) : null,
        description: raw.description != null ? String(raw.description) : null,
        posted_date: raw.posted_date != null ? String(raw.posted_date) : null,
        experience_level: raw.experience_level != null ? String(raw.experience_level) : null,
        industry: raw.industry != null ? String(raw.industry) : null,
        status: String(raw.status ?? 'active'),
        created_at: String(raw.created_at ?? ''),
        updated_at: String(raw.updated_at ?? ''),
        extraction_id: raw.extraction_id != null ? String(raw.extraction_id) : null,
        extraction_status: (raw.extraction_status as DashboardJob['extraction_status']) ?? null,
        is_job_posting: raw.is_job_posting != null ? Boolean(raw.is_job_posting) : null,
        match_overall_score: raw.match_overall_score != null ? Number(raw.match_overall_score) : null,
        match_in_progress: raw.match_status === 'processing',
        resume_build_status: null,
        content_generation_status: null,
        resume_pdf_status: null,
        resume_pdf_path: null,
        cover_letter_pdf_status: null,
        cover_letter_pdf_path: null,
        applied_at: raw.applied_at != null ? String(raw.applied_at) : null,
        applied_by_name: raw.applied_by_name != null ? String(raw.applied_by_name) : null,
        user_status: null,
        source: null,
        is_remote: false,
        salary_raw: null,
        job_type: null,
      }));
      onResults({
        active: true,
        results: mapped,
        total: data.total_matching,
        rationale: data.query.rationale?.trim() ?? null,
      });
    } catch (err: unknown) {
      const detail =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : undefined;
      setError(
        typeof detail === 'string'
          ? detail
          : 'AI search failed. Check that OpenAI is configured and try again.',
      );
    } finally {
      setLoading(false);
    }
  }, [onResults]);

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      void runSearch(prompt);
    },
    [prompt, runSearch],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape' && isActive) {
        handleClear();
      }
    },
    [isActive], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const handleClear = useCallback(() => {
    setPrompt('');
    setError('');
    setActiveQuery(null);
    onClear();
  }, [onClear]);

  const useExample = useCallback(
    (ex: string) => {
      setPrompt(ex);
      setShowExamples(false);
      void runSearch(ex);
    },
    [runSearch],
  );

  const filterTags = activeQuery ? buildFilterTags(activeQuery) : [];

  return (
    <div className="glass-card min-w-0 rounded-2xl p-5 flex flex-col gap-4">
      {/* ── Search form ─────────────────────────────────────────────────── */}
      <form onSubmit={handleSubmit} className="flex min-w-0 flex-col gap-0 sm:flex-row sm:items-stretch">
        {/* Input — matches SubmitForm's input wrapper */}
        <div className="flex min-h-11 min-w-0 flex-1 overflow-hidden rounded-t-lg border border-[rgba(147,197,253,0.8)] bg-[rgba(255,255,255,0.92)] shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] transition-[border-color,box-shadow,background-color] duration-[180ms] focus-within:border-[rgba(59,130,246,0.95)] focus-within:bg-white focus-within:shadow-[0_0_0_3px_rgba(59,130,246,0.2),inset_0_1px_0_rgba(255,255,255,0.85)] sm:rounded-l-lg sm:rounded-r-none">
          <div className="flex w-11 shrink-0 items-center justify-center border-r border-[rgba(147,197,253,0.65)] bg-gradient-to-b from-white to-slate-50/90 text-slate-400">
            <Sparkles className="h-4 w-4" strokeWidth={2} aria-hidden />
          </div>
          <input
            ref={inputRef}
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="e.g. Remote Python jobs, score ≥ 70, posted this month…"
            disabled={loading}
            autoComplete="off"
            className="min-w-0 flex-1 border-0 bg-transparent py-2.5 pl-2 pr-3 text-sm text-slate-900 outline-none ring-0 placeholder:text-slate-500 focus:ring-0 disabled:cursor-not-allowed disabled:opacity-60"
          />
          {/* Examples toggle — inside the input row */}
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setShowExamples((v) => !v)}
            title="Show example searches"
            className="flex w-9 shrink-0 items-center justify-center border-l border-[rgba(147,197,253,0.65)] bg-gradient-to-b from-white to-slate-50/90 text-slate-400 transition-colors hover:bg-blue-50/80 hover:text-blue-600 focus-visible:outline-none"
          >
            <Info className="h-4 w-4" strokeWidth={2} aria-hidden />
          </button>
        </div>

        {/* Submit button — matches SubmitForm's send button */}
        <div className="flex shrink-0 gap-1.5">
          <button
            type="submit"
            disabled={loading}
            className="btn-blue-neon inline-flex h-11 w-full items-center justify-center gap-1.5 rounded-b-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:cursor-not-allowed disabled:opacity-70 sm:w-auto sm:min-w-[4.25rem] sm:rounded-l-none sm:rounded-r-lg sm:px-4"
          >
            {loading
              ? <Loader2 className="h-5 w-5 shrink-0 animate-spin" strokeWidth={2.25} aria-hidden />
              : <Search className="h-5 w-5 shrink-0" strokeWidth={2.25} aria-hidden />}
          </button>

          {isActive && (
            <button
              type="button"
              onClick={handleClear}
              title="Clear search and show all jobs"
              className="inline-flex h-11 items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 shadow-sm transition hover:bg-slate-50 sm:rounded-lg"
            >
              <X className="h-4 w-4" strokeWidth={2.25} />
              Clear
            </button>
          )}
        </div>
      </form>

      {/* Error */}
      {error && (
        <p className="text-xs font-medium text-rose-600" role="alert">{error}</p>
      )}

      {/* ── Example prompts ──────────────────────────────────────────────── */}
      {showExamples && (
        <div className="rounded-lg border border-[rgba(147,197,253,0.5)] bg-white/80 px-3 py-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Example searches — click to run
          </p>
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => useExample(ex)}
                className="rounded-full border border-indigo-100 bg-indigo-50 px-2.5 py-1 text-[11px] font-medium text-indigo-700 transition hover:bg-indigo-100"
              >
                {ex}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Results summary ──────────────────────────────────────────────── */}
      {isActive && (
        <div className="flex flex-wrap items-center gap-2">
          {/* Count pill */}
          <span className="rounded-full bg-indigo-100 px-2.5 py-0.5 text-[11px] font-bold text-indigo-900 ring-1 ring-indigo-200">
            {resultCount} result{resultCount !== 1 ? 's' : ''}
            {totalMatching > resultCount ? ` (${totalMatching} total, showing first ${resultCount})` : ''}
          </span>

          {/* Rationale */}
          {rationale && (
            <span className="text-[11px] text-slate-500">
              <span className="font-semibold text-slate-600">AI: </span>
              {rationale}
            </span>
          )}

          {/* Active filter tags */}
          {filterTags.map((tag) => (
            <FilterTag key={tag.label} {...tag} />
          ))}
        </div>
      )}
    </div>
  );
}
