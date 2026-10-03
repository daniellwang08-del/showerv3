import type { ReactNode } from 'react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import type { SettingsMode } from '@/types/settings';

export function ModeToggle({
  value,
  onChange,
  label,
  disabled,
}: {
  value: SettingsMode;
  onChange: (mode: SettingsMode) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <ToggleGroup
      aria-label={label}
      variant="outline"
      size="sm"
      spacing={0}
      value={[value]}
      disabled={disabled}
      onValueChange={(next) => {
        const mode = next[0] as SettingsMode | undefined;
        if (mode) onChange(mode);
      }}
    >
      <ToggleGroupItem value="default">Default</ToggleGroupItem>
      <ToggleGroupItem value="custom">Custom</ToggleGroupItem>
    </ToggleGroup>
  );
}

export function TriStateToggle({
  value,
  onChange,
  label,
  yesLabel = 'Yes',
  noLabel = 'No',
}: {
  value: boolean | null | undefined;
  onChange: (value: boolean | null) => void;
  label: string;
  yesLabel?: string;
  noLabel?: string;
}) {
  const current = value === true ? 'yes' : value === false ? 'no' : 'unspecified';
  return (
    <ToggleGroup
      aria-label={label}
      variant="outline"
      size="sm"
      spacing={0}
      className="w-full"
      value={[current]}
      onValueChange={(next) => {
        const v = next[0];
        if (v) onChange(v === 'yes' ? true : v === 'no' ? false : null);
      }}
    >
      <ToggleGroupItem value="yes" className="flex-1">
        {yesLabel}
      </ToggleGroupItem>
      <ToggleGroupItem value="no" className="flex-1">
        {noLabel}
      </ToggleGroupItem>
      <ToggleGroupItem value="unspecified" className="flex-1">
        Unspecified
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

export function StatTiles({ label, items }: { label: string; items: { label: string; value: number }[] }) {
  return (
    <dl aria-label={label} className={cn('grid gap-2', items.length === 4 ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3')}>
      {items.map((item) => (
        <div key={item.label} className="rounded-lg border bg-muted/40 px-3 py-2">
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className="text-lg font-semibold tabular-nums">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Label + description on the left, control on the right. */
export function SettingRow({
  id,
  title,
  description,
  children,
  className,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <p id={`${id}-label`} className="text-sm font-medium">
          {title}
        </p>
        {description ? (
          <p id={`${id}-desc`} className="mt-0.5 text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}