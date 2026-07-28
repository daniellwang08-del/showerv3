type BrandedLoaderProps = {
  /** Short status message shown under the mark. */
  label?: string;
  /** Cover the whole viewport (used for the initial app boot). */
  fullscreen?: boolean;
  /** Smaller mark for section / overlay loading (same visual language). */
  compact?: boolean;
  className?: string;
};

/** Professional, branded loading state shown while a page's data is still loading.
 *  A spinning accent ring wraps the Atomspace mark so every screen shares one
 *  consistent, on-brand loading experience in light and dark mode. */
export function BrandedLoader({
  label = 'Loading…',
  fullscreen = false,
  compact = false,
  className = '',
}: BrandedLoaderProps) {
  const mark = compact ? 'h-12 w-12' : 'h-20 w-20';
  const logo = compact ? 'h-6 w-6' : 'h-10 w-10';
  const ring = compact ? 'border-2' : 'border-[3px]';
  const inset = compact ? 'inset-1.5' : 'inset-2';

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={[
        fullscreen
          ? 'fixed inset-0 z-[300] bg-slate-50 dark:bg-slate-950'
          : compact
            ? 'w-full'
            : 'h-full min-h-[240px] w-full',
        'flex flex-col items-center justify-center',
        compact ? 'gap-3 py-8' : 'gap-5',
        className,
      ].join(' ')}
    >
      <div className={`relative ${mark}`}>
        <span
          aria-hidden
          className={`absolute inset-0 rounded-full ${ring} border-blue-500/15 border-t-blue-600 dark:border-blue-400/15 dark:border-t-blue-400 animate-spin [animation-duration:0.9s]`}
        />
        <span
          aria-hidden
          className={`absolute ${inset} rounded-full bg-blue-500/5 dark:bg-blue-400/5 animate-ping [animation-duration:1.6s]`}
        />
        <span className="absolute inset-0 flex items-center justify-center">
          <img
            src="/atomspace-logo.png"
            alt=""
            className={`${logo} object-contain drop-shadow-sm motion-safe:animate-pulse`}
          />
        </span>
      </div>
      <div className="flex flex-col items-center gap-1 text-center">
        <span
          className={`font-semibold text-slate-700 dark:text-slate-200 ${
            compact ? 'text-xs' : 'text-sm'
          }`}
        >
          {label}
        </span>
        {!compact ? (
          <span className="text-[11px] font-medium uppercase tracking-[0.2em] text-slate-400 dark:text-slate-500">
            Atomspace
          </span>
        ) : null}
      </div>
      <span className="sr-only">Loading, please wait.</span>
    </div>
  );
}
