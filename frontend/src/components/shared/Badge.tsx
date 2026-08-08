interface BadgeProps {
  children: React.ReactNode;
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'info';
}

const variants: Record<string, string> = {
  default:
    'bg-slate-100 text-slate-700 dark:bg-slate-500/25 dark:text-slate-100 dark:ring-1 dark:ring-slate-400/30',
  success:
    'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200 dark:ring-1 dark:ring-emerald-400/30',
  warning:
    'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-200 dark:ring-1 dark:ring-amber-400/30',
  danger:
    'bg-red-100 text-red-700 dark:bg-rose-500/20 dark:text-rose-200 dark:ring-1 dark:ring-rose-400/30',
  info:
    'bg-blue-100 text-blue-700 dark:bg-sky-500/20 dark:text-sky-200 dark:ring-1 dark:ring-sky-400/30',
};

export function Badge({ children, variant = 'default' }: BadgeProps) {
  return (
    <span className={`inline-flex max-w-none shrink-0 items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${variants[variant]}`}>
      {children}
    </span>
  );
}
