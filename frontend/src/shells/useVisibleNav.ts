import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchIncomingShares } from '@/api/reportShareApi';
import { INCOMING_SHARES_KEY } from '@/features/sharing/shareModel';
import type { NavSection } from './nav';

/**
 * Drops nav items that would lead to an empty page, such as "Shared with me"
 * before anyone has shared a report. An item stays while the user is on it so
 * an open link never loses its highlight.
 */
export function useVisibleNav(nav: NavSection[]): NavSection[] {
  const needsShares = nav.some((s) => s.items.some((i) => i.needsIncomingShares));
  const shares = useQuery({
    queryKey: INCOMING_SHARES_KEY,
    queryFn: fetchIncomingShares,
    staleTime: 60_000,
    enabled: needsShares,
  });
  const hasShares = (shares.data?.shares.length ?? 0) > 0;
  const { pathname } = useLocation();

  return useMemo(
    () =>
      nav
        .map((section) => ({
          ...section,
          items: section.items.filter(
            (item) => !item.needsIncomingShares || hasShares || pathname.startsWith(item.to),
          ),
        }))
        .filter((section) => section.items.length > 0),
    [nav, hasShares, pathname],
  );
}
