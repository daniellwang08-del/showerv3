import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Check, Loader2, Plus, RefreshCw, X } from 'lucide-react';
import { saveSheetsConfig, verifySpreadsheet } from '@/api/googleSheetsApi';
import type { SheetsConfigSaveResult } from '@/types/googleSheets';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/field';
import { cn } from '@/lib/utils';
import { InlineError, Section } from './SheetFrame';
import { errorDetail } from './status';

const GROUP_DOTS = [
  'bg-status-new',
  'bg-status-ready',
  'bg-status-preparing',
  'bg-status-applied',
  'bg-status-failed',
  'bg-match-weak',
];
const GROUP_ACTIVE = [
  'bg-status-new hover:bg-status-new',
  'bg-status-ready hover:bg-status-ready',
  'bg-status-preparing hover:bg-status-preparing',
  'bg-status-applied hover:bg-status-applied',
  'bg-status-failed hover:bg-status-failed',
  'bg-match-weak hover:bg-match-weak',
];
const MAX_GROUPS = GROUP_DOTS.length;

export function buildAssignments(tabs: string[], groups: string[][] | undefined) {
  const assignments: Record<string, number> = {};
  tabs.forEach((t) => {
    assignments[t] = -1;
  });
  const safe = groups ?? [];
  safe.forEach((group, gi) => {
    group.forEach((tab) => {
      if (tabs.includes(tab)) assignments[tab] = gi;
    });
  });
  return { assignments, groupCount: Math.min(Math.max(safe.length, 2), MAX_GROUPS) };
}

export function buildTabGroups(tabs: string[], assignments: Record<string, number>, groupCount: number): string[][] {
  const groups: string[][] = Array.from({ length: groupCount }, () => []);
  for (const tab of tabs) {
    const gi = assignments[tab] ?? -1;
    if (gi >= 0 && gi < groupCount) groups[gi].push(tab);
  }
  return groups.filter((g) => g.length > 0);
}

