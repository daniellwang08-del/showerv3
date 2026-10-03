import { cn } from '@/lib/utils';

const LEVEL_CLASS: Record<string, string> = {
  debug: 'bg-muted text-muted-foreground',
  info: 'bg-status-new/12 text-status-new',
  warning: 'bg-status-preparing/15 text-status-preparing',
  error: 'bg-status-failed/12 text-status-failed',
  critical: 'bg-status-failed/20 text-status-failed ring-1 ring-inset ring-status-failed/40',
};

export function LogLevelBadge({ level, className }: { level: string; className?: string }) {
  const key = level.toLowerCase();
  return (
    <span
      data-level={key}
      className={cn(
        'inline-flex h-5 items-center rounded-md px-1.5 text-[11px] font-semibold uppercase tracking-wide',
        LEVEL_CLASS[key] ?? LEVEL_CLASS.info,
        className,
      )}
    >
      {level}
    </span>
  );
}
