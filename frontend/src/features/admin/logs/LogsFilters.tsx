import { Clock3, Search, Timer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  CATEGORIES,
  HOUR_WINDOWS,
  LEVELS,
  SERVICES,
  type LogFilters,
  type TextDrafts,
  type TextKey,
} from './logFilters';

const ALL = 'all';

const options = (values: readonly string[], allLabel: string) => [
  { value: ALL, label: allLabel },
  ...values.map((v) => ({ value: v, label: v })),
];

const WINDOW_OPTIONS = HOUR_WINDOWS.map((h) => ({ value: String(h), label: `Last ${h}h` }));
const LEVEL_OPTIONS = options(LEVELS, 'All levels');
const CATEGORY_OPTIONS = options(CATEGORIES, 'All categories');

interface Props {
  filters: LogFilters;
  drafts: TextDrafts;
  dirty: boolean;
  onDraft: (key: TextKey, value: string) => void;
  onChange: (patch: Partial<LogFilters>) => void;
  onApply: () => void;
  onClear: () => void;
  onMatchTimings: () => void;
  onJobTimeline: (jobId: string) => void;
}

function FilterSelect({
  id,
  label,
  value,
  items,
  onValue,
}: {
  id: string;
  label: string;
  value: string;
  items: Array<{ value: string; label: string }>;
  onValue: (v: string) => void;
}) {
  return (
    <Field className="gap-1.5">
      <FieldLabel htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </FieldLabel>
      <Select value={value} items={items} onValueChange={(v) => onValue(String(v ?? ALL))}>
        <SelectTrigger id={id} size="sm" className="w-full">
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
    </Field>
  );
}

export function LogsFilters({
  filters,
  drafts,
  dirty,
  onDraft,
  onChange,
  onApply,
  onClear,
  onMatchTimings,
  onJobTimeline,
}: Props) {
  const serviceOptions = options(
    filters.service && !(SERVICES as readonly string[]).includes(filters.service)
      ? [...SERVICES, filters.service]
      : SERVICES,
    'All services',
  );

  const textInput = (key: TextKey, label: string, placeholder: string, mono = false) => (
    <Field className="gap-1.5">
      <FieldLabel htmlFor={`logs-${key}`} className="text-xs text-muted-foreground">
        {label}
      </FieldLabel>
      <Input
        id={`logs-${key}`}
        value={drafts[key]}
        placeholder={placeholder}
        onChange={(e) => onDraft(key, e.target.value)}
        className={cn('h-7', mono && 'font-mono text-xs')}
      />
    </Field>
  );

  return (
    <form
      aria-label="Log filters"
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        onApply();
      }}
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <FilterSelect
          id="logs-window"
          label="Window"
          value={String(filters.hours)}
          items={
            WINDOW_OPTIONS.some((o) => o.value === String(filters.hours))
              ? WINDOW_OPTIONS
              : [...WINDOW_OPTIONS, { value: String(filters.hours), label: `Last ${filters.hours}h` }]
          }
          onValue={(v) => onChange({ hours: Number(v) || 24 })}
        />
        <FilterSelect
          id="logs-level"
          label="Level"
          value={filters.level || ALL}
          items={LEVEL_OPTIONS}
          onValue={(v) => onChange({ level: v === ALL ? '' : v })}
        />
        <FilterSelect
          id="logs-category"
          label="Category"
          value={filters.category || ALL}
          items={CATEGORY_OPTIONS}
          onValue={(v) => onChange({ category: v === ALL ? '' : v })}
        />
        <FilterSelect
          id="logs-service"
          label="Service"
          value={filters.service || ALL}
          items={serviceOptions}
          onValue={(v) => onChange({ service: v === ALL ? '' : v })}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Field className="gap-1.5 lg:col-span-1">
          <FieldLabel htmlFor="logs-event" className="text-xs text-muted-foreground">
            Event contains
          </FieldLabel>
          <InputGroup className="h-7">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              id="logs-event"
              type="search"
              value={drafts.event}
              placeholder="http_request_completed"
              onChange={(e) => onDraft('event', e.target.value)}
              className="font-mono text-xs"
            />
          </InputGroup>
        </Field>
        {textInput('path', 'Path contains', '/api/v1/…', true)}
        {textInput('request', 'Request ID', 'uuid…', true)}
        {textInput('job', 'Job ID', 'match / extract / encode for one job', true)}
        {textInput('user', 'User ID', 'uuid…', true)}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" variant={dirty ? 'default' : 'outline'}>
          Apply filters
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onMatchTimings}>
          <Timer /> Match timings only
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!drafts.job.trim()}
          onClick={() => onJobTimeline(drafts.job.trim())}
        >
          <Clock3 /> Job timeline
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClear}>
          Clear
        </Button>
        {dirty ? <span className="text-xs text-muted-foreground">Press Enter or Apply to search</span> : null}
      </div>
    </form>
  );
}
