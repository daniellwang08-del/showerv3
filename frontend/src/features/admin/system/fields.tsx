import type { ReactNode } from 'react';
import { AlertCircle, Loader2, RotateCw, Undo2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertAction, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { SystemSettingItem } from '@/types/admin';
import { cn } from '@/lib/utils';
import { useImmediateSetting, useRevertSetting } from './queries';
import { savedString, type Option } from './settingsModel';
import type { SettingsDraft } from './useSettingsDraft';

const fieldId = (key: string) => `sys-${key.replace(/_/g, '-')}`;

function SourceBadge({ item }: { item: SystemSettingItem }) {
  return (
    <Badge variant={item.overridden ? 'secondary' : 'outline'} className="h-4 px-1.5 text-[10px]">
      {item.overridden ? 'DB' : '.env'}
    </Badge>
  );
}

/** Label row with the value source and a revert-to-.env button when overridden. */
function SettingLabel({
  id,
  label,
  item,
  onReverted,
}: {
  id: string;
  label: string;
  item: SystemSettingItem;
  onReverted?: (key: string) => void;
}) {
  const revert = useRevertSetting(onReverted);
  return (
    <div className="flex min-h-5 items-center gap-1.5">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <SourceBadge item={item} />
      {item.overridden ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                className="ml-auto text-muted-foreground"
                aria-label={`Revert ${label} to .env`}
                disabled={revert.isPending}
                onClick={() => revert.mutate(item.key)}
              />
            }
          >
            {revert.isPending ? <Loader2 className="animate-spin" /> : <Undo2 />}
          </TooltipTrigger>
          <TooltipContent>Revert to .env ({String(item.env_default ?? '') || 'empty'})</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}

export function NumberSetting({
  draft,
  k,
  label,
  hint,
  suffix,
}: {
  draft: SettingsDraft;
  k: string;
  label: string;
  hint?: ReactNode;
  suffix?: string;
}) {
  const item = draft.item(k);
  if (!item) return null;
  const id = fieldId(k);
  const error = draft.error(k);
  return (
    <Field data-invalid={error ? true : undefined}>
      <SettingLabel id={id} label={label} item={item} onReverted={(key) => draft.clear([key])} />
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          value={draft.value(k)}
          aria-invalid={error ? true : undefined}
          onChange={(e) => draft.set(k, e.target.value)}
          className="tabular-nums"
        />
        {suffix ? <span className="shrink-0 text-sm text-muted-foreground">{suffix}</span> : null}
      </div>
      {error ? <FieldError>{error}</FieldError> : hint ? <FieldDescription>{hint}</FieldDescription> : null}
    </Field>
  );
}

export function TextSetting({
  draft,
  k,
  label,
  hint,
  type = 'text',
  placeholder,
  className,
}: {
  draft: SettingsDraft;
  k: string;
  label: string;
  hint?: ReactNode;
  type?: 'text' | 'password';
  placeholder?: string;
  className?: string;
}) {
  const item = draft.item(k);
  if (!item) return null;
  const id = fieldId(k);
  return (
    <Field className={className}>
      <SettingLabel id={id} label={label} item={item} onReverted={(key) => draft.clear([key])} />
      <Input
        id={id}
        type={type}
        autoComplete={type === 'password' ? 'new-password' : undefined}
        value={draft.value(k)}
        placeholder={placeholder}
        onChange={(e) => draft.set(k, e.target.value)}
        className={type === 'text' ? 'font-mono' : undefined}
      />
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
    </Field>
  );
}

export function OptionSelect({
  id,
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
  className,
  placeholder,
}: {
  id?: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  placeholder?: string;
}) {
  return (
    <Select
      items={options.map((o) => ({ value: o.value, label: o.label }))}
      value={value || null}
      disabled={disabled}
      onValueChange={(v) => v != null && onChange(String(v))}
    >
      <SelectTrigger id={id} aria-label={ariaLabel} className={cn('w-full', className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{o.label}</span>
              {o.description ? <span className="text-xs text-muted-foreground">{o.description}</span> : null}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function SelectSetting({
  draft,
  k,
  label,
  options,
  hint,
  fallback,
}: {
  draft: SettingsDraft;
  k: string;
  label: string;
  options: Option[];
  hint?: ReactNode;
  fallback?: string;
}) {
  const item = draft.item(k);
  if (!item) return null;
  const id = fieldId(k);
  return (
    <Field>
      <SettingLabel id={id} label={label} item={item} onReverted={(key) => draft.clear([key])} />
      <OptionSelect id={id} value={draft.value(k) || fallback || ''} options={options} onChange={(v) => draft.set(k, v)} />
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
    </Field>
  );
}

/** Boolean setting that saves on toggle (optimistic, rolls back on error). */
export function ToggleSetting({
  item,
  label,
  description,
}: {
  item: SystemSettingItem | undefined;
  label: string;
  description?: ReactNode;
}) {
  const save = useImmediateSetting();
  if (!item) return null;
  const id = fieldId(item.key);
  const checked = savedString(item) === 'true';
  return (
    <div className="flex items-start justify-between gap-4 py-1">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <p id={`${id}-label`} className="text-sm font-medium">
            {label}
          </p>
          <SourceBadge item={item} />
        </div>
        {description ? (
          <p id={`${id}-desc`} className="mt-0.5 text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        {save.isPending ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden /> : null}
        <Switch
          aria-labelledby={`${id}-label`}
          aria-describedby={description ? `${id}-desc` : undefined}
          checked={checked}
          disabled={save.isPending}
          onCheckedChange={(next) => save.mutate({ key: item.key, value: next ? 'true' : 'false' })}
        />
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? 'destructive' : 'default'}
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function QueryError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertTitle>{message}</AlertTitle>
      <AlertAction>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCw />
          Retry
        </Button>
      </AlertAction>
    </Alert>
  );
}

export function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: 'ok' | 'bad';
}) {
  return (
    <div className="rounded-lg border bg-muted/40 px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'mt-0.5 text-sm font-semibold tabular-nums',
          tone === 'ok' && 'text-status-ready',
          tone === 'bad' && 'text-destructive',
        )}
      >
        {value}
      </dd>
    </div>
  );
}
