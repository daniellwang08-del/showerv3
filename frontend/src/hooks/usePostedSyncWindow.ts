import { useCallback, useEffect, useState } from 'react';
import {
  POSTED_SYNC_WINDOW_EVENT,
  POSTED_SYNC_WINDOW_KEY,
  type PostedSyncWindow,
  readPostedSyncWindow,
  writePostedSyncWindow,
} from '../utils/postedSyncWindow';

/**
 * Shared Since/Until for dashboard Job fetch and System Settings → Job Sync.
 */
export function usePostedSyncWindow() {
  const [postedWindow, setPostedWindowState] = useState<PostedSyncWindow>(() =>
    readPostedSyncWindow(),
  );

  useEffect(() => {
    const apply = (next: PostedSyncWindow) => {
      setPostedWindowState((prev) =>
        prev.since === next.since && prev.until === next.until ? prev : next,
      );
    };

    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent<PostedSyncWindow>).detail;
      if (detail && typeof detail.since === 'string') apply(detail);
      else apply(readPostedSyncWindow());
    };

    const onStorage = (e: StorageEvent) => {
      if (e.key === POSTED_SYNC_WINDOW_KEY) apply(readPostedSyncWindow());
    };

    window.addEventListener(POSTED_SYNC_WINDOW_EVENT, onCustom);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(POSTED_SYNC_WINDOW_EVENT, onCustom);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const setPostedSince = useCallback((since: string) => {
    setPostedWindowState((prev) => {
      const next = { ...prev, since };
      writePostedSyncWindow(next);
      return next;
    });
  }, []);

  const setPostedUntil = useCallback((until: string) => {
    setPostedWindowState((prev) => {
      const next = { ...prev, until };
      writePostedSyncWindow(next);
      return next;
    });
  }, []);

  const setPostedWindow = useCallback((next: PostedSyncWindow) => {
    writePostedSyncWindow(next);
    setPostedWindowState(next);
  }, []);

  const clearPostedWindow = useCallback(() => {
    const next = { since: '', until: '' };
    writePostedSyncWindow(next);
    setPostedWindowState(next);
  }, []);

  const postedSince = postedWindow.since;
  const postedUntil = postedWindow.until;
  const windowActive = Boolean(postedSince.trim());
  const windowInvalid =
    windowActive && Boolean(postedUntil) && postedSince > postedUntil;

  return {
    postedSince,
    postedUntil,
    windowActive,
    windowInvalid,
    setPostedSince,
    setPostedUntil,
    setPostedWindow,
    clearPostedWindow,
  };
}
