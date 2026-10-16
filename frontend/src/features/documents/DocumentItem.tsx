import { AlertCircle, Download, Eye, FileType2, Loader2, Mail, MoreHorizontal, PenLine, ScrollText, Trash2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MatchScore } from '@/components/app/MatchScore';
import type { DocumentFileType } from '@/api/documentsApi';
import { relativeTime } from '@/features/integrations/status';
import { cn } from '@/lib/utils';
import { ORIGIN_STYLE, originLabel, rowStatus, type DocRow, type FileState } from './documentsModel';

export interface DocumentActions {
  onPreview: (row: DocRow, fileType: DocumentFileType) => void;
  onDownload: (row: DocRow, fileType: DocumentFileType) => void;
  onOpen: (row: DocRow) => void;
  onDelete: (row: DocRow) => void;
  onViewPosting: (row: DocRow) => void;
}

interface ItemProps extends DocumentActions {
  row: DocRow;
  busy: boolean;
  style?: React.CSSProperties;
}

function StatusPill({ row }: { row: DocRow }) {
  const status = rowStatus(row);
  if (status === 'ready') return null;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold',
        status === 'working' && 'bg-brand-soft text-brand',
        status === 'failed' && 'bg-destructive/10 text-destructive',
      )}
    >
      {status === 'working' ? <Loader2 className="size-3 animate-spin" /> : <AlertCircle className="size-3" />}
      {status === 'working' ? 'Generating' : 'Failed'}
    </span>
  );
}

function FileButton({
  label,
  state,
  icon: Icon,
  onClick,
}: {
  label: string;
  state: FileState;
  icon: typeof Download;
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
        'inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        state === 'ready' && 'bg-background/80 text-foreground hover:-translate-y-px hover:border-brand/40 hover:text-brand hover:shadow-sm',
        state === 'working' && 'cursor-progress border-dashed text-muted-foreground',
        state === 'failed' && 'border-destructive/30 text-destructive',
      )}
    >
      {state === 'working' ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />}
      {label}
    </button>
  );
}

function ActionsMenu({ row, busy, onPreview, onDownload, onOpen, onDelete, onViewPosting }: ItemProps) {
  const resumeReady = row.files.resume_pdf === 'ready';
  const letterReady = row.files.cover_letter_pdf === 'ready';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`More actions for ${row.title}`}
        className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground outline-none transition hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-popup-open:bg-muted data-popup-open:text-foreground"
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
  );
}

function Badges({ row }: { row: DocRow }) {
  return (
    <>
      {row.isActive && (
        <span className="shrink-0 rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-semibold text-brand">In studio</span>
      )}
      <StatusPill row={row} />
    </>
  );
}

function PostingButton({ row, onViewPosting }: { row: DocRow; onViewPosting: (row: DocRow) => void }) {
  if (!row.hasPosting) return null;
  return (
    <button
      type="button"
      onClick={() => onViewPosting(row)}
      title="View the job description this resume was tailored to"
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border bg-background/80 px-2.5 text-xs font-medium text-foreground transition outline-none hover:-translate-y-px hover:border-brand/40 hover:text-brand hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <ScrollText className="size-3.5" />
      Job description
    </button>
  );
}

export function DocumentListRow(props: ItemProps) {
  const { row, onPreview, onDownload, onViewPosting, style } = props;
  const origin = ORIGIN_STYLE[row.origin];
  const resumeReady = row.files.resume_pdf === 'ready';
  const meta = [row.subtitle, originLabel(row), relativeTime(row.updatedAt)].filter(Boolean).join(' · ');
  return (
    <li
      style={style}
      className="docs-item group relative flex flex-col gap-3 px-4 py-3.5 transition-colors hover:bg-muted/40 sm:flex-row sm:items-center sm:px-5"
    >
      <span aria-hidden className={cn('absolute inset-y-3 left-0 w-0.5 rounded-full opacity-0 transition-opacity group-hover:opacity-100', origin.accent)} />
      <button
        type="button"
        onClick={() => resumeReady && onPreview(row, 'resume_pdf')}
        disabled={!resumeReady}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className={cn('inline-flex size-10 shrink-0 items-center justify-center rounded-xl ring-1 transition-transform group-hover:scale-105', origin.chip)}>
          <origin.icon className="size-[18px]" />
        </span>
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold group-hover:text-brand">{row.title}</span>
            <Badges row={row} />
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{meta}</span>
          {row.note && <span className="mt-1 block truncate text-xs text-destructive">{row.note}</span>}
        </span>
      </button>

      <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
        {row.matchScore != null && <MatchScore score={row.matchScore} />}
        <PostingButton row={row} onViewPosting={onViewPosting} />
        <FileButton label="Resume" state={row.files.resume_pdf} icon={Download} onClick={() => onDownload(row, 'resume_pdf')} />
        <FileButton label="Cover letter" state={row.files.cover_letter_pdf} icon={Mail} onClick={() => onDownload(row, 'cover_letter_pdf')} />
        <ActionsMenu {...props} />
      </div>
    </li>
  );
}

