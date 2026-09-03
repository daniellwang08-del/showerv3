import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { brandChipGradient, card, headingText, mutedText } from '../../ui/tokens';

interface PageHeaderProps {
  icon: LucideIcon;
  /** Tailwind gradient classes for the icon chip, e.g. "from-sky-500 to-indigo-600". */
  gradient?: string;
  title: string;
  description: string;
  /** Optional right-aligned slot (toolbar, actions, badges). */
  actions?: ReactNode;
  className?: string;
}

/**
 * Unified, compact page header used across Profile, Settings and Resume Builder.
 * A slim gradient-washed band with an accent icon chip, title and one-line
 * description so every page opens with a consistent, self-explaining banner.
 */
export function PageHeader({
  icon: Icon,
  gradient = brandChipGradient,
  title,
  description,
  actions,
  className = '',
}: PageHeaderProps) {
  return (
    <header
      // overflow-visible so action menus (Sync All, LLM, etc.) are not clipped at the
      // header edge. z-40 keeps this band above later siblings (stats tiles, filter
      // board) that would otherwise paint over absolutely/fixed-positioned menus.
      className={`relative z-40 flex flex-col gap-3 overflow-visible px-4 py-3 sm:flex-row sm:items-center sm:gap-4 ${card} ${className}`.trim()}
    >
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-y-0 left-0 w-1.5 rounded-l-2xl bg-gradient-to-b ${gradient}`}
      />
      <div className="flex min-w-0 items-center gap-3">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-sm ${gradient}`}
        >
          <Icon size={20} />
        </div>
        <div className="min-w-0">
          <h1 className={`truncate text-lg font-bold tracking-tight sm:text-xl ${headingText}`}>
            {title}
          </h1>
          <p className={`mt-0.5 text-xs leading-snug sm:text-sm ${mutedText}`}>{description}</p>
        </div>
      </div>
      {actions && (
        <div className="relative z-50 w-full min-w-0 sm:ml-auto sm:w-auto sm:shrink-0">
          {actions}
        </div>
      )}
    </header>
  );
}
