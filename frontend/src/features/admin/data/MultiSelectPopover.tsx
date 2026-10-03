import { useId } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

export type MultiOption = { id: string; label: string };

export function MultiSelectPopover({
  label,
  options,
  selected,
  onChange,
  emptyLabel = 'No options',
  maxSelect,
  helperText,
  disabled,
  className,
}: {
  label: string;
  options: MultiOption[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  emptyLabel?: string;
  maxSelect?: number;
  helperText?: string;
  disabled?: boolean;
  className?: string;
}) {
  const labelId = useId();
  const limit = maxSelect ?? options.length;
  const capped = options.slice(0, limit);
  const allSelected =
    options.length > 0 && selected.size === Math.min(options.length, limit) && capped.every((o) => selected.has(o.id));

  const summary =
    selected.size === 0
      ? 'None selected'
      : selected.size === options.length
        ? `All (${options.length})`
        : `${selected.size} selected`;

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else if (!maxSelect || next.size < maxSelect) next.add(id);
    onChange(next);
  };

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5 sm:w-64', className)}>
      <span id={labelId} className="text-sm font-medium">
        {label}
      </span>
      <Popover>
        <PopoverTrigger
          disabled={disabled}
          aria-labelledby={labelId}
          render={
            <Button variant="outline" className="w-full justify-between font-normal">
              <span className="truncate">{summary}</span>
              <ChevronDown className="text-muted-foreground" aria-hidden />
            </Button>
          }
        />
        <PopoverContent align="start" className="w-(--anchor-width) min-w-64 gap-1 p-1">
          {options.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">{emptyLabel}</p>
          ) : (
            <>
              <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium hover:bg-muted">
                <Checkbox
                  checked={allSelected}
                  indeterminate={!allSelected && selected.size > 0}
                  onCheckedChange={() => onChange(allSelected ? new Set() : new Set(capped.map((o) => o.id)))}
                />
                {maxSelect && options.length > maxSelect ? `Select first ${maxSelect}` : 'Select all'}
              </label>
              <Separator />
              <div className="scrollbar-thin max-h-64 overflow-y-auto">
                {options.map((o) => {
                  const checked = selected.has(o.id);
                  const atCap = Boolean(maxSelect && !checked && selected.size >= maxSelect);
                  return (
                    <label
                      key={o.id}
                      className={cn(
                        'flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted',
                        atCap && 'cursor-not-allowed opacity-50',
                      )}
                    >
                      <Checkbox
                        className="mt-0.5"
                        checked={checked}
                        disabled={atCap}
                        onCheckedChange={() => toggle(o.id)}
                      />
                      <span className="min-w-0 break-words">{o.label}</span>
                    </label>
                  );
                })}
              </div>
            </>
          )}
        </PopoverContent>
      </Popover>
      {helperText ? <p className="text-xs text-muted-foreground">{helperText}</p> : null}
    </div>
  );
}
