import type { AttachmentFlowStatus } from '../../types/ui';

type Props = {
  /** Non-null: parent only renders this while attachment pipeline runs */
  status: Exclude<AttachmentFlowStatus, null>;
};

/**
 * Linear progress UI meant to sit in the job URL input slot (same row as paperclip).
 */
export function AttachmentJobProgress({ status }: Props) {
  const isSubmitting = status.phase === 'submitting';
  const pct =
    isSubmitting && status.total > 0 ? Math.min(100, (100 * status.submitted) / status.total) : null;

  return (
    <div
      className="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-2 px-3 py-2"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct != null ? Math.round(pct) : undefined}
      aria-valuetext={
        isSubmitting && status.total > 0
          ? `${status.submitted} of ${status.total} job URLs submitted`
          : status.message
      }
      aria-busy
    >
      <div className="flex min-w-0 items-baseline justify-between gap-2 text-[11px] leading-tight sm:text-xs">
        <span className="min-w-0 truncate font-semibold text-slate-800">{status.message}</span>
        {isSubmitting && status.total > 0 ? (
          <span className="shrink-0 tabular-nums font-semibold text-blue-700">
            {status.submitted} / {status.total}
          </span>
        ) : null}
      </div>

      <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-slate-200/90 shadow-[inset_0_1px_2px_rgba(15,23,42,0.08)] ring-1 ring-slate-300/35">
        {status.phase === 'upload_extract' ? (
          <div
            className="attachment-bar-indeterminate absolute inset-y-0 w-[38%] rounded-full bg-gradient-to-r from-sky-500 via-blue-600 to-indigo-600 shadow-sm"
            aria-hidden
          />
        ) : (
          <div
            className="h-full rounded-full bg-gradient-to-r from-sky-500 via-blue-600 to-indigo-600 shadow-[0_0_12px_rgba(37,99,235,0.35)] transition-[width] duration-300 ease-out"
            style={{ width: `${pct ?? 0}%` }}
          />
        )}
      </div>
    </div>
  );
}
