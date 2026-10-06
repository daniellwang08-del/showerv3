import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  Briefcase,
  Check,
  Download,
  Eye,
  FileText,
  FileType2,
  Loader2,
  Mail,
  MoreHorizontal,
  PenLine,
  ScrollText,
  Search,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { PageLayout, SectionCard } from '@/components/app/PageLayout';
import { ConfirmDialog } from '@/components/extraction/ConfirmDialog';
import { ResumePdfEmbed } from '@/components/resumeBuilder/ResumePdfEmbed';
import { MatchScore } from '@/components/app/MatchScore';
import { relativeTime } from '@/features/integrations/status';
import { cn } from '@/lib/utils';
import { useResumeBuilderStore } from '@/stores/resumeBuilderStore';
import { deleteResume } from '@/api/resumeLibraryApi';
import {
  fetchDocuments,
  fetchJobBuildDocument,
  fetchLibraryDocument,
  fetchLibraryJobDescription,
  saveFile,
  searchDocuments,
  tailorFromJobDescription,
  type DocumentFileType,
  type DocumentSearchHits,
  type DocumentsResponse,
  type JobBuildDocument,
  type LibraryDocument,
  type SavedJobDescription,
  type TailorResult,
} from '@/api/documentsApi';

type Filter = 'all' | 'jobs' | 'tailored' | 'mine';
type FileState = 'ready' | 'working' | 'failed' | 'none';

interface DocRow {
  key: string;
  kind: 'library' | 'build';
  id: string;
  jobId: string | null;
  title: string;
  subtitle: string | null;
  origin: Filter;
  updatedAt: string | null;
  isActive: boolean;
  note: string | null;
  files: Record<DocumentFileType, FileState>;
  hasPosting: boolean;
  matchScore: number | null;
  fromChat: boolean;
}

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'jobs', label: 'From jobs' },
  { id: 'tailored', label: 'Tailored' },
  { id: 'mine', label: 'My resumes' },
];

const ORIGIN_LABEL: Record<Exclude<Filter, 'all'>, string> = {
  jobs: 'Job application',
  tailored: 'Tailored',
  mine: 'Resume',
};

const STAGES = [
  { id: 'analyzing', label: 'Reading the job' },
  { id: 'evidence', label: 'Finding proof' },
  { id: 'tailoring', label: 'Writing' },
  { id: 'saving', label: 'Saving' },
];
/** Finer server stages shown under the nearest step above. */
const STAGE_ALIAS: Record<string, string> = { reading: 'analyzing', quality: 'tailoring' };

function buildFileState(status: string | undefined): FileState {
  if (status === 'completed') return 'ready';
  if (status === 'failed') return 'failed';
  if (status === 'processing' || status === 'pending') return 'working';
  return 'none';
}

function toRows(data: DocumentsResponse): DocRow[] {
  const library: DocRow[] = data.library.map((d: LibraryDocument) => {
    const title = d.job_title || d.name;
    return {
      key: `lib-${d.id}`,
      kind: 'library',
      id: d.id,
      jobId: null,
      title,
      subtitle: d.company || (d.job_title && d.name !== title ? d.name : null),
      origin: d.source === 'tailored' ? 'tailored' : 'mine',
      updatedAt: d.updated_at,
      isActive: d.is_active,
      note: null,
      files: {
        resume_pdf: 'ready',
        resume_docx: 'ready',
        cover_letter_pdf: d.has_cover_letter ? 'ready' : 'none',
        cover_letter_docx: d.has_cover_letter ? 'ready' : 'none',
      },
      hasPosting: !!d.has_job_description,
      matchScore: typeof d.match_score === 'number' ? d.match_score : null,
      fromChat: d.origin === 'assistant',
    };
  });
  const builds: DocRow[] = data.builds.map((b: JobBuildDocument) => {
    const contentReady = b.content_status === 'completed';
    const contentFailed = b.content_status === 'failed';
    const files = Object.fromEntries(
      (Object.keys(b.files) as DocumentFileType[]).map((k) => [
        k,
        contentFailed ? 'failed' : contentReady ? buildFileState(b.files[k]) : 'working',
      ]),
    ) as Record<DocumentFileType, FileState>;
    return {
      key: `build-${b.id}`,
      kind: 'build',
      id: b.id,
      jobId: b.job_id,
      title: b.job_title || 'Job application',
      subtitle: b.company,
      origin: 'jobs',
      updatedAt: b.updated_at,
      isActive: false,
      note: contentFailed ? b.content_error || 'Content generation failed.' : null,
      files,
      hasPosting: false,
      matchScore: null,
      fromChat: false,
    };
  });
  return [...library, ...builds].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

async function fetchFile(row: DocRow, fileType: DocumentFileType): Promise<File> {
  return row.kind === 'library'
    ? fetchLibraryDocument(row.id, fileType)
    : fetchJobBuildDocument(row.jobId ?? '', fileType);
}

function errorText(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { detail?: string } }; message?: string };
  return e?.response?.data?.detail || fallback;
}

