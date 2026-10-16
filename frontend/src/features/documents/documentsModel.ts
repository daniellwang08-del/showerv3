import { Briefcase, FileText, Sparkles, type LucideIcon } from 'lucide-react';
import {
  fetchJobBuildDocument,
  fetchLibraryDocument,
  type DocumentFileType,
  type DocumentsResponse,
  type JobBuildDocument,
  type LibraryDocument,
} from '@/api/documentsApi';
import { parseServerDate } from '@/features/integrations/status';

export type Filter = 'all' | 'jobs' | 'tailored' | 'mine';
export type Origin = Exclude<Filter, 'all'>;
export type FileState = 'ready' | 'working' | 'failed' | 'none';
export type DocStatus = 'ready' | 'working' | 'failed';

export interface DocRow {
  key: string;
  kind: 'library' | 'build';
  id: string;
  jobId: string | null;
  title: string;
  subtitle: string | null;
  origin: Origin;
  updatedAt: string | null;
  isActive: boolean;
  note: string | null;
  files: Record<DocumentFileType, FileState>;
  hasPosting: boolean;
  matchScore: number | null;
  fromChat: boolean;
}

export const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'jobs', label: 'From jobs' },
  { id: 'tailored', label: 'Tailored' },
  { id: 'mine', label: 'My resumes' },
];

export interface OriginStyle {
  label: string;
  icon: LucideIcon;
  /** Icon chip and badge tint. */
  chip: string;
  /** Accent stripe and dot colour. */
  accent: string;
}

export const ORIGIN_STYLE: Record<Origin, OriginStyle> = {
  jobs: {
    label: 'Job application',
    icon: Briefcase,
    chip: 'bg-sky-500/12 text-sky-700 ring-sky-500/20 dark:text-sky-300',
    accent: 'bg-sky-500',
  },
  tailored: {
    label: 'Tailored',
    icon: Sparkles,
    chip: 'bg-violet-500/12 text-violet-700 ring-violet-500/20 dark:text-violet-300',
    accent: 'bg-violet-500',
  },
  mine: {
    label: 'My resume',
    icon: FileText,
    chip: 'bg-emerald-500/12 text-emerald-700 ring-emerald-500/20 dark:text-emerald-300',
    accent: 'bg-emerald-500',
  },
};

export const FILTER_DOT: Record<Filter, string> = {
  all: 'bg-muted-foreground/60',
  jobs: ORIGIN_STYLE.jobs.accent,
  tailored: ORIGIN_STYLE.tailored.accent,
  mine: ORIGIN_STYLE.mine.accent,
};

function buildFileState(status: string | undefined): FileState {
  if (status === 'completed') return 'ready';
  if (status === 'failed') return 'failed';
  if (status === 'processing' || status === 'pending') return 'working';
  return 'none';
}

export function toRows(data: DocumentsResponse): DocRow[] {
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
  const builds = data.builds.flatMap<DocRow>((b: JobBuildDocument) => {
    const contentFailed = b.content_status === 'failed';
    const contentWorking = b.content_status === 'pending' || b.content_status === 'processing';
    const files = Object.fromEntries(
      (Object.keys(b.files) as DocumentFileType[]).map((k) => [
        k,
        contentFailed ? 'failed' : contentWorking ? 'working' : buildFileState(b.files[k]),
      ]),
    ) as Record<DocumentFileType, FileState>;
    if (Object.values(files).every((s) => s === 'none')) return [];
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

export function rowStatus(row: DocRow): DocStatus {
  const states = Object.values(row.files);
  if (states.includes('working')) return 'working';
  if (row.note || states.includes('failed')) return 'failed';
  return 'ready';
}

export function originLabel(row: DocRow): string {
  return row.fromChat ? 'Tailored in chat' : ORIGIN_STYLE[row.origin].label;
}

export function fetchFile(row: DocRow, fileType: DocumentFileType): Promise<File> {
  return row.kind === 'library'
    ? fetchLibraryDocument(row.id, fileType)
    : fetchJobBuildDocument(row.jobId ?? '', fileType);
}

export function errorText(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { detail?: string } } };
  return e?.response?.data?.detail || fallback;
}

export interface DocGroup {
  label: string;
  rows: DocRow[];
}

/** Buckets rows (already newest first) into Today, This week, This month and Earlier. */
export function groupByRecency(rows: DocRow[], now = new Date()): DocGroup[] {
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86_400_000;
  const buckets: Array<{ label: string; from: number }> = [
    { label: 'Today', from: startOfDay },
    { label: 'This week', from: startOfDay - 6 * day },
    { label: 'This month', from: startOfDay - 29 * day },
    { label: 'Earlier', from: Number.NEGATIVE_INFINITY },
  ];
  const groups = buckets.map((b) => ({ label: b.label, rows: [] as DocRow[] }));
  for (const row of rows) {
    const t = parseServerDate(row.updatedAt)?.getTime() ?? Number.NEGATIVE_INFINITY;
    const index = buckets.findIndex((b) => t >= b.from);
    groups[index === -1 ? groups.length - 1 : index].rows.push(row);
  }
  return groups.filter((g) => g.rows.length > 0);
}
