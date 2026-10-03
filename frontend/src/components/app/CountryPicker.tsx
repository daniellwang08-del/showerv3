import { useState } from 'react';
import { Check, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { CountryOption } from '@/types/settings';

/** Chip list of ISO country codes with a searchable "Add country" popover. */
export function CountryPicker({
  value,
  options,
  onChange,
  emptyLabel = 'Worldwide — no country filter',
}: {
  value: string[];
  options: CountryOption[];
  onChange: (next: string[]) => void;
  emptyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const names = new Map(options.map((o) => [o.code, o.name]));
  const toggle = (code: string) =>
    onChange(value.includes(code) ? value.filter((c) => c !== code) : [...value, code]);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.length === 0 ? <span className="text-sm text-muted-foreground">{emptyLabel}</span> : null}
      {value.map((code) => (
        <span
          key={code}
          className="inline-flex items-center gap-1 rounded-full border bg-muted/50 py-0.5 pr-1 pl-2.5 text-xs font-medium"
        >
          {names.get(code) ?? code}
          <button
            type="button"
            aria-label={`Remove ${names.get(code) ?? code}`}
            onClick={() => toggle(code)}
            className="rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<Button variant="outline" size="sm" className="h-7 rounded-full" />}>
          <Plus /> Add country
        </PopoverTrigger>
        <PopoverContent className="w-64 p-0" align="start">
          <Command filter={(item, search) => (item.toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0)}>
            <CommandInput placeholder="Search countries…" aria-label="Search countries" />
            <CommandList>
              <CommandEmpty>No country found.</CommandEmpty>
              <CommandGroup>
                {options.map((o) => (
                  <CommandItem key={o.code} value={`${o.name} ${o.code}`} onSelect={() => toggle(o.code)}>
                    <Check className={value.includes(o.code) ? 'opacity-100' : 'opacity-0'} />
                    {o.name}
                    <span className="ml-auto text-xs text-muted-foreground">{o.code}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