/* ------------------------------------------------------------------------- */

function TailorComposer({ onDone }: { onDone: (result: TailorResult) => void }) {
  const [jd, setJd] = useState('');
  const [instructions, setInstructions] = useState('');
  const [showInstructions, setShowInstructions] = useState(false);
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = async () => {
    const text = jd.trim();
    if (text.length < 40 || running) {
      setError(text ? 'Paste the full job description (at least a few sentences).' : null);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setError(null);
    setStage('analyzing');
    try {
      const result = await tailorFromJobDescription(
        text,
        instructions.trim(),
        (ev) => setStage(STAGE_ALIAS[ev.stage] ?? ev.stage),
        controller.signal,
      );
      setJd('');
      setInstructions('');
      onDone(result);
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Tailoring failed. Please try again.');
    } finally {
      setRunning(false);
      setStage(null);
      abortRef.current = null;
    }
  };

  const stageIndex = STAGES.findIndex((s) => s.id === stage);

  return (
    <section className="rounded-xl border bg-card" aria-label="Tailor to a job">
      <div className="flex items-start gap-3 px-5 pt-4">
        <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
          <Wand2 className="size-4" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Tailor to a job</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Paste a job description. NAO rewrites your resume and writes a cover letter for it, then saves both here
            with the posting, so you can find it again before an interview.
          </p>
        </div>
      </div>
      <div className="space-y-3 px-5 pt-3 pb-4">
        <Textarea
          value={jd}
          onChange={(e) => setJd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void run();
            }
          }}
          disabled={running}
          placeholder="Paste the full job description here"
          aria-label="Job description"
          className="min-h-32 resize-y text-sm"
        />
        {showInstructions && (
          <Input
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            disabled={running}
            placeholder="Anything to emphasise? For example: lead with my Kubernetes work"
            aria-label="Extra instructions"
          />
        )}
        {error && (
          <p className="flex items-start gap-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <ol className="flex flex-wrap items-center gap-1.5 text-xs" aria-live="polite">
              {STAGES.map((s, i) => (
                <li
                  key={s.id}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full px-2 py-1',
                    i < stageIndex && 'text-status-ready',
                    i === stageIndex && 'bg-brand-soft font-medium text-brand',
                    i > stageIndex && 'text-muted-foreground',
                  )}
                >
                  {i < stageIndex ? <Check className="size-3" /> : i === stageIndex ? <Loader2 className="size-3 animate-spin" /> : null}
                  {s.label}
                </li>
              ))}
            </ol>
          ) : (
            !showInstructions && (
              <Button variant="ghost" size="sm" onClick={() => setShowInstructions(true)}>
                <PenLine />
                Add instructions
              </Button>
            )
          )}
          <div className="ml-auto flex items-center gap-2">
            {running && (
              <Button variant="ghost" size="sm" onClick={() => abortRef.current?.abort()}>
                Cancel
              </Button>
            )}
            <Button onClick={() => void run()} disabled={running || !jd.trim()}>
              {running ? <Loader2 className="animate-spin" /> : <Sparkles />}
              {running ? 'Tailoring…' : 'Tailor resume and letter'}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------------- */

function FileChip({
  label,
  state,
  icon: Icon,
  onClick,
}: {
  label: string;
  state: FileState;
  icon: typeof FileText;
  onClick: () => void;
}) {
  if (state === 'none') return null;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={state !== 'ready'}
      title={state === 'failed' ? `${label} failed` : state === 'working' ? `${label} is being generated` : `Download ${label}`}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        state === 'ready' && 'bg-background text-foreground hover:border-brand/40 hover:text-brand',
        state === 'working' && 'cursor-progress text-muted-foreground',
        state === 'failed' && 'border-destructive/30 text-destructive',
      )}
    >
      {state === 'working' ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />}
      {label}
    </button>
  );
}

