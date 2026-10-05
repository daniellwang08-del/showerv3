import { useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { countryCodesForValue } from '@/constants/countryCodes';
import { cn } from '@/lib/utils';
import { normalizeDateInput } from './profileSections';

function RequiredMark() {
  return (
    <span className="text-muted-foreground" aria-hidden>
      *
    </span>
  );
}

export function TextField({
  id,
  label,
  value,
  onChange,
  onBlur,
  error,
  required,
  description,
  placeholder,
  type = 'text',
  autoComplete,
  multiline,
  rows,
  maxLength,
  className,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  error?: string;
  required?: boolean;
  description?: ReactNode;
  placeholder?: string;
  type?: string;
  autoComplete?: string;
  multiline?: boolean;
  rows?: number;
  /** Shows a live character counter; the limit is enforced by validation, not by truncation. */
  maxLength?: number;
  className?: string;
}) {
  const describedBy = [description ? `${id}-desc` : null, error ? `${id}-error` : null].filter(Boolean).join(' ');
  const shared = {
    id,
    value,
    placeholder,
    'aria-invalid': error ? true : undefined,
    'aria-required': required || undefined,
    'aria-describedby': describedBy || undefined,
    onBlur,
  };
  return (
    <Field data-invalid={error ? true : undefined} className={cn('gap-1.5', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <FieldLabel htmlFor={id}>
          {label}
          {required ? <RequiredMark /> : null}
        </FieldLabel>
        {maxLength ? (
          <span
            className={cn(
              'text-xs tabular-nums text-muted-foreground',
              value.length > maxLength && 'text-destructive',
            )}
          >
            {value.length.toLocaleString()} / {maxLength.toLocaleString()}
          </span>
        ) : null}
      </div>
      {multiline ? (
        <Textarea {...shared} rows={rows} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input {...shared} type={type} autoComplete={autoComplete} onChange={(e) => onChange(e.target.value)} />
      )}
      {description ? <FieldDescription id={`${id}-desc`}>{description}</FieldDescription> : null}
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </Field>
  );
}

/** Free-text date input; normalizes "Jan 2022" → "2022-01" on blur. */
export function DateField({
  id,
  label,
  value,
  onChange,
  onBlur,
  error,
  allowPresent,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  error?: string;
  allowPresent?: boolean;
}) {
  return (
    <TextField
      id={id}
      label={label}
      value={value}
      onChange={onChange}
      error={error}
      placeholder={allowPresent ? 'e.g. Jan 2022 or Present' : 'e.g. Jan 2022'}
      description={allowPresent ? 'Year, month + year, or “Present”' : 'Year or month + year'}
      onBlur={() => {
        const next = normalizeDateInput(value, !!allowPresent);
        if (next !== value) onChange(next);
        onBlur?.();
      }}
    />
  );
}

export function SelectField({
  id,
  label,
  value,
  onChange,
  options,
  error,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  error?: string;
}) {
  const NONE = '__none';
  const items = [{ value: NONE, label: 'Not specified' }, ...options];
  return (
    <Field data-invalid={error ? true : undefined} className="gap-1.5">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        items={items}
        value={value || NONE}
        onValueChange={(v) => onChange(!v || v === NONE ? '' : String(v))}
      >
        <SelectTrigger id={id} className="w-full" aria-invalid={error ? true : undefined}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}

export function CountryCodePicker({
  id,
  value,
  onChange,
  error,
  label = 'Country code',
  required = true,
  compact = false,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  label?: string;
  required?: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const codes = countryCodesForValue(value);
  const current = codes.find((c) => c.code === value);
  const trigger = (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            id={id}
            variant="outline"
            className={cn(
              'w-full justify-between font-normal',
              compact && 'h-[30px] px-2.5 text-xs',
            )}
            aria-invalid={error ? true : undefined}
          />
        }
      >
        <span className="truncate tabular-nums">
          {value || '+1'}
          {current ? <span className="text-muted-foreground"> {current.country}</span> : null}
        </span>
        <ChevronsUpDown className="text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search country or code" aria-label="Search country codes" />
          <CommandList>
            <CommandEmpty>No match.</CommandEmpty>
            <CommandGroup>
              {codes.map((c) => (
                <CommandItem
                  key={`${c.code}-${c.country}`}
                  value={`${c.code} ${c.country}`}
                  data-checked={c.code === value}
                  onSelect={() => {
                    onChange(c.code);
                    setOpen(false);
                  }}
                >
                  <span className="w-12 tabular-nums">{c.code}</span>
                  <span className="text-muted-foreground">{c.country}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );

  if (compact) {
    return (
      <label className="block">
        {label ? <div className="mb-1 text-xs font-medium text-foreground/80">{label}</div> : null}
        {trigger}
        {error ? <p className="mt-1 text-[11px] text-destructive">{error}</p> : null}
      </label>
    );
  }

  return (
    <Field data-invalid={error ? true : undefined} className="gap-1.5">
      <FieldLabel htmlFor={id}>
        {label}
        {required ? <RequiredMark /> : null}
      </FieldLabel>
      {trigger}
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}

/** Editable list of single-line strings with add / remove / reorder. */
export function LineListEditor({
  id,
  label,
  lines,
  onChange,
  max,
  maxLength,
  placeholder,
  addLabel,
  description,
  errorFor,
  error,
}: {
  id: string;
  label: string;
  lines: string[];
  onChange: (lines: string[]) => void;
  max?: number;
  maxLength?: number;
  placeholder?: string;
  addLabel: string;
  description?: ReactNode;
  errorFor?: (index: number) => string | undefined;
  error?: string;
}) {
  const rows = lines.length ? lines : [''];
  const set = (i: number, v: string) => onChange(rows.map((x, j) => (j === i ? v : x)));
  const move = (i: number, d: -1 | 1) => onChange(moveItem(rows, i, d));
  const remove = (i: number) => {
    const next = rows.filter((_, j) => j !== i);
    onChange(next.length ? next : ['']);
  };
  const atMax = max != null && rows.length >= max;
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1.5 text-sm font-medium">{label}</legend>
      {description ? <p className="-mt-1 text-sm text-muted-foreground">{description}</p> : null}
      <ol className="flex flex-col gap-2">
        {rows.map((line, i) => {
          const rowError = errorFor?.(i);
          const n = i + 1;
          return (
            <li key={i} className="flex flex-col gap-1">
              <div className="flex items-center gap-1">
                <Input
                  id={`${id}-${i}`}
                  aria-label={`${label} ${n}`}
                  value={line}
                  placeholder={placeholder}
                  aria-invalid={rowError ? true : undefined}
                  onChange={(e) => set(i, e.target.value)}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move ${label.toLowerCase()} ${n} up`}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  <ArrowUp />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move ${label.toLowerCase()} ${n} down`}
                  disabled={i === rows.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <ArrowDown />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${label.toLowerCase()} ${n}`}
                  onClick={() => remove(i)}
                >
                  <X />
                </Button>
              </div>
              {rowError ? <FieldError>{rowError}</FieldError> : null}
              {maxLength && line.length > maxLength ? (
                <p className="text-xs tabular-nums text-destructive">
                  {line.length} / {maxLength} characters
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
      <div className="flex items-center gap-3">
        <Button type="button" variant="outline" size="sm" disabled={atMax} onClick={() => onChange([...rows, ''])}>
          <Plus />
          {addLabel}
        </Button>
        {max != null ? (
          <span className="text-xs tabular-nums text-muted-foreground">
            {rows.filter((r) => r.trim()).length} / {max}
          </span>
        ) : null}
      </div>
      {error ? <FieldError>{error}</FieldError> : null}
    </fieldset>
  );
}

/** Header strip for a repeatable entry (work role, school…) with reorder + remove. */
export function EntryHeader({
  title,
  index,
  count,
  noun,
  onMove,
  onRemove,
}: {
  title: string;
  index: number;
  count: number;
  noun: string;
  onMove?: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const n = index + 1;
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className="min-w-0 truncate text-sm font-medium">{title}</h3>
      <div className="flex shrink-0 items-center gap-0.5">
        {onMove ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Move ${noun} ${n} up`}
              disabled={index === 0}
              onClick={() => onMove(-1)}
            >
              <ArrowUp />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Move ${noun} ${n} down`}
              disabled={index === count - 1}
              onClick={() => onMove(1)}
            >
              <ArrowDown />
            </Button>
          </>
        ) : null}
        <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${noun} ${n}`} onClick={onRemove}>
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}

export function AddRowButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button type="button" variant="outline" size="sm" className="self-start" onClick={onClick}>
      <Plus />
      {children}
    </Button>
  );
}

export function ViewRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[10rem_1fr] sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

export function EmptyValue({ children = 'Not set' }: { children?: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

export function moveItem<T>(list: T[], index: number, dir: -1 | 1): T[] {
  const j = index + dir;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[index], next[j]] = [next[j], next[index]];
  return next;
}
