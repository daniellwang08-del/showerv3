import type { ReactNode } from 'react';

type Props = {
  children: ReactNode;
  className?: string;
  /** When true, reserve and show the vertical scrollbar even if content fits. */
  alwaysShowScrollbar?: boolean;
};

export function PageScrollArea({
  children,
  className = '',
  alwaysShowScrollbar = true,
}: Props) {
  const scrollClass = alwaysShowScrollbar ? 'page-scroll-y' : 'page-scroll-y-auto';
  return (
    <div className={`${scrollClass} h-full min-h-0 overflow-x-hidden ${className}`.trim()}>
      {children}
    </div>
  );
}
