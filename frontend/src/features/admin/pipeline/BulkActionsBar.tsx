import { ExternalLink, ListChecks, Loader2, RefreshCw, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';

interface Props {
  count: number;
  pageCount: number;
  notExtractedOnPage: number;
  showAllPages: boolean;
  selectingAllPages: boolean;
  extracting: boolean;
  onSelectPage: () => void;
  onSelectNotExtractedPage: () => void;
  onSelectNotExtractedAll: () => void;
  onExtract: () => void;
  onOpenUrls: () => void;
  onDelete: () => void;
  onClear: () => void;
}

const label = 'max-sm:sr-only';

export function BulkActionsBar(p: Props) {
  const busy = p.extracting || p.selectingAllPages;
  return (
    <div
      role="toolbar"
      aria-label="Bulk actions"
      className="flex flex-wrap items-center gap-1 rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-sm"
    >
      <span className="px-2 text-sm font-medium tabular-nums">{p.count} selected</span>
      <div className="mx-1 h-5 w-px bg-border max-sm:hidden" />
      <Button variant="ghost" size="sm" disabled={busy} onClick={p.onExtract}>
        {p.extracting ? <Loader2 className="animate-spin" /> : <RefreshCw />} <span className={label}>Extract selected</span>
      </Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={p.onOpenUrls}>
        <ExternalLink /> <span className={label}>Open URLs</span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={p.onDelete}
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2 /> <span className={label}>Delete selected</span>
      </Button>
      <div className="ml-auto flex flex-wrap items-center gap-1">
        {p.count < p.pageCount && (
          <Button variant="ghost" size="sm" onClick={p.onSelectPage}>
            Select all {p.pageCount}
          </Button>
        )}
        {p.notExtractedOnPage > 0 && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={p.onSelectNotExtractedPage}
            title={`Select ${p.notExtractedOnPage} jobs on this page without a job description`}
          >
            <ListChecks /> Not extracted · page
            <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums">{p.notExtractedOnPage}</span>
          </Button>
        )}
        {p.showAllPages && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={p.onSelectNotExtractedAll}
            title="Select every not-extracted job across all pages of the current filters"
          >
            {p.selectingAllPages ? <Loader2 className="animate-spin" /> : <ListChecks />} Not extracted · all pages
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={p.onClear} aria-label="Clear selection">
          <X /> <Kbd className="max-sm:hidden">Esc</Kbd>
        </Button>
      </div>
    </div>
  );
}
