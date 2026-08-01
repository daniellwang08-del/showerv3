import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

interface SettingsCardProps {
  icon: LucideIcon;
  /** Tailwind gradient classes for the icon chip, e.g. "bg-gradient-to-br from-rose-500 to-orange-600". */
  iconClass: string;
  title: string;
  description?: string;
  /** Right-aligned header slot (mode toggle, status badge, etc.). */
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/**
 * Compact, consistent card shell for settings sections - tight padding and a
 * small icon/title header so low-content settings don't feel oversized.
 */
export function SettingsCard({ icon: Icon, iconClass, title, description, actions, children, className = '' }: SettingsCardProps) {
  return (
    <section
      className={`flex flex-col rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm dark:border-white/10 dark:bg-[#0f172a]/80 sm:p-4 md:p-5 ${className}`}
    >
      <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white ${iconClass}`}>
            <Icon size={16} />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-bold leading-tight text-slate-900 dark:text-white">{title}</h2>
            {description && (
              <p className="mt-0.5 text-xs leading-snug text-slate-600 dark:text-[#94a3b8]">{description}</p>
            )}
          </div>
        </div>
        {actions && <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end">{actions}</div>}
      </div>
      {children && <div className="mt-2.5 flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>}
    </section>
  );
}
