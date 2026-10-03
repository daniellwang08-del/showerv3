import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import type { SystemLogEvent } from '@/types/systemLogs';
import { LogLevelBadge } from './LogLevelBadge';
import { formatTime, httpLine } from './logFilters';

interface Props {
  items: SystemLogEvent[];
  loading: boolean;
  activeId: string | null;
  onOpen: (event: SystemLogEvent) => void;
  onOpenRequest: (requestId: string) => void;
  empty: ReactNode;
}

const COLUMNS = ['Time', 'Level', 'Category', 'Event / message', 'Service', 'Request', 'Duration'];

export function LogsTable({ items, loading, activeId, onOpen, onOpenRequest, empty }: Props) {
  return (
    <div className="scrollbar-thin max-h-[calc(100dvh-14rem)] min-h-64 overflow-auto">
      <table className="w-full min-w-[56rem] text-left text-sm">
        <thead className="sticky top-0 z-10 bg-card text-xs text-muted-foreground shadow-[inset_0_-1px_0_var(--border)]">
          <tr>
            {COLUMNS.map((c) => (
              <th key={c} scope="col" className="px-3 py-2.5 font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {loading && items.length === 0 ? (
            Array.from({ length: 8 }, (_, i) => (
              <tr key={i} data-testid="log-row-skeleton">
                <td colSpan={COLUMNS.length} className="px-3 py-2.5">
                  <Skeleton className="h-5 w-full" />
                </td>
              </tr>
            ))
          ) : items.length === 0 ? (
            <tr>
              <td colSpan={COLUMNS.length} className="p-0">
                {empty}
              </td>
            </tr>
          ) : (
            items.map((row) => {
              const http = httpLine(row);
              return (
                <tr
                  key={row.id}
                  data-log-id={row.id}
                  tabIndex={0}
                  aria-selected={row.id === activeId}
                  onClick={() => onOpen(row)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpen(row);
                    }
                  }}
                  className={cn(
                    'cursor-pointer align-top outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50',
                    row.id === activeId && 'bg-brand-soft/60 hover:bg-brand-soft/60',
                  )}
                >
                  <td className="whitespace-nowrap px-3 py-2 text-xs tabular-nums text-muted-foreground">
                    {formatTime(row.created_at)}
                  </td>
                  <td className="px-3 py-2">
                    <LogLevelBadge level={row.level} />
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{row.category}</td>
                  <td className="max-w-[32rem] px-3 py-2">
                    <div className="truncate font-mono text-xs font-medium text-foreground">{row.event}</div>
                    {http ? <div className="truncate font-mono text-xs text-muted-foreground">{http}</div> : null}
                    {row.message ? (
                      <div className="truncate font-mono text-xs text-muted-foreground">{row.message}</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{row.service}</td>
                  <td className="px-3 py-2">
                    {row.request_id ? (
                      <button
                        type="button"
                        aria-label={`Open request timeline ${row.request_id}`}
                        title="Open request timeline"
                        className="rounded font-mono text-[11px] text-brand outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenRequest(row.request_id!);
                        }}
                      >
                        {row.request_id.slice(0, 8)}…
                      </button>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs tabular-nums text-muted-foreground">
                    {row.duration_ms != null ? `${row.duration_ms} ms` : '-'}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
