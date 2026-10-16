import { useState } from 'react';
import { Layers, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { extractHttpUrlsFromText } from '@/utils/extractHttpUrls';
import { submitJobUrls } from './submitJobUrls';

/** Skipped-duplicates review and Add jobs, shown in the Jobs masthead. */
export function JobsHeaderActions({
  duplicateCount,
  onOpenDuplicates,
}: {
  duplicateCount: number;
  onOpenDuplicates: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const hasSkipped = duplicateCount > 0;

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onOpenDuplicates}
        disabled={!hasSkipped}
        title={hasSkipped ? 'Jobs skipped as duplicates. Review them.' : 'No skipped jobs'}
        className={cn(
          'group inline-flex h-9 items-center gap-2 rounded-full border pl-1.5 pr-3 text-sm font-medium outline-none transition-all',
          'bg-background/70 shadow-xs backdrop-blur-sm focus-visible:ring-2 focus-visible:ring-ring/50',
          hasSkipped
            ? 'border-amber-500/35 text-foreground hover:-translate-y-px hover:border-amber-500/60 hover:bg-background/90 hover:shadow-sm'
            : 'cursor-not-allowed border-border/70 text-muted-foreground opacity-70',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'flex size-6 items-center justify-center rounded-full transition-colors',
            hasSkipped
              ? 'bg-amber-500/15 text-amber-600 group-hover:bg-amber-500/25 dark:text-amber-400'
              : 'bg-muted text-muted-foreground',
          )}
        >
          <Layers className="size-3.5" />
        </span>
        Skipped
        <span
          className={cn(
            'min-w-6 rounded-full px-1.5 py-px text-center text-xs font-semibold tabular-nums',
            hasSkipped ? 'bg-amber-500 text-amber-950' : 'bg-muted text-muted-foreground',
          )}
        >
          {duplicateCount.toLocaleString()}
        </span>
      </button>

      <button
        type="button"
        onClick={() => setAdding(true)}
        className={cn(
          'group relative inline-flex h-9 items-center gap-2 overflow-hidden rounded-full pl-1.5 pr-4 text-sm font-semibold outline-none transition-all',
          'bg-gradient-to-r from-brand to-brand-glow text-brand-foreground shadow-sm shadow-brand/30',
          'hover:-translate-y-px hover:shadow-md hover:shadow-brand/40 focus-visible:ring-2 focus-visible:ring-ring/50 active:translate-y-0',
        )}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-700 group-hover:translate-x-full motion-reduce:hidden"
        />
        <span
          aria-hidden
          className="flex size-6 items-center justify-center rounded-full bg-white/20 transition-transform group-hover:rotate-90"
        >
          <Plus className="size-3.5" />
        </span>
        Add jobs
      </button>

      <AddJobsDialog open={adding} onOpenChange={setAdding} />
    </div>
  );
}

function AddJobsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [text, setText] = useState('');
  const count = extractHttpUrlsFromText(text).length;

  const submit = () => {
    if (count === 0) return;
    const value = text;
    setText('');
    onOpenChange(false);
    void submitJobUrls(value);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add jobs</DialogTitle>
          <DialogDescription>
            Paste one or more job posting links. Each one is read, matched against your profile, and gets a tailored
            resume.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          autoFocus
          rows={6}
          aria-label="Job links"
          placeholder={'https://boards.greenhouse.io/acme/jobs/123\nhttps://jobs.lever.co/acme/456'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
          }}
          className="font-mono text-xs"
        />
        <DialogFooter className="items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {count > 0 ? `${count} link${count === 1 ? '' : 's'} detected` : 'Tip: ⌘/Ctrl + Enter to submit'}
          </span>
          <Button onClick={submit} disabled={count === 0}>
            {count > 0 ? `Add ${count} job${count === 1 ? '' : 's'}` : 'Add jobs'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
