interface BadgeProps {
  children: React.ReactNode;
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'info';
}

/**
 * Explicit dark hex for text/bg — this app remaps slate CSS variables in
 * `.dark`, so `dark:text-slate-100` becomes dark-on-dark. Source chips must
 * stay light text on a distinct surface.
 */
const variants: Record<string, string> = {
  default:
    'bg-slate-100 text-slate-700 dark:bg-[var(--app-input)] dark:text-[var(--app-fg)] dark:ring-1 dark:ring-white/15',
  success:
    'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/25 dark:text-[#a7f3d0] dark:ring-1 dark:ring-emerald-400/40',
  warning:
    'bg-amber-100 text-amber-700 dark:bg-amber-500/25 dark:text-[#fde68a] dark:ring-1 dark:ring-amber-400/40',
  danger:
    'bg-red-100 text-red-700 dark:bg-rose-500/25 dark:text-[#fecdd3] dark:ring-1 dark:ring-rose-400/40',
  info:
    'bg-sky-100 text-sky-800 dark:bg-sky-500/25 dark:text-[#bae6fd] dark:ring-1 dark:ring-sky-400/40',
};

export function Badge({ children, variant = 'default' }: BadgeProps) {
  return (
    <span
      className={`inline-flex max-w-full min-w-0 items-center overflow-hidden rounded-lg px-2 py-0.5 text-[11px] font-semibold sm:px-2.5 sm:text-xs ${variants[variant]}`}
    >
      {children}
    </span>
  );
}
