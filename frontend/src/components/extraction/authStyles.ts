import { brandCtaFill, brandGradient } from '../../ui/tokens';

export const glassInputClass =
  'glass-input w-full rounded-xl border border-white/25 bg-white/10 py-3 pl-11 pr-4 text-sm font-medium text-white placeholder-white/55 outline-none backdrop-blur-md transition focus:border-sky-300/70 focus:bg-white/15 focus:ring-2 focus:ring-sky-400/40';

export const glassLabelClass =
  'mb-1.5 block text-xs font-bold uppercase tracking-wide text-sky-100';

export const fieldIconClass =
  'pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-white/60 transition-colors group-focus-within:text-sky-300';

export const primaryButtonClass =
  `group relative w-full overflow-hidden rounded-xl ${brandCtaFill} px-4 py-3 font-semibold text-white shadow-lg shadow-blue-900/40 transition hover:shadow-blue-700/50 disabled:cursor-not-allowed disabled:opacity-60`;

export const errorBoxClass =
  'rounded-lg border border-rose-300/40 bg-rose-500/20 px-3 py-2 text-sm font-semibold text-rose-50';

export { brandGradient };
