import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  Check,
  Copy,
  Download,
  Eye,
  FileText,
  FileType2,
  LayoutGrid,
  List,
  Loader2,
  PenLine,
  RefreshCw,
  Search,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { PageTitle } from '@/components/app/PageTitle';
import { ConfirmDialog } from '@/components/extraction/ConfirmDialog';
import { ResumePdfEmbed } from '@/components/resumeBuilder/ResumePdfEmbed';
import { MatchScore } from '@/components/app/MatchScore';
import { relativeTime } from '@/features/integrations/status';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { cn } from '@/lib/utils';
import { useResumeBuilderStore } from '@/stores/resumeBuilderStore';
import { deleteResume } from '@/api/resumeLibraryApi';
import {
  fetchDocuments,
  fetchLibraryJobDescription,
  saveFile,
  searchDocuments,
  type DocumentFileType,
  type DocumentSearchHits,
  type DocumentsResponse,
  type SavedJobDescription,
  type TailorResult,
} from '@/api/documentsApi';
import {
  FILTER_DOT,
  FILTERS,
  ORIGIN_STYLE,
  errorText,
  fetchFile,
  groupByRecency,
  rowStatus,
  toRows,
  type DocRow,
  type Filter,
} from './documentsModel';
import { DocumentGridCard, DocumentListRow, type DocumentActions } from './DocumentItem';
import { TailorComposer } from './TailorComposer';

type ViewMode = 'list' | 'grid';
const VIEW_KEY = 'nao.documents.view';

interface PreviewState {
  row: DocRow;
  fileType: DocumentFileType;
  file: File | null;
  url: string | null;
  error: string | null;
}

function readViewMode(): ViewMode {
  try {
    return localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list';
  } catch {
    return 'list';
  }
}

