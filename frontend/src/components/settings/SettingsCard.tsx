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
    <section className={`rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:p-5 ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white ${iconClass}`}>
            <Icon size={18} />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-bold text-slate-900">{title}</h2>
            {description && <p className="mt-0.5 text-xs leading-snug text-slate-500">{description}</p>}
          </div>
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </section>
  );
}