/** Assign spreadsheet tabs to round-robin groups and save the Sheets configuration. */
export function TabGroupsEditor({
  spreadsheetUrl,
  tabs: initialTabs,
  initialGroups,
  autoPostThreshold,
  onSaved,
  onCancel,
}: {
  spreadsheetUrl: string;
  tabs: string[];
  initialGroups: string[][];
  autoPostThreshold: number;
  onSaved: (result: SheetsConfigSaveResult) => void;
  onCancel?: () => void;
}) {
  const [tabs, setTabs] = useState(initialTabs);
  const [assignments, setAssignments] = useState(() => buildAssignments(initialTabs, initialGroups).assignments);
  const [groupCount, setGroupCount] = useState(() => buildAssignments(initialTabs, initialGroups).groupCount);
  const [error, setError] = useState('');

  const refresh = useMutation({
    mutationFn: () => verifySpreadsheet(spreadsheetUrl),
    onMutate: () => setError(''),
    onSuccess: (result) => {
      const next = result.tabs ?? [];
      setTabs(next);
      setAssignments((prev) => Object.fromEntries(next.map((t) => [t, prev[t] ?? -1])));
    },
    onError: (err) => setError(errorDetail(err, 'Could not refresh tabs from the spreadsheet.')),
  });

  const save = useMutation({
    mutationFn: (tab_groups: string[][]) =>
      saveSheetsConfig({ spreadsheet_url: spreadsheetUrl.trim(), tab_groups, auto_post_threshold: autoPostThreshold }),
    onMutate: () => setError(''),
    onSuccess: onSaved,
    onError: (err) => setError(errorDetail(err, 'Failed to save configuration')),
  });

  const assign = (tab: string, gi: number) => setAssignments((prev) => ({ ...prev, [tab]: gi }));

  const removeGroup = (gi: number) => {
    if (groupCount <= 1) return;
    setAssignments((prev) => {
      const next = { ...prev };
      for (const tab of Object.keys(next)) {
        if (next[tab] === gi) next[tab] = -1;
        else if (next[tab] > gi) next[tab] -= 1;
      }
      return next;
    });
    setGroupCount((c) => c - 1);
  };

  const assignedCount = tabs.filter((t) => (assignments[t] ?? -1) >= 0).length;
  const [validation, setValidation] = useState('');

  const submit = () => {
    const groups = buildTabGroups(tabs, assignments, groupCount);
    if (groups.length === 0) {
      setValidation('Assign at least one tab to a group');
      return;
    }
    setValidation('');
    save.mutate(groups);
  };

  return (
    <Section
      title="Tab groups"
      description="Jobs round-robin between groups. Every tab in a group receives the same job URL."
      actions={
        <Button variant="ghost" size="sm" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
          <RefreshCw className={cn(refresh.isPending && 'animate-spin')} />
          Refresh tabs
        </Button>
      }
    >
      <div className="flex flex-wrap items-center gap-1.5" aria-label="Groups" role="list">
        {Array.from({ length: groupCount }, (_, gi) => {
          const count = tabs.filter((t) => assignments[t] === gi).length;
          return (
            <span key={gi} role="listitem" className="inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-1 pl-2.5 text-xs">
              <span aria-hidden className={cn('size-2 rounded-full', GROUP_DOTS[gi])} />
              Group {gi + 1}
              <span className="text-muted-foreground tabular-nums">({count})</span>
              {groupCount > 1 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="rounded-full"
                  aria-label={`Remove group ${gi + 1}`}
                  onClick={() => removeGroup(gi)}
                >
                  <X />
                </Button>
              ) : (
                <span className="w-1" />
              )}
            </span>
          );
        })}
        {groupCount < MAX_GROUPS ? (
          <Button type="button" variant="outline" size="xs" className="rounded-full border-dashed" onClick={() => setGroupCount((c) => c + 1)}>
            <Plus />
            Add group
          </Button>
        ) : null}
      </div>

      <ul className="divide-y rounded-xl border" aria-label="Spreadsheet tabs">
        {tabs.map((tab) => {
          const gi = assignments[tab] ?? -1;
          return (
            <li key={tab} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="flex min-w-0 items-center gap-2 text-sm">
                <span aria-hidden className={cn('size-2 shrink-0 rounded-full', gi >= 0 ? GROUP_DOTS[gi] : 'border')} />
                <span className="truncate">{tab}</span>
              </span>
              <div className="flex shrink-0 items-center gap-1" role="group" aria-label={`Group for ${tab}`}>
                {Array.from({ length: groupCount }, (_, idx) => {
                  const active = gi === idx;
                  return (
                    <Button
                      key={idx}
                      type="button"
                      variant="outline"
                      size="icon-xs"
                      aria-pressed={active}
                      aria-label={`Assign ${tab} to group ${idx + 1}`}
                      onClick={() => assign(tab, active ? -1 : idx)}
                      className={cn(
                        'rounded-full text-[10px] tabular-nums',
                        active && cn(GROUP_ACTIVE[idx], 'border-transparent text-background hover:text-background'),
                      )}
                    >
                      {active ? <Check className="size-3" strokeWidth={3} /> : idx + 1}
                    </Button>
                  );
                })}
              </div>
            </li>
          );
        })}
        {tabs.length === 0 ? <li className="px-3 py-6 text-center text-sm text-muted-foreground">No tabs found.</li> : null}
      </ul>
      <p className="text-xs text-muted-foreground tabular-nums">
        {assignedCount} of {tabs.length} tabs assigned
      </p>

      {validation ? <FieldError>{validation}</FieldError> : null}
      {error ? <InlineError>{error}</InlineError> : null}

      <div className="flex flex-wrap gap-2">
        <Button disabled={save.isPending} onClick={submit}>
          {save.isPending ? <Loader2 className="animate-spin" /> : null}
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        {onCancel ? (
          <Button variant="ghost" disabled={save.isPending} onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </Section>
  );
}
