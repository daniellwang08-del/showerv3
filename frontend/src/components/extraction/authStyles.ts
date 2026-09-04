import { brandCtaFill, brandGradient } from '../../ui/tokens';

export const glassInputClass =
  'glass-input w-full rounded-2xl border border-white/20 bg-white/[0.07] py-3.5 pl-11 pr-4 text-sm font-medium text-white placeholder-white/40 outline-none backdrop-blur-md transition focus:border-sky-300/60 focus:bg-white/[0.1] focus:ring-2 focus:ring-sky-400/35';

export const glassLabelClass =
  'mb-1.5 block text-[11px] font-bold uppercase tracking-[0.14em] text-white/55';

export const fieldIconClass =
  'pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-white/60 transition-colors group-focus-within:text-sky-300';

export const primaryButtonClass =
  `group relative w-full overflow-hidden rounded-full ${brandCtaFill} px-4 py-3.5 text-sm font-bold text-white shadow-[0_14px_40px_-12px_rgba(37,99,235,0.9)] transition hover:shadow-[0_18px_50px_-12px_rgba(56,189,248,0.75)] disabled:cursor-not-allowed disabled:opacity-60`;

export const errorBoxClass =
  'rounded-lg border border-rose-300/40 bg-rose-500/20 px-3 py-2 text-sm font-semibold text-rose-50';

export { brandGradient };
