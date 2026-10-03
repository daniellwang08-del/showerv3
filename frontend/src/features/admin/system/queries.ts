import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  clearSystemSetting,
  fetchLlmKeys,
  fetchLlmModelsForEnv,
  fetchLlmModelsForKey,
  fetchSystemSettings,
  updateSystemSettings,
} from '@/api/adminApi';
import type {
  LlmDiscoveredModel,
  LlmJobBinding,
  LlmKeysResponse,
  LlmProvider,
  LlmProviderKey,
  SystemSettingsResponse,
} from '@/types/admin';
import { coerceValue, errDetail, formatLabel, modelFamily, PROVIDERS } from './settingsModel';

export const SYSTEM_SETTINGS_KEY = ['admin', 'system-settings'] as const;
export const LLM_KEYS_KEY = ['admin', 'llm-keys'] as const;
export const LLM_MODELS_KEY = ['admin', 'llm-models'] as const;
export const OPS_KEY = ['admin', 'ops'] as const;
export const BLOCKED_DOMAINS_KEY = ['admin', 'blocked-domains'] as const;
export const SHADOW_STATS_KEY = ['admin', 'match-engine', 'shadow-stats'] as const;
export const SYNC_KEY = ['admin', 'job-sync'] as const;

export function useSystemSettingsQuery() {
  return useQuery({ queryKey: SYSTEM_SETTINGS_KEY, queryFn: fetchSystemSettings });
}

export function useLlmKeysQuery() {
  return useQuery({ queryKey: LLM_KEYS_KEY, queryFn: fetchLlmKeys });
}

export function useSetSystemSettings() {
  const queryClient = useQueryClient();
  return (next: SystemSettingsResponse) => queryClient.setQueryData(SYSTEM_SETTINGS_KEY, next);
}

/** Keys or secrets changed: reload the pool and rediscover models. */
export function useRefreshLlm() {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: LLM_KEYS_KEY });
    await queryClient.invalidateQueries({ queryKey: LLM_MODELS_KEY });
  };
}

/** Saves one setting immediately, showing it optimistically and rolling back on error. */
export function useImmediateSetting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      updateSystemSettings({ [key]: coerceValue(key, value) }),
    onMutate: async ({ key, value }) => {
      await queryClient.cancelQueries({ queryKey: SYSTEM_SETTINGS_KEY });
      const previous = queryClient.getQueryData<SystemSettingsResponse>(SYSTEM_SETTINGS_KEY);
      if (previous) {
        queryClient.setQueryData<SystemSettingsResponse>(SYSTEM_SETTINGS_KEY, {
          ...previous,
          settings: previous.settings.map((s) =>
            s.key === key ? { ...s, value: coerceValue(key, value), overridden: true } : s,
          ),
        });
      }
      return { previous };
    },
    onError: (err, { key }, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(SYSTEM_SETTINGS_KEY, ctx.previous);
      toast.error(errDetail(err, `Failed to save ${formatLabel(key)}`));
    },
    onSuccess: (data) => {
      queryClient.setQueryData(SYSTEM_SETTINGS_KEY, data);
    },
  });
}

export function useRevertSetting(onReverted?: (key: string) => void) {
  const setSettings = useSetSystemSettings();
  return useMutation({
    mutationFn: (key: string) => clearSystemSetting(key),
    onSuccess: (data, key) => {
      setSettings(data);
      onReverted?.(key);
      toast.success(`Reverted ${formatLabel(key)} to .env`);
    },
    onError: (err) => toast.error(errDetail(err, 'Revert failed')),
  });
}

/** Skip gateway test/sandbox model ids (test-gpt-4o, …). */
function isSkippedModel(id: string): boolean {
  const v = (id || '').trim().toLowerCase();
  return !v || v.startsWith('test-') || v.includes('-test-') || v.startsWith('test_');
}

function cacheKeyFor(providerKeyId: string | null, provider: string | null) {
  return providerKeyId ? `key:${providerKeyId}` : `env:${(provider || 'openai').toLowerCase()}`;
}

