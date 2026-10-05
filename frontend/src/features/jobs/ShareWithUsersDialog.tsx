import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useJobAddStore } from '@/stores/jobAddStore';

export function ShareWithUsersDialog() {
  const pickerBatchId = useJobAddStore((s) => s.pickerBatchId);
  const closePicker = useJobAddStore((s) => s.closePicker);
  const targets = useJobAddStore((s) => s.targets);
  const batches = useJobAddStore((s) => s.batches);
  const share = useJobAddStore((s) => s.share);
  const loadTargets = useJobAddStore((s) => s.loadTargets);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const batch = batches.find((row) => row.id === pickerBatchId) ?? null;
  const open = pickerBatchId != null;

  useEffect(() => {
    if (!pickerBatchId) return;
    void loadTargets();
    const current = useJobAddStore.getState().batches.find((row) => row.id === pickerBatchId);
    setSelected(current?.share_users.map((p) => p.id) ?? []);
    setQuery('');
  }, [pickerBatchId, loadTargets]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return targets;
    return targets.filter(
      (person) => person.name.toLowerCase().includes(q) || person.email.toLowerCase().includes(q),
    );
  }, [query, targets]);

  const toggle = (id: string) => {
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  };

  const onOpenChange = (next: boolean) => {
    if (!next) {
      setQuery('');
      setSelected([]);
      closePicker();
    } else {
      void loadTargets();
      if (batch) setSelected(batch.share_users.map((p) => p.id));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share with specific people</DialogTitle>
          <DialogDescription>
            Only the people you pick can see these {batch ? `${batch.job_count} ` : ''}
            added job{batch?.job_count === 1 ? '' : 's'}.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or email"
          aria-label="Search people"
        />
        <div className="max-h-64 overflow-y-auto rounded-lg border">
          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {targets.length === 0 ? 'No other approved users yet.' : 'No matching people.'}
            </p>
          ) : (
            <ul className="divide-y">
              {filtered.map((person) => {
                const checked = selected.includes(person.id);
                return (
                  <li key={person.id}>
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-muted/60">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggle(person.id)}
                        aria-label={`Share with ${person.name}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{person.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">{person.email}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={selected.length === 0 || saving || !pickerBatchId}
            onClick={() => {
              if (!pickerBatchId) return;
              setSaving(true);
              void share(pickerBatchId, 'users', selected).then((next) => {
                setSaving(false);
                if (next) onOpenChange(false);
              });
            }}
          >
            Share
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
