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
      className="flex h-full min-w-0 flex-1 items-center gap-2 px-2 sm:px-3"
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
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
        <div className="flex min-w-0 items-center justify-between gap-2 leading-none">
          <span className="min-w-0 truncate text-[10px] font-semibold text-slate-800 sm:text-[11px]">
            {status.message}
          </span>
          {isSubmitting && status.total > 0 ? (
            <span className="shrink-0 text-[10px] font-semibold tabular-nums text-blue-700 sm:text-[11px]">
              {status.submitted}/{status.total}
            </span>
          ) : null}
        </div>

        <div className="relative h-1 w-full overflow-hidden rounded-full bg-slate-200/90 shadow-[inset_0_1px_1px_rgba(15,23,42,0.06)] ring-1 ring-slate-300/30">
          {status.phase === 'upload_extract' ? (
            <div
              className="attachment-bar-indeterminate absolute inset-y-0 w-[38%] rounded-full bg-gradient-to-r from-sky-500 via-blue-600 to-indigo-600"
              aria-hidden
            />
          ) : (
            <div
              className="h-full rounded-full bg-gradient-to-r from-sky-500 via-blue-600 to-indigo-600 transition-[width] duration-300 ease-out"
              style={{ width: `${pct ?? 0}%` }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