function DocumentRow({
  row,
  busy,
  onPreview,
  onDownload,
  onOpen,
  onDelete,
  onViewPosting,
}: {
  row: DocRow;
  busy: boolean;
  onPreview: (row: DocRow, fileType: DocumentFileType) => void;
  onDownload: (row: DocRow, fileType: DocumentFileType) => void;
  onOpen: (row: DocRow) => void;
  onDelete: (row: DocRow) => void;
  onViewPosting: (row: DocRow) => void;
}) {
  const when = relativeTime(row.updatedAt);
  const resumeReady = row.files.resume_pdf === 'ready';
  const letterReady = row.files.cover_letter_pdf === 'ready';
  const Icon = row.origin === 'jobs' ? Briefcase : row.origin === 'tailored' ? Sparkles : FileText;
  return (
    <li className="group flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
      <button
        type="button"
        onClick={() => resumeReady && onPreview(row, 'resume_pdf')}
        disabled={!resumeReady}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted text-muted-foreground transition group-hover:text-brand">
          <Icon className="size-4" />
        </span>
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold">{row.title}</span>
            {row.isActive && (
              <span className="shrink-0 rounded-full bg-brand-soft px-1.5 py-0.5 text-[10px] font-semibold text-brand">In studio</span>
            )}
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {[
              row.subtitle,
              row.fromChat ? 'Tailored in chat' : row.origin !== 'all' ? ORIGIN_LABEL[row.origin as Exclude<Filter, 'all'>] : null,
              when,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          {row.note && <span className="mt-1 block text-xs text-destructive">{row.note}</span>}
        </span>
      </button>

      <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
        {row.matchScore != null && <MatchScore score={row.matchScore} />}
        {row.hasPosting && (
          <button
            type="button"
            onClick={() => onViewPosting(row)}
            title="View the job description this resume was tailored to"
            className="inline-flex h-7 items-center gap-1.5 rounded-md border bg-background px-2 text-xs font-medium text-foreground transition outline-none hover:border-brand/40 hover:text-brand focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <ScrollText className="size-3.5" />
            Job description
          </button>
        )}
        <FileChip label="Resume" state={row.files.resume_pdf} icon={Download} onClick={() => onDownload(row, 'resume_pdf')} />
        <FileChip label="Cover letter" state={row.files.cover_letter_pdf} icon={Mail} onClick={() => onDownload(row, 'cover_letter_pdf')} />
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`More actions for ${row.title}`}
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-popup-open:bg-muted"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <MoreHorizontal className="size-4" />}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="max-w-64 truncate text-xs text-muted-foreground">{row.title}</DropdownMenuLabel>
              <DropdownMenuItem disabled={!resumeReady && row.kind === 'build'} onClick={() => onOpen(row)}>
                <PenLine />
                Edit in Resume studio
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!resumeReady} onClick={() => onPreview(row, 'resume_pdf')}>
                <Eye />
                Preview resume
              </DropdownMenuItem>
              {letterReady && (
                <DropdownMenuItem onClick={() => onPreview(row, 'cover_letter_pdf')}>
                  <Mail />
                  Preview cover letter
                </DropdownMenuItem>
              )}
              {row.hasPosting && (
                <DropdownMenuItem onClick={() => onViewPosting(row)}>
                  <ScrollText />
                  View job description
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem disabled={row.files.resume_docx !== 'ready'} onClick={() => onDownload(row, 'resume_docx')}>
                <FileType2 />
                Resume, Word (editable)
              </DropdownMenuItem>
              {row.files.cover_letter_docx === 'ready' && (
                <DropdownMenuItem onClick={() => onDownload(row, 'cover_letter_docx')}>
                  <FileType2 />
                  Cover letter, Word (editable)
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
            {row.kind === 'library' && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => onDelete(row)}>
                  <Trash2 />
                  Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------------- */

interface PreviewState {
  row: DocRow;
  fileType: DocumentFileType;
  file: File | null;
  url: string | null;
  error: string | null;
}

export function DocumentsPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<DocumentsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DocRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [justMade, setJustMade] = useState<{ id: string; score: number | null } | null>(null);

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

  const rows = useMemo(() => (data ? toRows(data) : []), [data]);
  const working = rows.some((r) => Object.values(r.files).includes('working'));
  useEffect(() => {
    if (!working) return;
    const t = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(t);
  }, [working, load]);

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

  const [searchParams, setSearchParams] = useSearchParams();
  const [posting, setPosting] = useState<{ title: string; data: SavedJobDescription | null; error: string | null } | null>(
    null,
  );
  const openPosting = useCallback(async (id: string, title: string) => {
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

  const justMadeRow = justMade ? rows.find((r) => r.kind === 'library' && r.id === justMade.id) ?? null : null;

  return (
    <PageLayout
      title="Documents"
      description="Every resume and cover letter NAO has made for you."
      width="wide"
      actions={
        <Button variant="outline" nativeButton={false} render={<Link to="/app/studio" />}>
          <PenLine />
          Resume studio
        </Button>
      }
    >
      <div className="space-y-6">
        <TailorComposer onDone={(r) => void onTailored(r)} />

        {justMadeRow && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-status-ready/30 bg-status-ready/10 px-4 py-3">
            <Check className="size-4 shrink-0 text-status-ready" />
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

        <SectionCard
          title="Generated documents"
          description="Resumes from job applications, tailored resumes and your own. PDFs match the studio exactly."
          className="overflow-hidden"
        >
          <div className="-mx-5 -mt-4 flex flex-wrap items-center gap-2 border-b px-5 py-3">
            <div role="tablist" aria-label="Filter documents" className="inline-flex rounded-lg border bg-muted p-0.5">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="tab"
                  aria-selected={filter === f.id}
                  onClick={() => setFilter(f.id)}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition',
                    filter === f.id ? 'bg-card text-foreground shadow-sm ring-1 ring-border' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {f.label}
                  <span className="tabular-nums text-muted-foreground">{counts[f.id]}</span>
                </button>
              ))}
            </div>
            <div className="relative ml-auto w-full sm:w-64">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search role, company or job text"
                aria-label="Search documents"
                className="pl-8"
              />
            </div>
          </div>

          {actionError && (
            <p className="-mx-5 flex items-start gap-2 border-b bg-destructive/5 px-5 py-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              {actionError}
            </p>
          )}

          {!data && !loadError ? (
            <div className="-mx-5 -mb-4 divide-y">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-3 px-5 py-4">
                  <Skeleton className="size-9 rounded-lg" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3.5 w-48" />
                    <Skeleton className="h-3 w-32" />
                  </div>
                </div>
              ))}
            </div>
          ) : loadError ? (
            <div className="flex items-center gap-3 py-6 text-sm text-destructive">
              <AlertCircle className="size-4" />
              {loadError}
              <Button size="sm" variant="outline" onClick={() => void load()}>
                Retry
              </Button>
            </div>
          ) : visible.length === 0 ? (
            <Empty className="py-10">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileText />
                </EmptyMedia>
                <EmptyTitle>{rows.length === 0 ? 'No documents yet' : 'Nothing matches'}</EmptyTitle>
                <EmptyDescription>
                  {rows.length === 0
                    ? 'Tailor a resume above, or prepare a job from the Jobs page to generate one.'
                    : 'Try another filter or search.'}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="-mx-5 -mb-4 divide-y">
              {visible.map((row) => (
                <DocumentRow
                  key={row.key}
                  row={row}
                  busy={busyKey === row.key}
                  onPreview={(r, t) => void onPreview(r, t)}
                  onDownload={(r, t) => void onDownload(r, t)}
                  onOpen={(r) => void onOpen(r)}
                  onDelete={setPendingDelete}
                  onViewPosting={(r) => void openPosting(r.id, r.title)}
                />
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <Dialog open={preview != null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="flex h-[min(92dvh,1000px)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
          <div className="flex shrink-0 items-center gap-3 border-b py-2.5 pr-12 pl-4">
            <DialogTitle className="min-w-0 flex-1 truncate text-sm font-semibold">
              {preview ? `${preview.fileType.startsWith('cover') ? 'Cover letter' : 'Resume'}: ${preview.row.title}` : ''}
            </DialogTitle>
            {preview?.file && (
              <Button size="sm" onClick={() => preview.file && saveFile(preview.file)}>
                <Download />
                Download
              </Button>
            )}
          </div>
          <div className="min-h-0 flex-1 bg-muted">
            {preview?.error ? (
              <p className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive">{preview.error}</p>
            ) : preview?.url ? (
              <ResumePdfEmbed url={preview.url} title={preview.file?.name} />
            ) : (
              <p className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin text-brand" />
                Opening…
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={posting != null} onOpenChange={(open) => !open && setPosting(null)}>
        <DialogContent className="flex max-h-[min(88dvh,900px)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
          <div className="shrink-0 border-b py-3 pr-12 pl-5">
            <DialogTitle className="truncate text-sm font-semibold">Job description: {posting?.title}</DialogTitle>
            {posting?.data ? (
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
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
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin text-brand" />
                Loading…
              </p>
            )}
          </div>
          {posting?.data?.job_description ? (
            <div className="flex shrink-0 justify-end border-t px-5 py-2.5">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void navigator.clipboard?.writeText(posting.data?.job_description ?? '')}
              >
                Copy text
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
    </PageLayout>
  );
}
