import { NaoMark } from '@/components/brand/NaoLogo';

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
 *  A thin brand-blue orbit circles the NAO mark so every screen shares one
 *  consistent, on-brand loading experience in light and dark mode. */
export function BrandedLoader({
  label = 'Loading…',
  fullscreen = false,
  compact = false,
  className = '',
}: BrandedLoaderProps) {
  const mark = compact ? 'h-12 w-12' : 'h-20 w-20';
  const logo = compact ? 'size-6' : 'size-10';
  const ring = compact ? 'border-2' : 'border-[2.5px]';

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={[
        fullscreen
          ? 'fixed inset-0 z-[300] bg-background'
          : compact
            ? 'w-full'
            : 'h-full min-h-[240px] w-full',
        'flex flex-col items-center justify-center',
        compact ? 'gap-3 py-8' : 'gap-5',
        className,
      ].join(' ')}
    >
      <div className={`relative ${mark}`}>
        <span aria-hidden className="absolute inset-0 rounded-full bg-brand-soft" />
        <span
          aria-hidden
          className={`absolute inset-0 rounded-full ${ring} border-brand/15 border-t-brand motion-safe:animate-spin [animation-duration:1.1s]`}
        />
        <span className="absolute inset-0 flex items-center justify-center">
          <NaoMark className={logo} />
        </span>
      </div>
      <div className="flex flex-col items-center gap-1 text-center">
        <span className={`font-semibold text-foreground ${compact ? 'text-xs' : 'text-sm'}`}>
          {label}
        </span>
        {!compact ? (
          <span className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
            NAO
          </span>
        ) : null}
      </div>
      <span className="sr-only">Loading, please wait.</span>
    </div>
  );
}
