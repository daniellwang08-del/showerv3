import { useId, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Toggle } from '@/components/ui/toggle';
import { cn } from '@/lib/utils';
import {
  AUTO_POST_WORK_MODE_OPTIONS,
  autoPostFiltersEqual,
  normalizeAutoPostFilters,
  type AutoPostFilters,
  type AutoPostWorkMode,
} from '@/types/autoPostFilters';

export const AUTO_POST_PRESETS = [0, 60, 70, 75, 80] as const;

export interface AutoPostValue {
  threshold: number;
  filters: AutoPostFilters;
}

export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function autoPostEqual(a: AutoPostValue, b: AutoPostValue): boolean {
  return a.threshold === b.threshold && autoPostFiltersEqual(a.filters, b.filters);
}

/** Local edits on top of the saved auto-post settings; `draft` is null while clean. */
export function useAutoPostDraft(saved: AutoPostValue) {
  const [draft, setDraft] = useState<AutoPostValue | null>(null);
  const value = draft ?? saved;
  const dirty = draft !== null && !autoPostEqual(draft, saved);
  return {
    value,
    dirty,
    setValue: (next: AutoPostValue) => setDraft(next),
    reset: () => setDraft(null),
    payload: () => ({
      auto_post_threshold: value.threshold,
      auto_post_filters: normalizeAutoPostFilters(value.filters),
    }),
  };
}

export function AutoPostSettings({
  value,
  onChange,
  disabled,
  description,
}: {
  value: AutoPostValue;
  onChange: (next: AutoPostValue) => void;
  disabled?: boolean;
  description?: string;
}) {
  const id = useId();
  const sliderLabelId = `${id}-slider`;
  const setThreshold = (n: number) => onChange({ ...value, threshold: clampScore(n) });
  const setFilters = (filters: AutoPostFilters) => onChange({ ...value, filters });

  const toggleMode = (mode: AutoPostWorkMode, pressed: boolean) => {
    const modes = new Set(value.filters.work_modes);
    if (pressed) modes.add(mode);
    else modes.delete(mode);
    setFilters({ ...value.filters, work_modes: AUTO_POST_WORK_MODE_OPTIONS.map((o) => o.value).filter((m) => modes.has(m)) });
  };

  return (
    <FieldGroup className="gap-5">
      {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}

      <Field>
        <div className="flex items-center justify-between">
          <FieldLabel id={sliderLabelId}>Minimum match score</FieldLabel>
          <span className="text-sm font-medium tabular-nums">{value.threshold}</span>
        </div>
        <Slider
          aria-labelledby={sliderLabelId}
          value={[value.threshold]}
          min={0}
          max={100}
          step={1}
          disabled={disabled}
          onValueChange={(v) => setThreshold(Array.isArray(v) ? (v[0] ?? 0) : (v as number))}
          className="py-2"
        />
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <FieldLabel htmlFor={`${id}-exact`} className="text-xs text-muted-foreground">
              Exact score
            </FieldLabel>
            <Input
              id={`${id}-exact`}
              type="number"
              inputMode="numeric"
              min={0}
              max={100}
              value={value.threshold}
              disabled={disabled}
              onChange={(e) => setThreshold(Number(e.target.value) || 0)}
              className="w-20 tabular-nums"
            />
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Score presets">
            {AUTO_POST_PRESETS.map((preset) => (
              <Button
                key={preset}
                type="button"
                size="sm"
                variant="outline"
                aria-pressed={value.threshold === preset}
                disabled={disabled}
                onClick={() => setThreshold(preset)}
                className={cn('tabular-nums', value.threshold === preset && 'border-brand bg-brand-soft text-brand hover:bg-brand-soft')}
              >
                {preset === 0 ? 'All (0)' : preset}
              </Button>
            ))}
          </div>
        </div>
      </Field>

      <FieldSet className="gap-2">
        <div className="flex items-center justify-between gap-2">
          <FieldLegend variant="label" className="mb-0">Work mode</FieldLegend>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={disabled || value.filters.work_modes.length === 0}
            onClick={() => setFilters({ ...value.filters, work_modes: [] })}
          >
            Allow all
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {AUTO_POST_WORK_MODE_OPTIONS.map(({ value: mode, label }) => (
            <Toggle
              key={mode}
              variant="outline"
              size="sm"
              disabled={disabled}
              pressed={value.filters.work_modes.includes(mode)}
              onPressedChange={(pressed) => toggleMode(mode, pressed)}
              className="rounded-full px-3 aria-pressed:border-brand aria-pressed:bg-brand-soft aria-pressed:text-brand"
            >
              {label}
            </Toggle>
          ))}
        </div>
        <FieldDescription className="text-xs">
          {value.filters.work_modes.length === 0
            ? 'Any work mode (remote, hybrid, or onsite)'
            : `Only: ${value.filters.work_modes.join(', ')}`}
        </FieldDescription>
      </FieldSet>

      <ExcludeCompanies
        values={value.filters.exclude_companies}
        disabled={disabled}
        onChange={(exclude_companies) => setFilters({ ...value.filters, exclude_companies })}
      />
    </FieldGroup>
  );
}

function ExcludeCompanies({
  values,
  disabled,
  onChange,
}: {
  values: string[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState('');

  const add = () => {
    const name = draft.trim();
    if (disabled || !name) return;
    if (!values.some((v) => v.toLowerCase() === name.toLowerCase())) onChange([...values, name]);
    setDraft('');
  };

  return (
    <Field className="gap-2">
      <FieldLabel htmlFor={id}>Exclude companies</FieldLabel>
      <FieldDescription className="text-xs">
        Skip auto-post when the company name contains any of these (e.g. former employers).
      </FieldDescription>
      <div className="flex gap-2">
        <Input
          id={id}
          value={draft}
          disabled={disabled}
          placeholder="e.g. Acme Corp"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button type="button" variant="outline" disabled={disabled || !draft.trim()} onClick={add}>
          Add
        </Button>
      </div>
      {values.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Excluded companies">
          {values.map((name) => (
            <li
              key={name}
              className="inline-flex items-center gap-1 rounded-full border bg-muted py-0.5 pr-1 pl-2.5 text-xs"
            >
              {name}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="rounded-full"
                disabled={disabled}
                aria-label={`Remove ${name}`}
                onClick={() => onChange(values.filter((v) => v !== name))}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </Field>
  );
}
