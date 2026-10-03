import { useEffect, useState } from 'react';

/**
 * Edits layered over server values: untouched fields always follow the latest
 * saved data, so refetches and immediate saves never clobber a draft.
 */
export function useDraft<T extends object>(saved: T) {
  const [draft, setDraft] = useState<Partial<T>>({});
  const values = { ...saved, ...draft } as T;
  const set = (patch: Partial<T>) => setDraft((d) => ({ ...d, ...patch }));
  const clear = (keys?: (keyof T)[]) =>
    setDraft((d) => {
      if (!keys) return {};
      const next = { ...d };
      for (const k of keys) delete next[k];
      return next;
    });
  return { values, set, clear };
}

export function useReportDirty(dirty: boolean, onDirtyChange: (dirty: boolean) => void) {
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
}

export function sameJson(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}
