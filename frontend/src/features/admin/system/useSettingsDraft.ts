import { useEffect, useState } from 'react';
import type { SystemSettingItem, SystemSettingsResponse } from '@/types/admin';
import { coerceValue, savedString, settingsByKey, validateSetting } from './settingsModel';

/**
 * Edits for a fixed set of system-setting keys, layered over the server values so
 * refetches and immediate saves never clobber an in-progress draft.
 */
export function useSettingsDraft(payload: SystemSettingsResponse, keys: readonly string[]) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const items = settingsByKey(payload);
  const saved = (key: string) => savedString(items.get(key));

  const value = (key: string) => draft[key] ?? saved(key);
  const isDirtyKey = (key: string) => {
    if (draft[key] === undefined) return false;
    if (key === 'auth_password') return draft[key].trim() !== '';
    return draft[key] !== saved(key);
  };
  const dirtyKeys = keys.filter((k) => items.has(k) && isDirtyKey(k));
  const errors = Object.fromEntries(
    dirtyKeys.map((k) => [k, validateSetting(k, draft[k])]).filter(([, e]) => e),
  ) as Record<string, string>;

  return {
    item: (key: string): SystemSettingItem | undefined => items.get(key),
    value,
    set: (key: string, next: string) => setDraft((d) => ({ ...d, [key]: next })),
    error: (key: string): string | undefined => errors[key],
    dirty: dirtyKeys.length > 0,
    valid: Object.keys(errors).length === 0,
    payload: () => Object.fromEntries(dirtyKeys.map((k) => [k, coerceValue(k, draft[k])])),
    clear: (only?: string[]) =>
      setDraft((d) => {
        if (!only) return {};
        const next = { ...d };
        for (const k of only) delete next[k];
        return next;
      }),
  };
}

export type SettingsDraft = ReturnType<typeof useSettingsDraft>;

export function useReportDirty(dirty: boolean, onDirtyChange: (dirty: boolean) => void) {
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
}