function HeroStat({ label, value, dot }: { label: string; value: number | string; dot?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-border/60 bg-background/60 px-3 py-2 backdrop-blur-sm">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        {dot && <span className={cn('size-1.5 rounded-full', dot)} />}
        {label}
      </div>
      <div className="mt-0.5 text-lg leading-tight font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export function DocumentsPage() {
  const navigate = useNavigate();
  const reduceMotion = usePrefersReducedMotion();
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [data, setData] = useState<DocumentsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [view, setView] = useState<ViewMode>(readViewMode);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DocRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [justMade, setJustMade] = useState<{ id: string; score: number | null } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await fetchDocuments());
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err, 'Could not load your documents.'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const changeView = (next: ViewMode) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* storage unavailable: keep the in-memory choice */
    }
  };

  const rows = useMemo(() => (data ? toRows(data) : []), [data]);
  const workingCount = rows.filter((r) => rowStatus(r) === 'working').length;
  useEffect(() => {
    if (workingCount === 0) return;
    const t = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(t);
  }, [workingCount, load]);

  useEffect(
    () => () => {
      if (preview?.url) URL.revokeObjectURL(preview.url);
    },
    [preview?.url],
  );

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: rows.length, jobs: 0, tailored: 0, mine: 0 };
    rows.forEach((r) => {
      c[r.origin] += 1;
    });
    return c;
  }, [rows]);
  const lettersCount = rows.filter((r) => r.files.cover_letter_pdf === 'ready').length;

  const [hits, setHits] = useState<{ q: string; ids: Set<string> } | null>(null);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits(null);
      return;
    }
    const controller = new AbortController();
    const t = window.setTimeout(() => {
      searchDocuments(q, controller.signal)
        .then((res: DocumentSearchHits) =>
          setHits({ q, ids: new Set([...res.library_ids.map((id) => `lib-${id}`), ...res.build_ids.map((id) => `build-${id}`)]) }),
        )
        .catch(() => undefined);
    }, 250);
    return () => {
      window.clearTimeout(t);
      controller.abort();
    };
  }, [query]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const serverIds = hits && hits.q.toLowerCase() === q ? hits.ids : null;
    return rows.filter(
      (r) =>
        (filter === 'all' || r.origin === filter) &&
        (!q || `${r.title} ${r.subtitle ?? ''}`.toLowerCase().includes(q) || !!serverIds?.has(r.key)),
    );
  }, [rows, filter, query, hits]);
  const groups = useMemo(() => groupByRecency(visible), [visible]);

  const [searchParams, setSearchParams] = useSearchParams();
  const [posting, setPosting] = useState<{ title: string; data: SavedJobDescription | null; error: string | null } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
  const openPosting = useCallback(async (id: string, title: string) => {
    setCopied(false);
    setPosting({ title, data: null, error: null });
    try {
      const data = await fetchLibraryJobDescription(id);
      setPosting((p) => (p ? { ...p, data } : p));
    } catch (err) {
      setPosting((p) => (p ? { ...p, error: errorText(err, 'Could not load the job description.') } : p));
    }
  }, []);
  const postingParam = searchParams.get('posting');
  useEffect(() => {
    if (!postingParam || !data) return;
    const row = rows.find((r) => r.kind === 'library' && r.id === postingParam);
    void openPosting(postingParam, row?.title ?? 'Job description');
    setSearchParams(
      (p) => {
        p.delete('posting');
        return p;
      },
      { replace: true },
    );
  }, [postingParam, data, rows, openPosting, setSearchParams]);

  const onDownload = async (row: DocRow, fileType: DocumentFileType) => {
    setBusyKey(row.key);
    setActionError(null);
    try {
      saveFile(await fetchFile(row, fileType));
    } catch (err) {
      setActionError(errorText(err, 'Could not download that file.'));
    } finally {
      setBusyKey(null);
    }
  };

  const onPreview = async (row: DocRow, fileType: DocumentFileType) => {
    setPreview({ row, fileType, file: null, url: null, error: null });
    try {
      const file = await fetchFile(row, fileType);
      setPreview((p) =>
        p && p.row.key === row.key && p.fileType === fileType ? { ...p, file, url: URL.createObjectURL(file) } : p,
      );
    } catch (err) {
      setPreview((p) => (p ? { ...p, error: errorText(err, 'Could not open the preview.') } : p));
    }
  };

  const onOpen = async (row: DocRow) => {
    setBusyKey(row.key);
    const s = useResumeBuilderStore.getState();
    if (row.kind === 'library') await s.switchResume(row.id);
    else await s.openJobBuild(row.id);
    setBusyKey(null);
    navigate('/app/studio');
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteResume(pendingDelete.id);
      setPendingDelete(null);
      await load();
      void useResumeBuilderStore.getState().loadResumes();
    } catch (err) {
      setActionError(errorText(err, 'Could not delete that resume.'));
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  };

  const onTailored = async (result: TailorResult) => {
    await load();
    if (result.resume) {
      setFilter('all');
      setQuery('');
      const score = typeof result.match?.score === 'number' ? Math.round(result.match.score) : null;
      setJustMade({ id: result.resume.id, score });
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const focusComposer = () => {
    composerRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
    composerRef.current?.focus({ preventScroll: true });
  };

  const actions: DocumentActions = {
    onPreview: (r, t) => void onPreview(r, t),
    onDownload: (r, t) => void onDownload(r, t),
    onOpen: (r) => void onOpen(r),
    onDelete: setPendingDelete,
    onViewPosting: (r) => void openPosting(r.id, r.title),
  };

  const justMadeRow = justMade ? rows.find((r) => r.kind === 'library' && r.id === justMade.id) ?? null : null;
  const previewIsLetter = preview?.fileType.startsWith('cover') ?? false;
  const previewHasLetter = preview?.row.files.cover_letter_pdf === 'ready';
  const order = new Map(groups.flatMap((g) => g.rows).map((r, i) => [r.key, i]));
  const itemStyle = (key: string) =>
    reduceMotion ? undefined : { animationDelay: `${Math.min(order.get(key) ?? 0, 12) * 35}ms` };

  return (
    <div className="docs-page relative isolate flex min-h-0 flex-1 flex-col overflow-hidden">
      <div aria-hidden className={cn('docs-backdrop pointer-events-none absolute inset-0 -z-10', !reduceMotion && 'docs-backdrop--motion')}>
        <span className="docs-backdrop__glow docs-backdrop__glow--a" />
        <span className="docs-backdrop__glow docs-backdrop__glow--b" />
        <span className="docs-backdrop__glow docs-backdrop__glow--c" />
        <span className="docs-backdrop__grid" />
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
        <PageTitle title="Documents" />
        <div className="mx-auto w-full max-w-6xl space-y-6 px-4 pt-6 pb-24 sm:px-6">
          <header
            className={cn(
              'jobs-hero relative isolate overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xs',
              !reduceMotion && 'jobs-hero--motion',
            )}
          >
            <div aria-hidden className="jobs-hero__aurora pointer-events-none absolute inset-0 -z-10">
              <span className="jobs-hero__blob jobs-hero__blob--a" />
              <span className="jobs-hero__blob jobs-hero__blob--b" />
              <span className="jobs-hero__blob jobs-hero__blob--c" />
              <span className="jobs-hero__blob jobs-hero__blob--d" />
              <span className="jobs-hero__sheen" />
              <span className="jobs-hero__veil" />
            </div>
            <div className="relative flex flex-col gap-4 px-5 py-5 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className="text-2xl font-semibold tracking-tight">Documents</h1>
                  {workingCount > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-semibold text-brand">
                      <Loader2 className="size-3 animate-spin" />
                      {workingCount} generating
                    </span>
                  )}
                </div>
                <p className="mt-1 max-w-xl text-sm text-muted-foreground">
                  Every resume and cover letter NAO has made for you, ready to preview, download or refine.
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={focusComposer}
                    className="docs-composer__cta group inline-flex h-9 items-center gap-2 rounded-full px-4 text-sm font-semibold text-white shadow-md transition-all outline-none hover:-translate-y-px hover:shadow-lg focus-visible:ring-4 focus-visible:ring-brand/25"
                  >
                    <Wand2 className="size-4 transition-transform group-hover:rotate-12" />
                    Tailor new
                  </button>
                  <Button variant="outline" className="rounded-full bg-background/70 backdrop-blur" nativeButton={false} render={<Link to="/app/studio" />}>
                    <PenLine />
                    Resume studio
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:w-[30rem]">
                <HeroStat label="Documents" value={data ? counts.all : '-'} />
                <HeroStat label="From jobs" value={data ? counts.jobs : '-'} dot={ORIGIN_STYLE.jobs.accent} />
                <HeroStat label="Tailored" value={data ? counts.tailored : '-'} dot={ORIGIN_STYLE.tailored.accent} />
                <HeroStat label="Cover letters" value={data ? lettersCount : '-'} dot="bg-amber-500" />
              </div>
            </div>
          </header>

          <TailorComposer ref={composerRef} onDone={(r) => void onTailored(r)} />

          {justMadeRow && (
            <div className="docs-item flex flex-wrap items-center gap-3 rounded-2xl border border-status-ready/30 bg-gradient-to-r from-status-ready/15 via-status-ready/5 to-transparent px-4 py-3 shadow-xs">
              <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-status-ready/20 text-emerald-700 dark:text-emerald-300">
                <Check className="size-4" />
              </span>
              <p className="min-w-0 flex-1 text-sm">
                <span className="font-semibold">{justMadeRow.title}</span> is ready
                {justMade?.score != null ? `, match score ${justMade.score}` : ''}.
              </p>
              <Button size="sm" variant="outline" onClick={() => void onPreview(justMadeRow, 'resume_pdf')}>
                <Eye />
                Preview
              </Button>
              <Button size="sm" onClick={() => void onOpen(justMadeRow)}>
                <PenLine />
                Edit in studio
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label="Dismiss" onClick={() => setJustMade(null)}>
                <X />
              </Button>
            </div>
          )}

          <section aria-label="Generated documents" className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold tracking-tight">Library</h2>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Job applications, tailored resumes and your own. PDFs match the studio exactly.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 rounded-2xl border bg-card/80 p-2 shadow-xs backdrop-blur-sm">
              <div className="scrollbar-thin -m-0.5 max-w-full overflow-x-auto p-0.5">
                <div role="tablist" aria-label="Filter documents" className="inline-flex min-w-max gap-1 rounded-xl bg-muted/70 p-1">
                  {FILTERS.map((f) => {
                    const active = filter === f.id;
                    return (
                      <button
                        key={f.id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => setFilter(f.id)}
                        className={cn(
                          'inline-flex h-8 items-center gap-2 rounded-lg px-3 text-sm transition-all outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                          active
                            ? 'bg-card font-semibold text-foreground shadow-sm ring-1 ring-border'
                            : 'font-medium text-muted-foreground hover:bg-background/70 hover:text-foreground',
                        )}
                      >
                        <span aria-hidden className={cn('size-2 rounded-full', FILTER_DOT[f.id], !active && 'opacity-70')} />
                        {f.label}
                        <span
                          className={cn(
                            'min-w-6 rounded-md px-1.5 py-px text-center text-xs font-semibold tabular-nums',
                            active ? 'bg-foreground/[0.07] text-foreground' : 'text-muted-foreground',
                          )}
                        >
                          {counts[f.id]}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="ml-auto flex w-full items-center gap-2 sm:w-auto">
                <InputGroup className="h-9 flex-1 rounded-xl sm:w-72 sm:flex-none">
                  <InputGroupAddon>
                    <Search />
                  </InputGroupAddon>
                  <InputGroupInput
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape' && query) {
                        e.stopPropagation();
                        setQuery('');
                      }
                    }}
                    placeholder="Search role, company or job text"
                    aria-label="Search documents"
                  />
                </InputGroup>
                <div role="group" aria-label="Layout" className="inline-flex shrink-0 rounded-xl bg-muted/70 p-1">
                  {(
                    [
                      { id: 'list', icon: List, label: 'List view' },
                      { id: 'grid', icon: LayoutGrid, label: 'Grid view' },
                    ] as const
                  ).map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      aria-label={v.label}
                      aria-pressed={view === v.id}
                      title={v.label}
                      onClick={() => changeView(v.id)}
                      className={cn(
                        'inline-flex size-7 items-center justify-center rounded-lg transition outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                        view === v.id ? 'bg-card text-foreground shadow-sm ring-1 ring-border' : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <v.icon className="size-4" />
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  aria-label="Refresh documents"
                  title="Refresh"
                  onClick={() => void refresh()}
                  className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
                </button>
              </div>
            </div>

            {actionError && (
              <p className="flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-2.5 text-sm text-destructive">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <span className="flex-1">{actionError}</span>
                <button type="button" aria-label="Dismiss error" onClick={() => setActionError(null)} className="rounded p-0.5 hover:bg-destructive/10">
                  <X className="size-3.5" />
                </button>
              </p>
            )}

            {!data && !loadError ? (
              view === 'grid' ? (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="overflow-hidden rounded-2xl border bg-card/80">
                      <Skeleton className="h-36 rounded-none" />
                      <div className="space-y-2 p-4">
                        <Skeleton className="h-3.5 w-3/4" />
                        <Skeleton className="h-3 w-1/2" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="divide-y overflow-hidden rounded-2xl border bg-card/80">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="flex items-center gap-3 px-5 py-4">
                      <Skeleton className="size-10 rounded-xl" />
                      <div className="flex-1 space-y-2">
                        <Skeleton className="h-3.5 w-48" />
                        <Skeleton className="h-3 w-32" />
                      </div>
                      <Skeleton className="h-8 w-24 rounded-lg" />
                    </div>
                  ))}
                </div>
              )
            ) : loadError ? (
              <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-destructive/20 bg-destructive/5 px-5 py-4 text-sm text-destructive">
                <AlertCircle className="size-4" />
                <span className="flex-1">{loadError}</span>
                <Button size="sm" variant="outline" onClick={() => void load()}>
                  Retry
                </Button>
              </div>
            ) : visible.length === 0 ? (
              <div className="flex flex-col items-center rounded-2xl border border-dashed bg-card/60 px-6 py-14 text-center backdrop-blur-sm">
                <div className="relative mb-4">
                  <span className="absolute -inset-3 rounded-full bg-brand/10 blur-xl" aria-hidden />
                  <span className="relative inline-flex size-14 items-center justify-center rounded-2xl border bg-card text-brand shadow-sm">
                    {rows.length === 0 ? <FileText className="size-6" /> : <Search className="size-6" />}
                  </span>
                </div>
                <h3 className="text-base font-semibold">{rows.length === 0 ? 'No documents yet' : 'Nothing matches'}</h3>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                  {rows.length === 0
                    ? 'Tailor a resume above, or prepare a job from the Jobs page to generate one.'
                    : 'Try another filter or search.'}
                </p>
                <div className="mt-5 flex flex-wrap justify-center gap-2">
                  {rows.length === 0 ? (
                    <>
                      <Button onClick={focusComposer}>
                        <Sparkles />
                        Tailor a resume
                      </Button>
                      <Button variant="outline" nativeButton={false} render={<Link to="/app/jobs" />}>
                        Browse jobs
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setQuery('');
                        setFilter('all');
                      }}
                    >
                      Clear filters
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-5">
                {groups.map((group) => (
                  <div key={group.label} className="space-y-2.5">
                    <div className="flex items-center gap-3 px-1">
                      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{group.label}</h3>
                      <span className="rounded-full bg-muted px-1.5 text-[11px] font-semibold text-muted-foreground tabular-nums">
                        {group.rows.length}
                      </span>
                      <span className="h-px flex-1 bg-gradient-to-r from-border to-transparent" />
                    </div>
                    {view === 'grid' ? (
                      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {group.rows.map((row) => (
                          <DocumentGridCard key={row.key} row={row} busy={busyKey === row.key} style={itemStyle(row.key)} {...actions} />
                        ))}
                      </ul>
                    ) : (
                      <ul className="divide-y overflow-hidden rounded-2xl border bg-card/85 shadow-xs backdrop-blur-sm">
                        {group.rows.map((row) => (
                          <DocumentListRow key={row.key} row={row} busy={busyKey === row.key} style={itemStyle(row.key)} {...actions} />
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      <Dialog open={preview != null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="flex h-[min(92dvh,1000px)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-b bg-card/95 py-2.5 pr-12 pl-4 backdrop-blur">
            <span
              className={cn(
                'inline-flex size-8 shrink-0 items-center justify-center rounded-lg ring-1',
                preview ? ORIGIN_STYLE[preview.row.origin].chip : '',
              )}
            >
              {previewIsLetter ? <FileText className="size-4" /> : <FileType2 className="size-4" />}
            </span>
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate text-sm font-semibold">
                {preview ? `${previewIsLetter ? 'Cover letter' : 'Resume'}: ${preview.row.title}` : ''}
              </DialogTitle>
              {preview?.row.subtitle && <p className="truncate text-xs text-muted-foreground">{preview.row.subtitle}</p>}
            </div>
            {preview && previewHasLetter && (
              <div role="tablist" aria-label="Document" className="inline-flex rounded-lg bg-muted p-0.5">
                {(
                  [
                    { id: 'resume_pdf', label: 'Resume' },
                    { id: 'cover_letter_pdf', label: 'Cover letter' },
                  ] as const
                ).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={preview.fileType === t.id}
                    onClick={() => preview.fileType !== t.id && void onPreview(preview.row, t.id)}
                    className={cn(
                      'rounded-md px-2.5 py-1 text-xs font-medium transition',
                      preview.fileType === t.id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}
            {preview && (
              <Button
                size="sm"
                variant="ghost"
                disabled={preview.row.files[previewIsLetter ? 'cover_letter_docx' : 'resume_docx'] !== 'ready'}
                onClick={() => void onDownload(preview.row, previewIsLetter ? 'cover_letter_docx' : 'resume_docx')}
              >
                <FileType2 />
                Word
              </Button>
            )}
            {preview?.file && (
              <Button size="sm" onClick={() => preview.file && saveFile(preview.file)}>
                <Download />
                Download
              </Button>
            )}
          </div>
          <div className="docs-preview-stage min-h-0 flex-1">
            {preview?.error ? (
              <p className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive">{preview.error}</p>
            ) : preview?.url ? (
              <ResumePdfEmbed url={preview.url} title={preview.file?.name} />
            ) : (
              <div className="flex h-full items-center justify-center p-8">
                <div className="w-full max-w-md space-y-3 rounded-xl border bg-card p-8 shadow-sm">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-3 w-1/3" />
                  <Skeleton className="mt-6 h-2.5 w-full" />
                  <Skeleton className="h-2.5 w-11/12" />
                  <Skeleton className="h-2.5 w-4/5" />
                  <p className="flex items-center justify-center gap-2 pt-4 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin text-brand" />
                    Opening…
                  </p>
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={posting != null} onOpenChange={(open) => !open && setPosting(null)}>
        <DialogContent className="flex max-h-[min(88dvh,900px)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
          <div className="shrink-0 border-b bg-gradient-to-b from-brand-soft/60 to-transparent py-4 pr-12 pl-5">
            <p className="text-[11px] font-semibold tracking-wide text-brand uppercase">Job description</p>
            <DialogTitle className="mt-0.5 truncate text-base font-semibold">{posting?.title}</DialogTitle>
            {posting?.data ? (
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                {[posting.data.company, posting.data.created_at ? `Tailored ${relativeTime(posting.data.created_at)}` : null]
                  .filter(Boolean)
                  .join(' · ')}
                {posting.data.match_score != null && <MatchScore score={posting.data.match_score} />}
              </p>
            ) : null}
          </div>
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {posting?.error ? (
              <p className="text-sm text-destructive">{posting.error}</p>
            ) : posting?.data ? (
              <p className="text-sm leading-relaxed whitespace-pre-wrap">
                {posting.data.job_description || 'No job description was saved with this resume.'}
              </p>
            ) : (
              <div className="space-y-2.5">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-11/12" />
                <Skeleton className="h-3 w-4/5" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            )}
          </div>
          {posting?.data?.job_description ? (
            <div className="flex shrink-0 justify-end border-t px-5 py-2.5">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard?.writeText(posting.data?.job_description ?? '').then(() => setCopied(true));
                }}
              >
                {copied ? <Check /> : <Copy />}
                {copied ? 'Copied' : 'Copy text'}
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={pendingDelete != null}
        title="Delete this resume?"
        description={
          <>
            <span className="font-semibold text-foreground">{pendingDelete?.title}</span> and any cover letter saved with it will be
            removed. This can&apos;t be undone.
          </>
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        loading={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
