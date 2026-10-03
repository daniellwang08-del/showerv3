import { useEffect, useState } from 'react';
import { Copy as CopyIcon, Globe, Plus, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import type { DashboardView } from '@/api/scraperApi';
import { extractHttpUrlsFromText } from '@/utils/extractHttpUrls';
import { submitJobUrls } from './submitJobUrls';

export interface JobsViewTab {
  id: DashboardView;
  label: string;
  count?: number;
}

export const MATCH_FILTERS = [
  { value: '0', label: 'Any match' },
  { value: '50', label: 'Fair+ (50)' },
  { value: '65', label: 'Good+ (65)' },
  { value: '80', label: 'Strong (80+)' },
];

interface Props {
  tabs: JobsViewTab[];
  view: DashboardView;
  onView: (view: DashboardView) => void;
  search: string;
  onSearch: (q: string) => void;
  remoteOnly: boolean;
  onRemoteOnly: (v: boolean) => void;
  minScore: number;
  onMinScore: (v: number) => void;
  /** Agent-applied title/company filters, shown as removable chips. */
  chips: Array<{ key: string; label: string; onClear: () => void }>;
  duplicateCount: number;
  onOpenDuplicates: () => void;
}

export function JobsToolbar(props: Props) {
  const [query, setQuery] = useState(props.search);
  const [adding, setAdding] = useState(false);

  useEffect(() => setQuery(props.search), [props.search]);

  useEffect(() => {
    if (query === props.search) return;
    const t = setTimeout(() => props.onSearch(query.trim()), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const matchValue = MATCH_FILTERS.some((f) => f.value === String(props.minScore))
    ? String(props.minScore)
    : '0';

  return (
    <div className="space-y-3">
      <div role="tablist" aria-label="Job views" className="scrollbar-thin -mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
        {props.tabs.map((tab) => {
          const active = tab.id === props.view;
          return (
            <button
              key={tab.id}
              role="tab"
              type="button"
              aria-selected={active}
              onClick={() => props.onView(tab.id)}
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
                active
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {tab.label}
              {tab.count != null && (
                <span
                  className={cn(
                    'rounded-full px-1.5 text-xs tabular-nums',
                    active ? 'bg-background/20' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {tab.count.toLocaleString()}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <InputGroup className="w-full sm:w-72">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            aria-label="Search jobs"
            placeholder="Search roles, companies, links…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') props.onSearch(query.trim());
              if (e.key === 'Escape' && query) {
                e.stopPropagation();
                setQuery('');
                props.onSearch('');
              }
            }}
          />
        </InputGroup>

        <Button
          variant={props.remoteOnly ? 'secondary' : 'outline'}
          size="sm"
          aria-pressed={props.remoteOnly}
          onClick={() => props.onRemoteOnly(!props.remoteOnly)}
          className={cn(props.remoteOnly && 'border-brand/40 bg-brand-soft text-brand')}
        >
          <Globe /> Remote
        </Button>

        <Select
          value={matchValue}
          items={MATCH_FILTERS}
          onValueChange={(v) => props.onMinScore(Number(v ?? 0))}
        >
          <SelectTrigger size="sm" aria-label="Minimum match score" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MATCH_FILTERS.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {props.chips.map((chip) => (
          <span
            key={chip.key}
            className="inline-flex h-7 items-center gap-1 rounded-full border bg-muted/50 pl-2.5 pr-1 text-xs"
          >
            {chip.label}
            <button
              type="button"
              aria-label={`Clear ${chip.label}`}
              onClick={chip.onClear}
              className="rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}

        <div className="ml-auto flex items-center gap-2">
          {props.duplicateCount > 0 && (
            <Button variant="ghost" size="sm" onClick={props.onOpenDuplicates}>
              <CopyIcon /> {props.duplicateCount} skipped
            </Button>
          )}
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus /> Add jobs
          </Button>
        </div>
      </div>

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
