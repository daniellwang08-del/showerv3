import { ClipboardCheck, ExternalLink, MoreHorizontal, RefreshCw, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { DashboardJob } from '@/types/scraper';
import { buildJobMenu, type JobActionId, type JobMenuContext } from './jobMenu';
import { JobMenuItems } from './JobMenu';
import { isApplied } from './jobStatus';

interface Props {
  selected: DashboardJob[];
  pageCount: number;
  onSelectAll: () => void;
  onClear: () => void;
  onAction: (id: JobActionId, targets: DashboardJob[]) => void;
  menuContext: JobMenuContext;
}

const label = 'max-sm:sr-only';

export function BulkBar({ selected, pageCount, onSelectAll, onClear, onAction, menuContext }: Props) {
  if (selected.length === 0) return null;
  const unapplied = selected.filter((j) => !isApplied(j));

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-16 z-20 flex justify-center px-4">
      <div
        role="toolbar"
        aria-label="Bulk actions"
        className="pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-lg ring-1 ring-foreground/5 animate-in fade-in-0 slide-in-from-bottom-2"
      >
        <span className="whitespace-nowrap px-2 text-sm font-medium tabular-nums">{selected.length} selected</span>
        {selected.length < pageCount && (
          <Button variant="ghost" size="sm" onClick={onSelectAll}>
            <span className={label}>Select all</span>
            <span className="sm:hidden" aria-hidden>All</span> {pageCount}
          </Button>
        )}
        <div className="mx-1 h-5 w-px bg-border max-sm:hidden" />
        <Button
          variant="ghost"
          size="sm"
          disabled={unapplied.length === 0}
          onClick={() => onAction('mark-applied', unapplied)}
        >
          <ClipboardCheck /> <span className={label}>Mark applied</span>
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onAction('prepare', selected)}>
          <RefreshCw /> <span className={label}>Prepare</span>
        </Button>
        <Button variant="ghost" size="sm" className="max-sm:hidden" onClick={() => onAction('open-url', selected)}>
          <ExternalLink /> <span className={label}>Open</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => onAction('delete', selected)}
        >
          <Trash2 /> <span className={label}>Delete</span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More bulk actions" />}>
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="min-w-56">
            <JobMenuItems kind="dropdown" entries={buildJobMenu(selected, menuContext)} onAction={onAction} />
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="mx-1 h-5 w-px bg-border max-sm:hidden" />
        <Button variant="ghost" size="sm" onClick={onClear} aria-label="Clear selection">
          <X /> <Kbd className="max-sm:hidden">Esc</Kbd>
        </Button>
      </div>
    </div>
  );
}
