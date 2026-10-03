import { useId } from 'react';
import { cn } from '@/lib/utils';

/**
 * The NAO "eclipse" ring: a crescent that is heavier at the lower left, with a
 * point of light orbiting at the upper right. Drawn in a 32x32 box so it can be
 * reused inside the wordmark, the app icon and the AI avatar.
 */
function EclipseRing({ x = 0, y = 0, s = 1, glow = true }: { x?: number; y?: number; s?: number; glow?: boolean }) {
  const id = useId().replace(/:/g, '');
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <defs>
        <linearGradient id={`${id}-ring`} x1="6" y1="28" x2="27" y2="5" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--logo-ring-from, #1D3FD6)" />
          <stop offset="0.55" stopColor="var(--logo-ring-mid, #3D74FF)" />
          <stop offset="1" stopColor="var(--logo-ring-to, #BFD6FF)" />
        </linearGradient>
        <radialGradient id={`${id}-dot`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="0.45" stopColor="#CFE0FF" />
          <stop offset="1" stopColor="#5B8CFF" stopOpacity="0" />
        </radialGradient>
        <mask id={`${id}-cut`}>
          <rect width="32" height="32" fill="white" />
          <circle cx="17.1" cy="14.9" r="9.1" fill="black" />
        </mask>
      </defs>
      <circle cx="16" cy="16" r="11.5" fill={`url(#${id}-ring)`} mask={`url(#${id}-cut)`} />
      {glow ? <circle cx="24.4" cy="7.6" r="5" fill={`url(#${id}-dot)`} /> : null}
      <circle cx="24.4" cy="7.6" r="1.9" fill="#FFFFFF" />
    </g>
  );
}

/** Icon-only mark. Works on light and dark surfaces. */
export function NaoMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn('size-6 shrink-0', className)}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <EclipseRing />
    </svg>
  );
}

/** Full "NAO" wordmark. Letters follow `currentColor`; the O is the eclipse ring. */
export function NaoWordmark({ className, title = 'NAO' }: { className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 80 28" className={cn('h-5 w-auto shrink-0', className)} role="img" aria-label={title}>
      <path fill="currentColor" d="M2 24.5V4.5h3.1L17.9 19.6V4.5H21v20h-3.1L5.1 9.4v15.1z" />
      <path fill="currentColor" d="M26 24.5 35.6 4.5h2.8l9.6 20h-3.3L37 8.6l-7.7 15.9z" />
      <EclipseRing x={49} y={-1.5} s={0.97} />
    </svg>
  );
}

/** Rounded-square app icon (navy tile with the mark), as used for the favicon. */
export function NaoAppIcon({ className }: { className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg viewBox="0 0 32 32" className={cn('size-8 shrink-0', className)} aria-hidden>
      <defs>
        <linearGradient id={`${id}-tile`} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#111A3F" />
          <stop offset="1" stopColor="#04060F" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id}-tile)`} />
      <EclipseRing x={4} y={4} s={0.75} />
    </svg>
  );
}
