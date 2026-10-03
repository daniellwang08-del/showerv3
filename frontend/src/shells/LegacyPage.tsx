import type { ReactNode } from 'react';

/**
 * Hosts a not-yet-migrated page inside the new shell. On desktop those pages
 * assume a ≥1080px canvas, so they scroll horizontally below that instead of
 * forcing the whole app (and the new shell) to a fixed minimum width.
 */
export function LegacyPage({ children }: { children: ReactNode }) {
  return (
    <div className="app-bg h-full overflow-x-auto overflow-y-hidden">
      <div className="h-full md:min-w-[1080px]">{children}</div>
    </div>
  );
}
