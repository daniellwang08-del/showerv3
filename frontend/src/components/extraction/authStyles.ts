import { brandGradient } from '../../ui/tokens';

/* Auth is always dark (navy key art), so these use fixed navy / white-alpha
   values instead of theme tokens that would flip with the app theme. */

export const glassInputClass =
  'glass-input w-full rounded-xl border border-white/15 bg-white/[0.04] py-3 pl-11 pr-4 text-sm font-medium text-white placeholder-white/40 outline-none transition hover:border-white/25 focus:border-[#6F9BFF] focus:bg-white/[0.06] focus:ring-2 focus:ring-[#2C5BF5]/40';

export const glassLabelClass =
  'mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.14em] text-white/60';

export const fieldIconClass =
  'pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-white/50 transition-colors group-focus-within:text-[#9DB9FF]';

export const primaryButtonClass =
  'group relative w-full overflow-hidden rounded-xl bg-[#2C5BF5] px-4 py-3 text-sm font-semibold text-white shadow-[0_10px_30px_-14px_rgba(61,116,255,0.9)] transition hover:bg-[#3566FA] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6F9BFF]/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#070B1C] disabled:cursor-not-allowed disabled:opacity-50';

export const errorBoxClass =
  'rounded-lg border border-[#FF8A8A]/30 bg-[#FF5C5C]/10 px-3 py-2 text-sm font-medium text-[#FFC9C9]';

export { brandGradient };
