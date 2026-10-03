/**
 * NAO shared UI tokens, one brand language for app, auth, and landing CTAs.
 *
 * App classes resolve to the semantic theme tokens (`bg-card`, `text-foreground`,
 * `bg-primary`...) so they follow light and deep-navy dark mode automatically.
 * The CTA gradient is fixed hex because landing and auth are always dark.
 */

/** Electric blue, echoing the eclipse ring of the NAO mark. */
export const brandGradient = 'from-[#3D74FF] via-[#2C5BF5] to-[#1D3FD6]';
export const brandGradientHover = 'hover:from-[#5B8CFF] hover:via-[#3D6BFF] hover:to-[#2C5BF5]';

/** Page header / section icon chip gradient (brand blue to deep blue, white icon). */
export const brandChipGradient = 'from-[#3D74FF] to-[#1D3FD6]';

export const pagePad =
  'w-full min-w-0 space-y-4 px-3 py-4 sm:space-y-5 sm:px-5 sm:py-5';

export const card = 'rounded-2xl border border-border bg-card text-card-foreground shadow-sm';

export const toolbar = `${card} p-3 sm:p-4`;

export const borderSubtle = 'border-border';

export const mutedText = 'text-muted-foreground';

export const bodyText = 'text-foreground';

export const headingText = 'text-foreground';

/** Default form control (preferences, settings). */
export const input =
  'h-10 w-full rounded-xl border border-input bg-background px-3 text-sm text-foreground shadow-xs outline-none transition placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/30 disabled:opacity-60 dark:bg-input/30';

/** Taller solid filter/search control for toolbars. */
export const inputSolid =
  'h-11 w-full rounded-xl border border-input bg-background pl-9 pr-9 text-sm font-medium text-foreground shadow-xs outline-none transition placeholder:text-muted-foreground hover:border-ring/50 focus:border-ring focus:ring-3 focus:ring-ring/30 dark:bg-input/30';

export const btnPrimary =
  'inline-flex h-10 items-center justify-center gap-1.5 rounded-xl bg-primary px-3.5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50';

export const btnSecondary =
  'inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border border-border bg-background px-3.5 text-sm font-semibold text-foreground shadow-xs transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 dark:border-input dark:bg-input/30 dark:hover:bg-input/50';

export const btnGhost =
  'inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border border-transparent px-3 text-sm font-semibold text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50';

export const btnDanger =
  'inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border border-destructive/30 bg-destructive/10 px-3.5 text-sm font-semibold text-destructive transition hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-50';

/** Compact save control used on preference cards. */
export const btnSaveIdle =
  'inline-flex items-center gap-1.5 rounded-xl bg-muted px-3 py-2 text-xs font-semibold text-muted-foreground transition disabled:cursor-not-allowed';

export const btnSaveActive =
  'inline-flex items-center gap-1.5 rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60';

/** Landing / auth shared CTA gradient fill (padding chosen by caller). */
export const brandCtaFill = `bg-gradient-to-r ${brandGradient} ${brandGradientHover}`;

/** Short accent set for section icon chips, avoid inventing new per-card gradients. */
export const sectionAccents = {
  sky: 'bg-gradient-to-br from-[#3D74FF] to-[#1D3FD6]',
  indigo: 'bg-gradient-to-br from-[#1D3FD6] to-[#0A1030]',
  emerald: 'bg-status-ready',
  amber: 'bg-status-preparing',
  rose: 'bg-status-failed',
} as const;

export type SectionAccent = keyof typeof sectionAccents;
