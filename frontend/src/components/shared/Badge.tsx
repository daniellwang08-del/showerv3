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
    'bg-slate-100 text-slate-700 dark:bg-[#2a3548] dark:text-[#e8eef7] dark:ring-1 dark:ring-slate-400/40',
  success:
    'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/25 dark:text-[#a7f3d0] dark:ring-1 dark:ring-emerald-400/40',
  warning:
    'bg-amber-100 text-amber-700 dark:bg-amber-500/25 dark:text-[#fde68a] dark:ring-1 dark:ring-amber-400/40',
  danger:
    'bg-red-100 text-red-700 dark:bg-rose-500/25 dark:text-[#fecdd3] dark:ring-1 dark:ring-rose-400/40',
  info:
    'bg-blue-100 text-blue-700 dark:bg-sky-500/25 dark:text-[#bae6fd] dark:ring-1 dark:ring-sky-400/40',
};

export function Badge({ children, variant = 'default' }: BadgeProps) {
  return (
    <span
      className={`inline-flex max-w-full min-w-0 items-center overflow-hidden rounded-full px-1.5 py-0.5 text-[10px] font-medium sm:px-2 sm:text-[11px] lg:px-2.5 lg:text-xs ${variants[variant]}`}
    >
      {children}
    </span>
  );
}