export function DocumentGridCard(props: ItemProps) {
  const { row, onPreview, onDownload, style } = props;
  const origin = ORIGIN_STYLE[row.origin];
  const resumeReady = row.files.resume_pdf === 'ready';
  const status = rowStatus(row);
  return (
    <li
      style={style}
      className="docs-item group relative flex flex-col overflow-hidden rounded-2xl border bg-card/90 shadow-xs backdrop-blur-sm transition-all hover:-translate-y-1 hover:border-brand/30 hover:shadow-lg"
    >
      <button
        type="button"
        onClick={() => resumeReady && onPreview(row, 'resume_pdf')}
        disabled={!resumeReady}
        aria-label={`Preview ${row.title}`}
        className="docs-paper-stage relative flex h-36 items-end justify-center overflow-hidden px-6 pt-5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
      >
        <span className={cn('absolute inset-x-0 top-0 h-1', origin.accent)} aria-hidden />
        <span aria-hidden className="docs-paper relative h-full w-[72%] rounded-t-lg border border-b-0 bg-background px-4 pt-4 shadow-md transition-transform duration-300 group-hover:-translate-y-1.5">
          <span className="block h-2 w-1/2 rounded-full bg-foreground/70" />
          <span className="mt-1.5 block h-1.5 w-1/3 rounded-full bg-muted-foreground/40" />
          <span className="mt-3 block h-1 w-full rounded-full bg-muted-foreground/20" />
          <span className="mt-1.5 block h-1 w-11/12 rounded-full bg-muted-foreground/20" />
          <span className="mt-1.5 block h-1 w-4/5 rounded-full bg-muted-foreground/20" />
          <span className="mt-3 block h-1.5 w-1/4 rounded-full bg-muted-foreground/35" />
          <span className="mt-1.5 block h-1 w-full rounded-full bg-muted-foreground/20" />
          <span className="mt-1.5 block h-1 w-3/4 rounded-full bg-muted-foreground/20" />
        </span>
        {status === 'working' && (
          <span className="absolute inset-0 flex items-center justify-center bg-background/40 backdrop-blur-[1px]">
            <Loader2 className="size-6 animate-spin text-brand" />
          </span>
        )}
        {resumeReady && (
          <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-foreground/85 px-3 py-1.5 text-xs font-semibold text-background shadow-lg">
              <Eye className="size-3.5" />
              Preview
            </span>
          </span>
        )}
        <span className={cn('absolute top-3 left-3 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 backdrop-blur', origin.chip)}>
          <origin.icon className="size-3" />
          {originLabel(row)}
        </span>
        {row.matchScore != null && (
          <span className="absolute top-2.5 right-3">
            <MatchScore score={row.matchScore} />
          </span>
        )}
      </button>

      <div className="flex flex-1 flex-col gap-3 border-t px-4 py-3.5">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-sm font-semibold" title={row.title}>
              {row.title}
            </h3>
            <Badges row={row} />
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {[row.subtitle, relativeTime(row.updatedAt)].filter(Boolean).join(' · ') || '-'}
          </p>
          {row.note && <p className="mt-1 line-clamp-2 text-xs text-destructive">{row.note}</p>}
        </div>
        <div className="mt-auto flex items-center gap-1.5">
          <FileButton label="Resume" state={row.files.resume_pdf} icon={Download} onClick={() => onDownload(row, 'resume_pdf')} />
          <FileButton label="Letter" state={row.files.cover_letter_pdf} icon={Mail} onClick={() => onDownload(row, 'cover_letter_pdf')} />
          <span className="ml-auto">
            <ActionsMenu {...props} />
          </span>
        </div>
      </div>
    </li>
  );
}
