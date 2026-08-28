import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/**
 * Shared building blocks for the public landing page.
 *
 * The page is deliberately painted with fixed dark values and white/alpha
 * layers instead of the slate/gray scale. The app remaps that neutral palette
 * for dark mode (see style.css), so a marketing surface built on it would
 * invert into unreadable text. These primitives keep one look in both themes.
 */

export const LANDING_CONTAINER = 'mx-auto w-full max-w-7xl px-5 sm:px-8';

/** Padding is intentionally left out of the base button classes so callers pick
 *  a size without needing an important override. */
export const ctaPrimaryClass =
  'group relative inline-flex items-center justify-center gap-2 overflow-hidden rounded-full bg-gradient-to-r from-sky-500 via-blue-600 to-indigo-600 text-sm font-bold text-white shadow-[0_14px_40px_-12px_rgba(37,99,235,0.9)] transition duration-300 hover:from-sky-400 hover:via-blue-500 hover:to-indigo-500 hover:shadow-[0_18px_50px_-12px_rgba(56,189,248,0.75)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#05070f]';

export const ctaGhostClass =
  'inline-flex items-center justify-center gap-2 rounded-full border border-white/20 bg-white/5 text-sm font-bold text-white backdrop-blur-md transition duration-300 hover:border-white/40 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#05070f]';

export const CTA_SIZE_LG = 'px-6 py-3';
export const CTA_SIZE_SM = 'px-5 py-2.5';

export const ACCENTS = {
  sky: {
    icon: 'text-sky-300',
    chip: 'border-sky-300/25 bg-sky-400/10',
    glow: 'from-sky-400/25',
  },
  indigo: {
    icon: 'text-indigo-300',
    chip: 'border-indigo-300/25 bg-indigo-400/10',
    glow: 'from-indigo-400/25',
  },
  violet: {
    icon: 'text-violet-300',
    chip: 'border-violet-300/25 bg-violet-400/10',
    glow: 'from-violet-400/25',
  },
  emerald: {
    icon: 'text-emerald-300',
    chip: 'border-emerald-300/25 bg-emerald-400/10',
    glow: 'from-emerald-400/25',
  },
  amber: {
    icon: 'text-amber-300',
    chip: 'border-amber-300/25 bg-amber-400/10',
    glow: 'from-amber-400/25',
  },
  rose: {
    icon: 'text-rose-300',
    chip: 'border-rose-300/25 bg-rose-400/10',
    glow: 'from-rose-400/25',
  },
} as const;

export type AccentName = keyof typeof ACCENTS;

export function Eyebrow({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.18em] text-sky-200 backdrop-blur-md">
      {icon}
      {children}
    </span>
  );
}

export function SectionShell({
  id,
  children,
  className = '',
}: {
  id?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={`landing-section relative py-20 sm:py-28 ${className}`.trim()}>
      {children}
    </section>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  subtitle,
  align = 'center',
}: {
  eyebrow: string;
  title: ReactNode;
  subtitle?: ReactNode;
  align?: 'center' | 'left';
}) {
  const centered = align === 'center';
  return (
    <div className={`${centered ? 'mx-auto max-w-3xl text-center' : 'max-w-2xl'}`}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 className="mt-5 text-balance text-3xl font-black leading-[1.1] tracking-tight text-white sm:text-4xl lg:text-[2.75rem]">
        {title}
      </h2>
      {subtitle ? (
        <p className="mt-4 text-pretty text-base leading-relaxed text-white/60 sm:text-lg">{subtitle}</p>
      ) : null}
    </div>
  );
}

export function GlassCard({
  children,
  className = '',
  glow,
}: {
  children: ReactNode;
  className?: string;
  /** Gradient start class, e.g. ACCENTS.sky.glow, for the hover halo. */
  glow?: string;
}) {
  return (
    <div
      className={`group relative overflow-hidden rounded-3xl border border-white/10 bg-white/5 p-6 backdrop-blur-xl transition duration-500 hover:-translate-y-1 hover:border-white/25 hover:bg-white/[0.07] ${className}`.trim()}
    >
      {glow ? (
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-gradient-to-br ${glow} to-transparent opacity-0 blur-2xl transition-opacity duration-500 group-hover:opacity-100`}
        />
      ) : null}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent"
      />
      <div className="relative">{children}</div>
    </div>
  );
}

export function PrimaryCta({
  to,
  children,
  className = '',
}: {
  to: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link to={to} className={`${ctaPrimaryClass} ${CTA_SIZE_LG} ${className}`.trim()}>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/30 to-transparent transition-transform duration-700 group-hover:translate-x-full"
      />
      <span className="relative flex items-center gap-2">{children}</span>
    </Link>
  );
}

export function GhostCta({
  to,
  children,
  className = '',
}: {
  to: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link to={to} className={`${ctaGhostClass} ${CTA_SIZE_LG} ${className}`.trim()}>
      {children}
    </Link>
  );
}

export function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-white/12 bg-white/5 px-3.5 py-1.5 text-[13px] font-semibold text-white/75 backdrop-blur-md transition duration-300 hover:border-sky-300/40 hover:bg-sky-400/10 hover:text-white">
      {children}
    </span>
  );
}