type CatalogEntry = { models: LlmDiscoveredModel[]; message: string | null };

async function discover(cacheKey: string): Promise<CatalogEntry> {
  const [kind, id] = [cacheKey.slice(0, cacheKey.indexOf(':')), cacheKey.slice(cacheKey.indexOf(':') + 1)];
  const res = kind === 'key' ? await fetchLlmModelsForKey(id) : await fetchLlmModelsForEnv(id);
  // Prefer chat-capable models; fall back to the full list so a successful lookup is never empty.
  const models = res.chat_models?.length ? res.chat_models : (res.models ?? []);
  return { models, message: models.length === 0 ? res.message || 'No models found' : null };
}

/**
 * Model catalogue = shared gateway list (.env openai) split by brand family, plus
 * each provider's .env discovery and registered pool keys.
 */
export function useModelCatalog(keys: LlmProviderKey[], bindings: LlmJobBinding[]) {
  const cacheKeys = new Set<string>(PROVIDERS.map((p) => `env:${p.id}`));
  for (const k of keys) if (k.is_enabled) cacheKeys.add(cacheKeyFor(k.id, k.provider));
  for (const b of bindings) cacheKeys.add(cacheKeyFor(b.provider_key_id, b.provider));
  const list = [...cacheKeys];

  const results = useQueries({
    queries: list.map((ck) => ({
      queryKey: [...LLM_MODELS_KEY, ck],
      queryFn: () => discover(ck),
      staleTime: Infinity,
    })),
  });
  const entry = (ck: string) => {
    const r = results[list.indexOf(ck)];
    return {
      models: r?.data?.models ?? [],
      loading: r?.isPending ?? false,
      error: r?.error ? errDetail(r.error, 'Failed to discover models') : (r?.data?.message ?? null),
    };
  };

  const modelsForProvider = (providerId: LlmProvider): LlmDiscoveredModel[] => {
    const byId = new Map<string, LlmDiscoveredModel>();
    const accept = (m: LlmDiscoveredModel) => {
      if (isSkippedModel(m.id) || !m.usable_for_chat) return;
      if (modelFamily(m.id) !== providerId) return;
      byId.set(m.id, m);
    };
    for (const m of entry('env:openai').models) accept(m);
    if (providerId !== 'openai') for (const m of entry(`env:${providerId}`).models) accept(m);
    for (const k of keys) {
      if (k.provider !== providerId || !k.is_enabled) continue;
      for (const m of entry(`key:${k.id}`).models) accept(m);
    }
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  };

  const providerLoading = (providerId: LlmProvider) =>
    entry('env:openai').loading ||
    (providerId !== 'openai' && entry(`env:${providerId}`).loading) ||
    keys.some((k) => k.provider === providerId && k.is_enabled && entry(`key:${k.id}`).loading);

  /** Gateway catalogue plus whatever the binding's own key or provider exposes. */
  const modelsForBinding = (b: LlmJobBinding) => {
    const own = entry(cacheKeyFor(b.provider_key_id, b.provider));
    const gateway = entry('env:openai');
    const byId = new Map<string, LlmDiscoveredModel>();
    for (const m of [...gateway.models, ...own.models]) {
      if (isSkippedModel(m.id) || !m.usable_for_chat) continue;
      byId.set(m.id, m);
    }
    return {
      models: [...byId.values()].sort((a, b2) => a.id.localeCompare(b2.id)),
      loading: own.loading || gateway.loading,
      error: own.error,
    };
  };

  return { modelsForProvider, providerLoading, modelsForBinding };
}

export type ModelCatalog = ReturnType<typeof useModelCatalog>;

export function patchLlmKeys(
  queryClient: ReturnType<typeof useQueryClient>,
  patch: (prev: LlmKeysResponse) => LlmKeysResponse,
) {
  const prev = queryClient.getQueryData<LlmKeysResponse>(LLM_KEYS_KEY);
  if (prev) queryClient.setQueryData(LLM_KEYS_KEY, patch(prev));
  return prev;
}
