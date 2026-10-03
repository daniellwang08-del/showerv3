/**
 * NAO shared UI tokens, one brand language for app, auth, and landing CTAs.
 *
 * Landing stays cinematic-dark (fixed hex / white-alpha) so the app's slate
 * dark-mode remap cannot invert marketing copy. Auth and app import these
 * classes so buttons, cards, and inputs feel like one product.
 */

/** Sky → blue → indigo, matches landing CTA and auth primary. */
export const brandGradient = 'from-sky-500 via-blue-600 to-indigo-600';
export const brandGradientHover = 'hover:from-sky-400 hover:via-blue-500 hover:to-indigo-500';

/** Page header / section icon chip gradient. */
export const brandChipGradient = 'from-sky-500 to-indigo-600';

export const pagePad =
  'w-full min-w-0 space-y-4 px-3 py-4 sm:space-y-5 sm:px-5 sm:py-5';

export const card =
  'rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-white/10 dark:bg-[var(--app-card)]';

export const toolbar = `${card} p-3 sm:p-4`;

export const borderSubtle = 'border-slate-200 dark:border-white/10';

export const mutedText = 'text-slate-500 dark:text-[var(--app-muted)]';

export const bodyText = 'text-slate-800 dark:text-[var(--app-fg)]';

export const headingText = 'text-slate-900 dark:text-white';

/** Default form control (preferences, settings). */
export const input =
  'h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-800 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-sky-400 focus:ring-2 focus:ring-sky-200 disabled:opacity-60 dark:border-white/15 dark:bg-[var(--app-input)] dark:text-[var(--app-fg)] dark:placeholder:text-slate-500 dark:focus:border-sky-400 dark:focus:ring-sky-900/40';

/** Taller solid filter/search control for toolbars. */
export const inputSolid =
  'h-11 w-full rounded-xl border border-slate-300 bg-white pl-9 pr-9 text-sm font-medium text-slate-800 shadow-sm outline-none transition placeholder:text-slate-400 hover:border-slate-400 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/25 dark:border-white/15 dark:bg-[var(--app-input)] dark:text-[var(--app-fg)]';

export const btnPrimary =
  `inline-flex h-10 items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r ${brandGradient} px-3.5 text-sm font-semibold text-white shadow-sm transition ${brandGradientHover} hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50`;

export const btnSecondary =
  'inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/15 dark:bg-[var(--app-input)] dark:text-[var(--app-fg)] dark:hover:bg-white/5';

export const btnGhost =
  'inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border border-transparent px-3 text-sm font-semibold text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50 dark:text-[var(--app-muted)] dark:hover:bg-white/5 dark:hover:text-white';

export const btnDanger =
  'inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border border-rose-200 bg-rose-50 px-3.5 text-sm font-semibold text-rose-700 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-400/40 dark:bg-rose-500/10 dark:text-rose-300 dark:hover:bg-rose-500/20';

/** Compact save control used on preference cards. */
export const btnSaveIdle =
  'inline-flex items-center gap-1.5 rounded-xl bg-slate-200 px-3 py-2 text-xs font-semibold text-slate-500 transition disabled:cursor-not-allowed dark:bg-white/10 dark:text-slate-400';

export const btnSaveActive =
  `inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r ${brandGradient} px-3 py-2 text-xs font-semibold text-white shadow-sm transition ${brandGradientHover} disabled:cursor-not-allowed disabled:opacity-60`;

/** Landing / auth shared CTA gradient fill (padding chosen by caller). */
export const brandCtaFill = `bg-gradient-to-r ${brandGradient} ${brandGradientHover}`;

/** Short accent set for section icon chips, avoid inventing new per-card gradients. */
export const sectionAccents = {
  sky: 'bg-gradient-to-br from-sky-500 to-cyan-600',
  indigo: 'bg-gradient-to-br from-indigo-500 to-violet-600',
  emerald: 'bg-gradient-to-br from-emerald-500 to-teal-600',
  amber: 'bg-gradient-to-br from-amber-500 to-orange-600',
  rose: 'bg-gradient-to-br from-rose-500 to-pink-600',
} as const;

export type SectionAccent = keyof typeof sectionAccents;
