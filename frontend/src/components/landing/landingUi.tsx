import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';

/**
 * Shared building blocks for the public landing page.
 *
 * The page is always dark: fixed deep-navy surfaces with white/alpha text and
 * the electric blue brand as the single accent. It does not use the app's
 * semantic tokens because those flip with the light/dark theme, and this
 * marketing surface must keep one look in both.
 */

/** Deep-navy surfaces, darkest first. */
export const LANDING_BG = 'bg-[#04060F]';
export const LANDING_SURFACE = 'bg-[#070B1C]';
export const LANDING_RAISED = 'bg-[#0A1030]';

export const LANDING_CONTAINER = 'mx-auto w-full max-w-[88rem] px-5 sm:px-8';

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6F9BFF]/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#04060F]';

/** Padding is intentionally left out of the base button classes so callers pick
 *  a size without needing an important override. */
export const ctaPrimaryClass = `group relative inline-flex items-center justify-center gap-2 rounded-full bg-[#2C5BF5] text-sm font-bold text-white shadow-[0_10px_30px_-14px_rgba(61,116,255,0.9)] transition duration-300 hover:bg-[#3566FA] ${focusRing}`;

export const ctaGhostClass = `inline-flex items-center justify-center gap-2 rounded-full border border-white/15 bg-transparent text-sm font-bold text-white transition duration-300 hover:border-white/30 hover:bg-white/[0.06] ${focusRing}`;

export const CTA_SIZE_LG = 'px-6 py-3';
export const CTA_SIZE_SM = 'px-5 py-2.5';

/** Icon tile used for feature and step icons. */
export const ICON_TILE = 'border border-[#6F9BFF]/25 bg-[#3D74FF]/10 text-[#9DB9FF]';

export function Eyebrow({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.04] px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.18em] text-[#BFD6FF]">
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
    <section id={id} className={`landing-section relative py-24 sm:py-32 ${className}`.trim()}>
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
      <h2 className="mt-5 text-balance text-3xl font-black leading-[1.1] tracking-tight text-white sm:text-4xl lg:text-[2.85rem]">
        {title}
      </h2>
      {subtitle ? (
        <p className="mt-4 text-pretty text-base leading-relaxed text-white/65 sm:text-lg">{subtitle}</p>
      ) : null}
    </div>
  );
}

/** Flat navy card with a 1px border. `raised` is for cards on a `LANDING_SURFACE` section. */
export function SurfaceCard({
  children,
  className = '',
  raised = false,
}: {
  children: ReactNode;
  className?: string;
  raised?: boolean;
}) {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-3xl border border-white/10 p-6 transition duration-300 hover:border-white/20',
        raised ? LANDING_RAISED : LANDING_SURFACE,
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Stock photo toned into the palette: desaturated, tinted brand blue and
 * dimmed with navy. The wrapper must be positioned by the caller
 * (`absolute inset-0` or `relative h-full`).
 */
export function TonedImage({ src, className = '' }: { src: string; className?: string }) {
  return (
    <span aria-hidden="true" className={`block overflow-hidden ${className}`.trim()}>
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        className="h-full w-full object-cover grayscale"
      />
      <span className="absolute inset-0 bg-[#3D74FF]/45 mix-blend-color" />
      <span className="absolute inset-0 bg-[#04060F]/45" />
    </span>
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
    <Link to={to} className={cn(ctaPrimaryClass, CTA_SIZE_LG, className)}>
      {children}
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
    <Link to={to} className={cn(ctaGhostClass, CTA_SIZE_LG, className)}>
      {children}
    </Link>
  );
}

export function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-white/12 bg-white/[0.03] px-3.5 py-1.5 text-[13px] font-semibold text-white/75 transition duration-300 hover:border-[#6F9BFF]/40 hover:text-white">
      {children}
    </span>
  );
}
