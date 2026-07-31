import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Cpu,
  Globe,
  KeyRound,
  Link2,
  Loader2,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
  Undo2,
  Zap,
} from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { PageScrollArea } from '../components/layout/PageScrollArea';
import { BrandedLoader } from '../components/layout/BrandedLoader';
import { SettingsCard } from '../components/settings/SettingsCard';
import { LlmBenchmarkSection } from '../components/settings/LlmBenchmarkSection';
import type { BenchmarkCatalogModel } from '../components/settings/LlmBenchmarkSection';
import { ConfirmDialog } from '../components/extraction/ConfirmDialog';
import { MenuSelect } from '../components/shared/MenuSelect';
import { SettingsToggle } from '../components/shared/SettingsToggle';
import {
  LlmModelGlyph,
  llmModelFamily,
  llmModelFamilyLabel,
  type LlmModelFamily,
} from '../components/shared/LlmModelIcon';
import {
  addBlockedDomain,
  clearQueue,
  clearSystemSetting,
  createLlmKey,
  deleteLlmKey,
  fetchBlockedDomains,
  fetchLlmKeys,
  fetchLlmModelsForEnv,
  fetchLlmModelsForKey,
  fetchOpsOverview,
  fetchSystemSettings,
  interruptStaleScrapes,
  removeBlockedDomain,
  saveLlmJobBindings,
  updateLlmKey,
  updateSystemSettings,
  validateLlmKey,
} from '../api/adminApi';
import type {
  BlockedDomain,
  LlmDiscoveredModel,
  LlmJobBinding,
  LlmProvider,
  LlmProviderKey,
  OpsOverview,
  SystemSettingItem,
  SystemSettingsResponse,
} from '../types/admin';

const BOOL_KEYS = new Set([
  'llm_fallback_enabled',
  'auto_generate_tailored_content',
  'dedup_rule_location_unknown_enabled',
  'dedup_rule_applied_company_enabled',
  'dedup_rule_score_comparison_enabled',
]);

const NUMBER_KEYS = new Set([
  'phase_a_max_tokens',
  'phase_b_max_tokens',
  'extraction_worker_max_jobs',
  'analysis_worker_max_jobs',
  'tailoring_worker_max_jobs',
  'save_worker_max_jobs',
  'autopost_worker_max_jobs',
  'resume_worker_max_jobs',
  'scraper_worker_max_jobs',
  'llm_circuit_breaker_threshold',
  'default_min_match_score',
  'default_dedup_recycle_days',
  'extension_token_expire_days',
  'openai_timeout_seconds',
  'anthropic_timeout_seconds',
  'gemini_timeout_seconds',
  'llm_circuit_breaker_cooldown_seconds',
]);

const PROVIDERS: {
  id: LlmProvider;
  label: string;
  modelKey: string;
  timeoutKey: string;
  accent: string;
  placeholder: string;
}[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    modelKey: 'openai_model',
    timeoutKey: 'openai_timeout_seconds',
    accent: 'from-emerald-500 to-teal-600',
    placeholder: 'sk-…',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    modelKey: 'anthropic_model',
    timeoutKey: 'anthropic_timeout_seconds',
    accent: 'from-orange-500 to-amber-600',
    placeholder: 'sk-ant-…',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    modelKey: 'gemini_model',
    timeoutKey: 'gemini_timeout_seconds',
    accent: 'from-sky-500 to-indigo-600',
    placeholder: 'AIza…',
  },
];

/** Skip gateway test/sandbox model ids (test-gpt-4o, …). */
function isSkippedGatewayModel(modelId: string): boolean {
  const id = (modelId || '').trim().toLowerCase();
  return !id || id.startsWith('test-') || id.includes('-test-') || id.startsWith('test_');
}

/** Map UI provider card → brand family for splitting the shared gateway catalogue. */
function providerModelFamily(providerId: LlmProvider): LlmModelFamily {
  if (providerId === 'gemini') return 'gemini';
  if (providerId === 'anthropic') return 'anthropic';
  return 'openai';
}

/**
 * Phase A is hard-capped at 16384 in job_match_service.
 * Presets = recommended working values for structured extraction + scoring.
 */
const PHASE_A_TOKEN_OPTIONS: { value: string; label: string; description: string }[] = [
  { value: '4096', label: '4,096', description: 'Light / short postings' },
  { value: '8192', label: '8,192', description: 'Recommended default' },
  { value: '12288', label: '12,288', description: 'Longer job descriptions' },
  { value: '16384', label: '16,384', description: 'Maximum (Phase A cap)' },
];

/**
 * Phase B is hard-capped at 32768 in job_match_service.
 * Higher values help tailored resume JSON + cover letter generation.
 */
const PHASE_B_TOKEN_OPTIONS: { value: string; label: string; description: string }[] = [
  { value: '8192', label: '8,192', description: 'Short tailored output' },
  { value: '12288', label: '12,288', description: 'Balanced' },
  { value: '16384', label: '16,384', description: 'Recommended default' },
  { value: '24576', label: '24,576', description: 'Long resume + letter' },
  { value: '32768', label: '32,768', description: 'Maximum (Phase B cap)' },
];

/**
 * Circuit breaker consecutive-failure threshold before skipping a provider.
 * Keep this small so the system fails over quickly without thrashing.
 */
const BREAKER_THRESHOLD_OPTIONS: { value: string; label: string; description: string }[] = [
  { value: '2', label: '2 failures', description: 'Fail over quickly' },
  { value: '3', label: '3 failures', description: 'Recommended default' },
  { value: '4', label: '4 failures', description: 'Slightly more tolerant' },
  { value: '5', label: '5 failures', description: 'Acceptable upper range' },
  { value: '7', label: '7 failures', description: 'Maximum recommended' },
];

/**
 * Shared System Settings field styles.
 * Avoid `dark:text-slate-100/300` — this app inverts the slate scale in dark mode,
 * so those classes become dark-on-dark and labels disappear.
 */
const FIELD_LABEL =
  'text-xs font-semibold uppercase tracking-wide text-slate-700 dark:text-[#e2e8f0]';
const FIELD_HINT = 'text-xs leading-snug text-slate-600 dark:text-[#94a3b8]';
const CONTROL =
  'h-9 w-full rounded-lg border border-slate-200 bg-white px-2.5 text-sm text-slate-900 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-200 dark:border-slate-500/40 dark:bg-[#0b1220] dark:text-white dark:focus:border-sky-400 dark:focus:ring-sky-900/40';
const CONTROL_ROW =
  'flex h-9 w-full shrink-0 items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-2.5 dark:border-slate-500/40 dark:bg-[#0b1220]';
const BADGE_DB =
  'rounded px-1 py-px text-[10px] font-bold normal-case tracking-normal bg-amber-100 text-amber-800 dark:bg-amber-500/30 dark:text-amber-100';
const BADGE_ENV =
  'rounded px-1 py-px text-[10px] font-bold normal-case tracking-normal bg-slate-200 text-slate-700 dark:bg-white/15 dark:text-[#e2e8f0]';
const SURFACE_CARD =
  'rounded-xl border border-slate-200/80 bg-slate-50/80 dark:border-slate-500/30 dark:bg-[#0b1220]/70';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

function formatLabel(key: string): string {
  return key.replace(/_/g, ' ');
}

function errDetail(e: unknown, fallback: string): string {
  const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
  return typeof msg === 'string' ? msg : fallback;
}

function coerceValue(key: string, raw: string): string | number | boolean {
  if (BOOL_KEYS.has(key)) return String(raw) === 'true';
  if (NUMBER_KEYS.has(key)) return Number(raw);
  return raw;
}

export function SystemSettingsPage() {
  const [payload, setPayload] = useState<SystemSettingsResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [ops, setOps] = useState<OpsOverview | null>(null);
  const [domains, setDomains] = useState<BlockedDomain[]>([]);
  const [keys, setKeys] = useState<LlmProviderKey[]>([]);
  const [bindings, setBindings] = useState<LlmJobBinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [fieldState, setFieldState] = useState<Record<string, SaveState>>({});
  const [newDomain, setNewDomain] = useState('');
  const [newReason, setNewReason] = useState('');
  const [domainToDelete, setDomainToDelete] = useState<string | null>(null);
  const [queueToClear, setQueueToClear] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<
    Record<LlmProvider, { label: string; api_key: string; testOk: boolean | null; testMsg: string }>
  >({
    openai: { label: '', api_key: '', testOk: null, testMsg: '' },
    anthropic: { label: '', api_key: '', testOk: null, testMsg: '' },
    gemini: { label: '', api_key: '', testOk: null, testMsg: '' },
  });
  const [keyBusy, setKeyBusy] = useState<Partial<Record<LlmProvider, 'test' | 'save'>>>({});
  const [bindingBusy, setBindingBusy] = useState<string | null>(null);
  /** Cache of discovered models keyed by `key:{id}` or `env:{provider}`. */
  const [modelOptions, setModelOptions] = useState<Record<string, LlmDiscoveredModel[]>>({});
  const [modelBusy, setModelBusy] = useState<Record<string, boolean>>({});
  const [modelErrors, setModelErrors] = useState<Record<string, string>>({});

  const debounceTimers = useRef<Record<string, number>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const modelFetchInflight = useRef<Set<string>>(new Set());
  const modelLoadedKeys = useRef<Set<string>>(new Set());

  const modelsCacheKey = (providerKeyId: string | null, provider: string | null) => {
    if (providerKeyId) return `key:${providerKeyId}`;
    return `env:${(provider || 'openai').toLowerCase()}`;
  };

  const ensureModelsLoaded = useCallback(
    async (providerKeyId: string | null, provider: string | null) => {
      const cacheKey = modelsCacheKey(providerKeyId, provider);
      if (modelLoadedKeys.current.has(cacheKey) || modelFetchInflight.current.has(cacheKey)) {
        return;
      }
      modelFetchInflight.current.add(cacheKey);
      setModelBusy((prev) => ({ ...prev, [cacheKey]: true }));
      setModelErrors((prev) => {
        const next = { ...prev };
        delete next[cacheKey];
        return next;
      });
      try {
        const res = providerKeyId
          ? await fetchLlmModelsForKey(providerKeyId)
          : await fetchLlmModelsForEnv((provider || 'openai').toLowerCase());
        // Prefer chat-capable models; fall back to full list if the gateway only
        // returns non-chat ids so the dropdown is never empty on success.
        const list =
          res.chat_models?.length > 0
            ? res.chat_models
            : res.models?.length
              ? res.models
              : [];
        modelLoadedKeys.current.add(cacheKey);
        setModelOptions((prev) => ({ ...prev, [cacheKey]: list }));
        if (res.message && list.length === 0) {
          setModelErrors((prev) => ({ ...prev, [cacheKey]: res.message || 'No models found' }));
        }
      } catch (err: unknown) {
        setModelErrors((prev) => ({
          ...prev,
          [cacheKey]: errDetail(err, 'Failed to discover models'),
        }));
        setModelOptions((prev) => ({ ...prev, [cacheKey]: [] }));
      } finally {
        modelFetchInflight.current.delete(cacheKey);
        setModelBusy((prev) => ({ ...prev, [cacheKey]: false }));
      }
    },
    [],
  );

  const persistBindings = async (nextBindings: LlmJobBinding[]) => {
    const saved = await saveLlmJobBindings(
      nextBindings.map((row) => ({
        job_type: row.job_type,
        provider_key_id: row.provider_key_id,
        provider: row.provider,
        model: row.model ?? null,
      })),
    );
    setBindings(saved);
    return saved;
  };

  const byKey = useMemo(() => {
    const map = new Map<string, SystemSettingItem>();
    for (const item of payload?.settings ?? []) map.set(item.key, item);
    return map;
  }, [payload]);

  const flash = useCallback((type: 'ok' | 'err', text: string) => {
    setMessage({ type, text });
  }, []);

  useEffect(() => {
    if (!message) return;
    const t = window.setTimeout(() => setMessage(null), 3200);
    return () => window.clearTimeout(t);
  }, [message]);

  const loadAll = useCallback(async () => {
    try {
      const [settings, overview, blocked, llm] = await Promise.all([
        fetchSystemSettings(),
        fetchOpsOverview(),
        fetchBlockedDomains(),
        fetchLlmKeys(),
      ]);
      setPayload(settings);
      setOps(overview);
      setDomains(blocked);
      setKeys(llm.keys);
      setBindings(llm.bindings);
      const next: Record<string, string> = {};
      for (const item of settings.settings) {
        next[item.key] =
          item.key === 'auth_password' && item.overridden ? '' : String(item.value ?? '');
      }
      setDrafts(next);
    } catch (e: unknown) {
      flash('err', errDetail(e, 'Failed to load system settings'));
    } finally {
      setLoading(false);
    }
  }, [flash]);

  useEffect(() => {
    void loadAll();
    return () => {
      for (const id of Object.values(debounceTimers.current)) window.clearTimeout(id);
    };
  }, [loadAll]);

  // Prefetch: shared gateway catalogue lives on env openai (project .env, not UI keys).
  // Also warm per-provider env + registered pool keys for bindings / native discovery.
  useEffect(() => {
    void ensureModelsLoaded(null, 'openai');
    for (const p of PROVIDERS) {
      if (p.id !== 'openai') void ensureModelsLoaded(null, p.id);
    }
    for (const k of keys) {
      if (k.is_enabled) void ensureModelsLoaded(k.id, k.provider);
    }
    for (const b of bindings) {
      void ensureModelsLoaded(b.provider_key_id, b.provider);
    }
  }, [bindings, keys, ensureModelsLoaded]);

  /**
   * Models for a provider card = gateway catalogue (.env openai) split by brand family,
   * plus any models discovered from that provider's registered pool keys.
   * test-* models are omitted. The gateway key itself is never managed in this UI.
   */
  const mergedModelsForProvider = useCallback(
    (providerId: LlmProvider): LlmDiscoveredModel[] => {
      const family = providerModelFamily(providerId);
      const byId = new Map<string, LlmDiscoveredModel>();
      const accept = (m: LlmDiscoveredModel) => {
        if (isSkippedGatewayModel(m.id)) return;
        if (!m.usable_for_chat) return;
        if (llmModelFamily(m.id) !== family) return;
        byId.set(m.id, m);
      };

      // Dev gateway catalogue (OPENAI_API_KEY + OPENAI_API_BASE) — split across cards.
      for (const m of modelOptions['env:openai'] || []) accept(m);

      // Native provider env discovery (when configured), still family-filtered.
      if (providerId !== 'openai') {
        for (const m of modelOptions[`env:${providerId}`] || []) accept(m);
      }

      for (const k of keys) {
        if (k.provider !== providerId || !k.is_enabled) continue;
        for (const m of modelOptions[`key:${k.id}`] || []) accept(m);
      }

      return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    },
    [keys, modelOptions],
  );

  const providerModelsLoading = useCallback(
    (providerId: LlmProvider): boolean => {
      // Shared gateway catalogue powers all three family lists.
      if (modelBusy['env:openai']) return true;
      if (providerId !== 'openai' && modelBusy[`env:${providerId}`]) return true;
      return keys.some(
        (k) => k.provider === providerId && k.is_enabled && modelBusy[`key:${k.id}`],
      );
    },
    [keys, modelBusy],
  );

  const benchmarkCatalog = useMemo(() => {
    const byId = new Map<string, BenchmarkCatalogModel>();
    for (const p of PROVIDERS) {
      for (const m of mergedModelsForProvider(p.id)) {
        byId.set(`${p.id}::${m.id}`, { ...m, provider: p.id });
      }
    }
    return [...byId.values()];
  }, [mergedModelsForProvider]);

  const benchmarkCatalogLoading = PROVIDERS.some((p) => providerModelsLoading(p.id));

  const persistSetting = useCallback(
    async (key: string, raw: string) => {
      if (key === 'auth_password' && !raw.trim()) {
        flash('err', 'Enter a password value to override');
        setFieldState((s) => ({ ...s, [key]: 'error' }));
        return;
      }
      setFieldState((s) => ({ ...s, [key]: 'saving' }));
      try {
        const next = await updateSystemSettings({ [key]: coerceValue(key, raw) });
        setPayload(next);
        setFieldState((s) => ({ ...s, [key]: 'saved' }));
        window.setTimeout(() => {
          setFieldState((s) => (s[key] === 'saved' ? { ...s, [key]: 'idle' } : s));
        }, 1600);
      } catch (e: unknown) {
        setFieldState((s) => ({ ...s, [key]: 'error' }));
        flash('err', errDetail(e, `Failed to save ${formatLabel(key)}`));
      }
    },
    [flash],
  );

  const scheduleSave = useCallback(
    (key: string, value: string, immediate = false) => {
      setDrafts((d) => ({ ...d, [key]: value }));
      const existing = debounceTimers.current[key];
      if (existing) window.clearTimeout(existing);
      if (
        immediate ||
        BOOL_KEYS.has(key) ||
        key === 'default_llm_provider' ||
        key === 'phase_a_max_tokens' ||
        key === 'phase_b_max_tokens' ||
        key === 'llm_circuit_breaker_threshold'
      ) {
        void persistSetting(key, value);
        return;
      }
      debounceTimers.current[key] = window.setTimeout(() => {
        void persistSetting(key, value);
      }, 650);
    },
    [persistSetting],
  );

  const revertKey = async (key: string) => {
    const timer = debounceTimers.current[key];
    if (timer) window.clearTimeout(timer);
    setFieldState((s) => ({ ...s, [key]: 'saving' }));
    try {
      const next = await clearSystemSetting(key);
      setPayload(next);
      const item = next.settings.find((s) => s.key === key);
      if (item) setDrafts((d) => ({ ...d, [key]: String(item.value ?? '') }));
      setFieldState((s) => ({ ...s, [key]: 'saved' }));
      flash('ok', `Reverted ${formatLabel(key)} to .env`);
    } catch (e: unknown) {
      setFieldState((s) => ({ ...s, [key]: 'error' }));
      flash('err', errDetail(e, 'Revert failed'));
    }
  };

  const refreshLlm = async () => {
    const llm = await fetchLlmKeys();
    setKeys(llm.keys);
    setBindings(llm.bindings);
    // Keys/secrets may have changed — rediscover models on next bind.
    modelLoadedKeys.current.clear();
    modelFetchInflight.current.clear();
    setModelOptions({});
    setModelErrors({});
  };

  const renderFieldChrome = (key: string, label: string, item: SystemSettingItem) => {
    const state = fieldState[key] ?? 'idle';
    return (
      <span className={`flex items-center gap-1.5 ${FIELD_LABEL}`}>
        {label}
        <span className={item.overridden ? BADGE_DB : BADGE_ENV}>
          {item.overridden ? 'DB' : 'ENV'}
        </span>
        <span className="ml-auto flex h-3.5 items-center">
          {state === 'saving' ? (
            <Loader2 size={11} className="animate-spin text-[#94a3b8]" />
          ) : state === 'saved' ? (
            <CheckCircle2 size={11} className="text-emerald-500" />
          ) : state === 'error' ? (
            <AlertCircle size={11} className="text-rose-500" />
          ) : item.overridden ? (
            <button
              type="button"
              title="Revert to .env"
              onClick={(e) => {
                e.preventDefault();
                void revertKey(key);
              }}
              className="rounded p-0.5 text-[#94a3b8] opacity-0 transition hover:bg-slate-100 hover:text-slate-700 group-hover:opacity-100 dark:hover:bg-white/10 dark:hover:text-white"
            >
              <Undo2 size={11} />
            </button>
          ) : null}
        </span>
      </span>
    );
  };

  const renderAutoField = (
    key: string,
    opts?: { className?: string; type?: string; label?: string },
  ) => {
    const item = byKey.get(key);
    if (!item) return null;
    const isBool = BOOL_KEYS.has(key);
    const label = opts?.label ?? formatLabel(key);
    const rawValue = drafts[key] ?? '';

    if (isBool) {
      const checked = String(rawValue) === 'true';
      return (
        <div key={key} className={`group relative flex min-w-0 flex-col gap-1 ${opts?.className ?? ''}`}>
          {renderFieldChrome(key, label, item)}
          <div className={CONTROL_ROW}>
            <span
              className={`text-[13px] font-medium ${
                checked ? 'text-sky-700 dark:text-sky-300' : 'text-slate-600 dark:text-[#94a3b8]'
              }`}
            >
              {checked ? 'On' : 'Off'}
            </span>
            <SettingsToggle
              checked={checked}
              aria-label={label}
              onChange={(next) => scheduleSave(key, next ? 'true' : 'false', true)}
            />
          </div>
        </div>
      );
    }

    if (key === 'phase_a_max_tokens' || key === 'phase_b_max_tokens') {
      const options = key === 'phase_a_max_tokens' ? PHASE_A_TOKEN_OPTIONS : PHASE_B_TOKEN_OPTIONS;
      const known = options.some((o) => o.value === String(rawValue));
      const selectOptions = [
        ...(known
          ? []
          : rawValue
            ? [
                {
                  value: String(rawValue),
                  label: Number(rawValue).toLocaleString(),
                  description: 'Custom saved value',
                },
              ]
            : []),
        ...options,
      ];
      return (
        <div key={key} className={`group relative flex min-w-0 flex-col gap-1 ${opts?.className ?? ''}`}>
          {renderFieldChrome(key, label, item)}
          <MenuSelect
            aria-label={label}
            value={String(rawValue)}
            minMenuWidth={260}
            options={selectOptions}
            onChange={(next) => scheduleSave(key, next, true)}
          />
        </div>
      );
    }

    if (key === 'llm_circuit_breaker_threshold') {
      const known = BREAKER_THRESHOLD_OPTIONS.some((o) => o.value === String(rawValue));
      const selectOptions = [
        ...(known
          ? []
          : rawValue
            ? [
                {
                  value: String(rawValue),
                  label: `${rawValue} failures`,
                  description: 'Custom saved value',
                },
              ]
            : []),
        ...BREAKER_THRESHOLD_OPTIONS,
      ];
      return (
        <div key={key} className={`group relative flex min-w-0 flex-col gap-1 ${opts?.className ?? ''}`}>
          {renderFieldChrome(key, label, item)}
          <MenuSelect
            aria-label={label}
            value={String(rawValue)}
            minMenuWidth={260}
            options={selectOptions}
            onChange={(next) => scheduleSave(key, next, true)}
          />
        </div>
      );
    }

    return (
      <label
        key={key}
        className={`group relative flex min-w-0 flex-col gap-1 ${opts?.className ?? ''}`}
      >
        {renderFieldChrome(key, label, item)}
        {key === 'default_llm_provider' ? (
          <MenuSelect
            aria-label={label}
            value={rawValue || 'openai'}
            minMenuWidth={200}
            options={[
              { value: 'openai', label: 'OpenAI' },
              { value: 'anthropic', label: 'Anthropic' },
              { value: 'gemini', label: 'Gemini' },
            ]}
            onChange={(next) => scheduleSave(key, next, true)}
          />
        ) : (
          <input
            type={
              opts?.type ||
              (key === 'auth_password' ? 'password' : NUMBER_KEYS.has(key) ? 'number' : 'text')
            }
            value={rawValue}
            onChange={(e) => scheduleSave(key, e.target.value)}
            onBlur={() => {
              const timer = debounceTimers.current[key];
              if (timer) {
                window.clearTimeout(timer);
                delete debounceTimers.current[key];
                void persistSetting(key, draftsRef.current[key] ?? '');
              }
            }}
            className={CONTROL}
          />
        )}
      </label>
    );
  };

  if (loading) {
    return <BrandedLoader label="Loading system settings…" />;
  }

  return (
    <PageScrollArea>
      <div className="w-full space-y-4 px-3 py-4 sm:space-y-5 sm:px-5 sm:py-5">
        <PageHeader
          icon={Cpu}
          gradient="from-violet-600 to-indigo-700"
          title="System Settings"
          description="Changes save automatically. API keys require a successful validation before they are stored."
        />

        {message ? (
          <div
            className={`flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm shadow-sm ${
              message.type === 'ok'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : 'border-red-200 bg-red-50 text-red-700'
            }`}
          >
            {message.type === 'ok' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
            {message.text}
          </div>
        ) : null}

        {/* Global LLM knobs */}
        <SettingsCard
          icon={Cpu}
          iconClass="bg-gradient-to-br from-violet-500 to-indigo-600"
          title="LLM defaults"
          description="Platform-wide behaviour. Edits save as you change them."
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {renderAutoField('default_llm_provider', { label: 'Default provider' })}
            {renderAutoField('llm_fallback_enabled', { label: 'Fallback' })}
            {renderAutoField('auto_generate_tailored_content', { label: 'Auto tailor' })}
            {renderAutoField('phase_a_max_tokens', { label: 'Phase A tokens' })}
            {renderAutoField('phase_b_max_tokens', { label: 'Phase B tokens' })}
            {renderAutoField('llm_circuit_breaker_threshold', { label: 'Breaker threshold' })}
            {renderAutoField('llm_circuit_breaker_cooldown_seconds', { label: 'Breaker cooldown' })}
          </div>
        </SettingsCard>

        <SettingsCard
          icon={Zap}
          iconClass="bg-gradient-to-br from-sky-500 to-cyan-600"
          title="Worker concurrency"
          description="arq max_jobs per worker process. Applied when that worker restarts."
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {renderAutoField('extraction_worker_max_jobs', { label: 'Extraction' })}
            {renderAutoField('analysis_worker_max_jobs', { label: 'Analysis (Phase A)' })}
            {renderAutoField('tailoring_worker_max_jobs', { label: 'Tailoring (Phase B)' })}
            {renderAutoField('save_worker_max_jobs', { label: 'Save' })}
            {renderAutoField('autopost_worker_max_jobs', { label: 'Autopost (Sheets/Pumble)' })}
            {renderAutoField('resume_worker_max_jobs', { label: 'Resume build' })}
            {renderAutoField('scraper_worker_max_jobs', { label: 'Scraper' })}
          </div>
        </SettingsCard>

        {/* Per-provider */}
        <section className="space-y-3">
          <div className="flex items-end justify-between gap-3 px-0.5">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                Providers & key pool
              </h2>
              <p className={`mt-0.5 ${FIELD_HINT}`}>
                Register native provider keys here. Available models are grouped by vendor
                (GPT → OpenAI, Gemini → Gemini, Claude → Anthropic). Test models are hidden.
              </p>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {PROVIDERS.map((p) => {
              const providerKeys = keys.filter((k) => k.provider === p.id);
              const draft = newKey[p.id];
              const busy = keyBusy[p.id];
              const envSet = Boolean(payload?.secrets_presence?.[`${p.id}_api_key`]);
              const discovered = mergedModelsForProvider(p.id);
              const discovering = providerModelsLoading(p.id);
              const currentModel = drafts[p.modelKey] || '';
              const modelItem = byKey.get(p.modelKey);
              const modelState = fieldState[p.modelKey] ?? 'idle';
              const modelMissing =
                !!currentModel &&
                discovered.length > 0 &&
                !discovered.some((m) => m.id === currentModel);
              const modelSelectOptions = [
                ...(modelMissing
                  ? [
                      {
                        value: currentModel,
                        label: currentModel,
                        description: `${llmModelFamilyLabel(currentModel)} · saved (not in catalogue)`,
                        icon: <LlmModelGlyph modelId={currentModel} size={14} />,
                      },
                    ]
                  : []),
                ...discovered.map((m) => ({
                  value: m.id,
                  // Full model id is the version string (e.g. gpt-4.1-mini, gemini-2.5-flash).
                  label: m.id,
                  description: `${llmModelFamilyLabel(m.id)} model`,
                  icon: <LlmModelGlyph modelId={m.id} size={14} />,
                })),
              ];
              // Anthropic has no /v1/models catalogue — keep a free-text path.
              const useModelPicker = p.id !== 'anthropic' || discovered.length > 0;

              return (
                <div
                  key={p.id}
                  className="flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-500/30 dark:bg-[#0b1220]/80"
                >
                  <div className={`bg-gradient-to-r ${p.accent} px-4 py-3 text-white`}>
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-sm font-bold tracking-tight">{p.label}</h3>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                          envSet ? 'bg-white/25' : 'bg-black/20'
                        }`}
                      >
                        {envSet ? '.env ready' : 'no .env key'}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-1 flex-col gap-4 p-4">
                    <div className="grid grid-cols-1 gap-2.5">
                      <div className="group relative flex min-w-0 flex-col gap-1">
                        <span className={`flex items-center gap-1.5 ${FIELD_LABEL}`}>
                          Model
                          <span className="normal-case tracking-normal text-slate-500 dark:text-[#94a3b8]">
                            {discovered.length ? `${discovered.length} available` : ''}
                          </span>
                          {modelItem ? (
                            <span className={modelItem.overridden ? BADGE_DB : BADGE_ENV}>
                              {modelItem.overridden ? 'DB' : 'ENV'}
                            </span>
                          ) : null}
                          <span className="ml-auto flex h-3.5 items-center gap-1">
                            {discovering ? (
                              <Loader2 size={11} className="animate-spin text-[#94a3b8]" />
                            ) : null}
                            {modelState === 'saving' ? (
                              <Loader2 size={11} className="animate-spin text-[#94a3b8]" />
                            ) : modelState === 'saved' ? (
                              <CheckCircle2 size={11} className="text-emerald-500" />
                            ) : modelState === 'error' ? (
                              <AlertCircle size={11} className="text-rose-500" />
                            ) : modelItem?.overridden ? (
                              <button
                                type="button"
                                title="Revert to .env"
                                onClick={() => void revertKey(p.modelKey)}
                                className="rounded p-0.5 text-[#94a3b8] opacity-0 transition hover:bg-slate-100 hover:text-slate-700 group-hover:opacity-100 dark:hover:bg-white/10 dark:hover:text-white"
                              >
                                <Undo2 size={11} />
                              </button>
                            ) : null}
                          </span>
                        </span>
                        {useModelPicker && modelSelectOptions.length > 0 ? (
                          <MenuSelect
                            aria-label={`${p.label} model`}
                            value={currentModel}
                            loading={discovering && discovered.length === 0}
                            minMenuWidth={320}
                            wrapLabels
                            options={modelSelectOptions}
                            onChange={(next) => scheduleSave(p.modelKey, next, true)}
                          />
                        ) : (
                          <input
                            value={currentModel}
                            onChange={(e) => scheduleSave(p.modelKey, e.target.value)}
                            onBlur={() => {
                              const timer = debounceTimers.current[p.modelKey];
                              if (timer) {
                                window.clearTimeout(timer);
                                delete debounceTimers.current[p.modelKey];
                                void persistSetting(p.modelKey, draftsRef.current[p.modelKey] ?? '');
                              }
                            }}
                            placeholder={
                              p.id === 'anthropic'
                                ? 'claude-…'
                                : discovering
                                  ? 'Loading models…'
                                  : 'No models discovered yet'
                            }
                            className={`${CONTROL} font-mono`}
                          />
                        )}
                        {!discovering && discovered.length === 0 ? (
                          <p className={FIELD_HINT}>
                            {p.id === 'anthropic'
                              ? 'No Claude models in the system catalogue yet — type a model id, or register an Anthropic key.'
                              : p.id === 'gemini'
                                ? 'No Gemini models in the system catalogue yet.'
                                : 'No OpenAI models in the system catalogue yet.'}
                          </p>
                        ) : null}
                      </div>
                      {renderAutoField(p.timeoutKey, { label: 'Timeout (s)' })}
                    </div>

                    <div>
                      <div className={`mb-2 flex items-center gap-1.5 ${FIELD_LABEL}`}>
                        <KeyRound size={12} /> Registered keys
                        <span className="ml-auto normal-case tracking-normal text-slate-500 dark:text-[#94a3b8]">
                          {providerKeys.length}
                        </span>
                      </div>

                      {providerKeys.length ? (
                        <ul className="mb-3 space-y-1.5">
                          {providerKeys.map((k) => (
                            <li
                              key={k.id}
                              className={`flex min-h-9 items-center gap-2 px-2.5 py-1.5 ${SURFACE_CARD}`}
                            >
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-xs font-semibold text-slate-900 dark:text-white">
                                  {k.label}
                                </div>
                                <div className="font-mono text-[10px] text-slate-500 dark:text-[#94a3b8]">
                                  {k.key_hint || '••••'}
                                </div>
                              </div>
                              <SettingsToggle
                                checked={k.is_enabled}
                                aria-label={`${k.is_enabled ? 'Disable' : 'Enable'} ${k.label}`}
                                onChange={async (next) => {
                                  try {
                                    await updateLlmKey(k.id, { is_enabled: next });
                                    await refreshLlm();
                                  } catch (e: unknown) {
                                    flash('err', errDetail(e, 'Update failed'));
                                  }
                                }}
                              />
                              <button
                                type="button"
                                onClick={async () => {
                                  try {
                                    await deleteLlmKey(k.id);
                                    await refreshLlm();
                                    flash('ok', 'Key removed');
                                  } catch (e: unknown) {
                                    flash('err', errDetail(e, 'Delete failed'));
                                  }
                                }}
                                className="rounded-md p-1 text-[#94a3b8] hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10"
                                aria-label="Delete key"
                              >
                                <Trash2 size={13} />
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className={`mb-3 ${FIELD_HINT}`}>No keys registered yet.</p>
                      )}

                      <div className="space-y-2 rounded-xl border border-dashed border-slate-200 bg-slate-50/70 p-2.5 dark:border-slate-500/30 dark:bg-white/[0.03]">
                        <input
                          value={draft.label}
                          onChange={(e) =>
                            setNewKey((s) => ({
                              ...s,
                              [p.id]: { ...s[p.id], label: e.target.value },
                            }))
                          }
                          placeholder="Label (e.g. analysis-prod)"
                          className={CONTROL}
                        />
                        <input
                          type="password"
                          autoComplete="off"
                          value={draft.api_key}
                          onChange={(e) =>
                            setNewKey((s) => ({
                              ...s,
                              [p.id]: {
                                ...s[p.id],
                                api_key: e.target.value,
                                testOk: null,
                                testMsg: '',
                              },
                            }))
                          }
                          placeholder={p.placeholder}
                          className={`${CONTROL} font-mono`}
                        />
                        <div className="flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            disabled={busy != null || !draft.api_key.trim()}
                            onClick={async () => {
                              setKeyBusy((s) => ({ ...s, [p.id]: 'test' }));
                              try {
                                const res = await validateLlmKey({
                                  provider: p.id,
                                  api_key: draft.api_key.trim(),
                                });
                                setNewKey((s) => ({
                                  ...s,
                                  [p.id]: {
                                    ...s[p.id],
                                    testOk: res.ok,
                                    testMsg: res.message,
                                  },
                                }));
                              } catch (e: unknown) {
                                setNewKey((s) => ({
                                  ...s,
                                  [p.id]: {
                                    ...s[p.id],
                                    testOk: false,
                                    testMsg: errDetail(e, 'Validation failed'),
                                  },
                                }));
                              } finally {
                                setKeyBusy((s) => {
                                  const next = { ...s };
                                  delete next[p.id];
                                  return next;
                                });
                              }
                            }}
                            className="inline-flex h-9 flex-1 items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-500/40 dark:bg-[#0b1220] dark:text-white dark:hover:bg-white/5"
                          >
                            {busy === 'test' ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <Zap size={12} />
                            )}
                            Validate
                          </button>
                          <button
                            type="button"
                            disabled={
                              busy != null ||
                              draft.testOk !== true ||
                              !draft.label.trim() ||
                              !draft.api_key.trim()
                            }
                            onClick={async () => {
                              setKeyBusy((s) => ({ ...s, [p.id]: 'save' }));
                              try {
                                await createLlmKey({
                                  provider: p.id,
                                  label: draft.label.trim(),
                                  api_key: draft.api_key.trim(),
                                });
                                setNewKey((s) => ({
                                  ...s,
                                  [p.id]: {
                                    label: '',
                                    api_key: '',
                                    testOk: null,
                                    testMsg: '',
                                  },
                                }));
                                await refreshLlm();
                                flash('ok', `${p.label} key saved`);
                              } catch (e: unknown) {
                                flash('err', errDetail(e, 'Failed to save key'));
                              } finally {
                                setKeyBusy((s) => {
                                  const next = { ...s };
                                  delete next[p.id];
                                  return next;
                                });
                              }
                            }}
                            className="inline-flex h-9 flex-1 items-center justify-center gap-1 rounded-lg bg-slate-900 px-2.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-slate-900"
                          >
                            {busy === 'save' ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <ShieldCheck size={12} />
                            )}
                            Save key
                          </button>
                        </div>
                        {draft.testMsg ? (
                          <p
                            className={`flex items-start gap-1 text-xs ${
                              draft.testOk ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                            }`}
                          >
                            {draft.testOk ? (
                              <CheckCircle2 size={12} className="mt-0.5 shrink-0" />
                            ) : (
                              <AlertCircle size={12} className="mt-0.5 shrink-0" />
                            )}
                            {draft.testMsg}
                          </p>
                        ) : (
                          <p className={FIELD_HINT}>Validate the key before save is enabled.</p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Job bindings — key name + model on one row; high-contrast in dark mode */}
        <SettingsCard
          icon={Link2}
          iconClass="bg-gradient-to-br from-sky-500 to-blue-600"
          title="Job → model bindings"
          description="Pick which catalogue model each job uses. Keys resolve from user settings or server .env."
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {bindings.map((b) => {
              const busy = bindingBusy === b.job_type;
              const cacheKey = modelsCacheKey(b.provider_key_id, b.provider);
              // Prefer the shared gateway catalogue so every job has a full model list.
              const boundModels = modelOptions[cacheKey] || [];
              const gatewayModels = modelOptions['env:openai'] || [];
              const byId = new Map<string, LlmDiscoveredModel>();
              for (const m of [...gatewayModels, ...boundModels]) {
                if (isSkippedGatewayModel(m.id)) continue;
                if (!m.usable_for_chat) continue;
                byId.set(m.id, m);
              }
              const models = [...byId.values()].sort((a, b2) => a.id.localeCompare(b2.id));
              const modelsLoading = !!modelBusy[cacheKey] || !!modelBusy['env:openai'];
              const modelsError = modelErrors[cacheKey];
              const selectedModel = b.model || '';
              const modelMissing =
                !!selectedModel &&
                models.length > 0 &&
                !models.some((m) => m.id === selectedModel);
              const defaultModelId =
                drafts.openai_model || drafts.anthropic_model || drafts.gemini_model || '';
              const modelOptionsForSelect = [
                {
                  value: '',
                  label: defaultModelId ? `Default · ${defaultModelId}` : 'System default',
                  description: 'Uses the platform default model setting',
                  icon: <LlmModelGlyph modelId={defaultModelId || 'gpt'} size={14} />,
                },
                ...(modelMissing
                  ? [
                      {
                        value: selectedModel,
                        label: selectedModel,
                        description: 'Saved, but not in the current catalogue',
                        icon: <LlmModelGlyph modelId={selectedModel} size={14} />,
                      },
                    ]
                  : []),
                ...models.map((m) => ({
                  value: m.id,
                  label: m.id,
                  description: llmModelFamilyLabel(m.id),
                  icon: <LlmModelGlyph modelId={m.id} size={14} />,
                })),
              ];
              return (
                <div key={b.job_type} className={`flex flex-col gap-1.5 px-3 py-2.5 ${SURFACE_CARD}`}>
                  <span className={`flex items-center gap-1.5 ${FIELD_HINT}`}>
                    {b.description}
                    {busy || modelsLoading ? (
                      <Loader2 size={12} className="shrink-0 animate-spin text-[#94a3b8]" />
                    ) : null}
                  </span>
                  <MenuSelect
                    aria-label={`${b.label} model`}
                    leadingLabel={b.label}
                    value={selectedModel}
                    disabled={busy}
                    loading={modelsLoading}
                    minMenuWidth={320}
                    wrapLabels
                    options={modelOptionsForSelect}
                    onChange={async (modelRaw) => {
                      const model = modelRaw || null;
                      const nextBindings = bindings.map((row) =>
                        row.job_type === b.job_type ? { ...row, model } : row,
                      );
                      setBindings(nextBindings);
                      setBindingBusy(b.job_type);
                      try {
                        await persistBindings(nextBindings);
                      } catch (err: unknown) {
                        flash('err', errDetail(err, 'Failed to save model'));
                        await refreshLlm();
                      } finally {
                        setBindingBusy(null);
                      }
                    }}
                  />
                  {modelsError ? (
                    <span className="text-xs text-amber-700 dark:text-amber-300">{modelsError}</span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </SettingsCard>

        <LlmBenchmarkSection
          catalog={benchmarkCatalog}
          loading={benchmarkCatalogLoading}
          defaultModelIds={[
            drafts.openai_model,
            drafts.anthropic_model,
            drafts.gemini_model,
          ].filter(Boolean)}
        />

        {/* Platform defaults */}
        <SettingsCard
          icon={ShieldCheck}
          iconClass="bg-gradient-to-br from-amber-500 to-orange-600"
          title="Platform defaults"
          description="Match score, dedup, and auth. Auto-saves on change."
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {renderAutoField('default_min_match_score', { label: 'Min match score' })}
            {renderAutoField('default_dedup_recycle_days', { label: 'Dedup recycle days' })}
            {renderAutoField('dedup_rule_location_unknown_enabled', { label: 'Dedup: unknown loc' })}
            {renderAutoField('dedup_rule_applied_company_enabled', { label: 'Dedup: applied co.' })}
            {renderAutoField('dedup_rule_score_comparison_enabled', { label: 'Dedup: score cmp' })}
            {renderAutoField('extension_token_expire_days', { label: 'Ext. token days' })}
            {renderAutoField('auth_password', { label: 'Auth password', className: 'sm:col-span-2' })}
          </div>
          {payload?.secrets_presence ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {Object.entries(payload.secrets_presence)
                .filter(([k]) => !k.endsWith('_api_key'))
                .map(([k, present]) => (
                  <span
                    key={k}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 text-xs dark:border-slate-500/40 dark:bg-[#0b1220]"
                  >
                    <span className="font-semibold text-slate-800 dark:text-[#e2e8f0]">
                      {formatLabel(k)}
                    </span>
                    <span
                      className={
                        present
                          ? 'font-semibold text-emerald-600 dark:text-emerald-400'
                          : 'font-medium text-slate-500 dark:text-[#94a3b8]'
                      }
                    >
                      {present ? 'set' : 'missing'}
                    </span>
                  </span>
                ))}
            </div>
          ) : null}
        </SettingsCard>

        {/* Queues */}
        <SettingsCard
          icon={Server}
          iconClass="bg-gradient-to-br from-emerald-500 to-teal-600"
          title="Queues & scrape ops"
          description="Health, queue depth, and scrape controls."
          actions={
            <button
              type="button"
              onClick={() => void loadAll()}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 dark:border-slate-500/40 dark:bg-[#0b1220] dark:text-white dark:hover:bg-white/5"
            >
              <RefreshCw size={13} /> Refresh
            </button>
          }
        >
          {ops ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="API" value={ops.health.status} ok={ops.health.status === 'ok' || ops.health.status === 'healthy'} />
                <Stat label="Database" value={ops.health.database_connected ? 'ok' : 'down'} ok={ops.health.database_connected} />
                <Stat label="Redis" value={ops.health.redis_connected ? 'ok' : 'down'} ok={ops.health.redis_connected} />
                <Stat label="Browsers" value={String(ops.health.browser_pool_available)} />
              </div>

              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {(ops.queues ?? []).map((q) => (
                  <div
                    key={q.id}
                    className={`flex min-h-9 items-center gap-3 px-3 py-2 ${SURFACE_CARD}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-bold text-slate-900 dark:text-white">{q.label}</div>
                      <div className={`truncate ${FIELD_HINT}`}>{q.description}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-base font-bold tabular-nums text-slate-900 dark:text-white">
                        {q.reachable ? (q.pending ?? 0) : '-'}
                      </div>
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#94a3b8]">
                        pending
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={!q.reachable}
                      onClick={() => setQueueToClear(q.id)}
                      className="h-9 shrink-0 rounded-lg border border-amber-200 bg-amber-50 px-2.5 text-xs font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-40 dark:border-amber-400/30 dark:bg-amber-500/15 dark:text-amber-200"
                    >
                      Clear
                    </button>
                  </div>
                ))}
              </div>

              <div
                className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 text-sm ${SURFACE_CARD}`}
              >
                <span className="font-semibold text-slate-900 dark:text-white">Scrape</span>
                {ops.scrape.status === 'running' ? (
                  <span className="text-amber-700 dark:text-amber-300">
                    {ops.scrape.spider_name} · {ops.scrape.items_scraped ?? 0} items
                    {ops.scrape.elapsed_seconds != null ? ` · ${ops.scrape.elapsed_seconds}s` : ''}
                  </span>
                ) : (
                  <span className="text-slate-600 dark:text-[#94a3b8]">idle</span>
                )}
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const res = await interruptStaleScrapes();
                      flash('ok', `Interrupted ${res.interrupted_count} stale scrape(s)`);
                      setOps(await fetchOpsOverview());
                    } catch {
                      flash('err', 'Failed to interrupt stale scrapes');
                    }
                  }}
                  className="ml-auto h-9 rounded-lg border border-amber-200 bg-amber-50 px-2.5 text-xs font-semibold text-amber-800 hover:bg-amber-100 dark:border-amber-400/30 dark:bg-amber-500/15 dark:text-amber-200"
                >
                  Interrupt stale
                </button>
              </div>

              {ops.recent_scrape_runs?.length ? (
                <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-500/30">
                  <table className="min-w-[480px] w-full text-xs">
                    <thead className="bg-slate-50 text-left dark:bg-[#121a2c]">
                      <tr>
                        <th className={`px-3 py-2 ${FIELD_LABEL}`}>Spider</th>
                        <th className={`px-3 py-2 ${FIELD_LABEL}`}>Status</th>
                        <th className={`px-3 py-2 ${FIELD_LABEL}`}>Scraped</th>
                        <th className={`px-3 py-2 ${FIELD_LABEL}`}>Started</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-700/40">
                      {ops.recent_scrape_runs.map((r) => (
                        <tr key={r.id}>
                          <td className="px-3 py-2 font-medium text-slate-900 dark:text-white">
                            {r.spider_name}
                          </td>
                          <td className="px-3 py-2 text-slate-700 dark:text-[#cbd5e1]">{r.status}</td>
                          <td className="px-3 py-2 tabular-nums text-slate-900 dark:text-white">
                            {r.items_scraped ?? 0}
                          </td>
                          <td className="px-3 py-2 text-slate-600 dark:text-[#94a3b8]">
                            {r.started_at ? new Date(r.started_at).toLocaleString() : '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          ) : (
            <p className={`text-sm ${FIELD_HINT}`}>No ops data.</p>
          )}
        </SettingsCard>

        {/* Blocked domains */}
        <SettingsCard
          icon={Globe}
          iconClass="bg-gradient-to-br from-sky-500 to-blue-600"
          title="Blocked domains"
          description="Domains that reject auto job extraction."
        >
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              placeholder="example.com"
              className={`${CONTROL} sm:w-44`}
            />
            <input
              value={newReason}
              onChange={(e) => setNewReason(e.target.value)}
              placeholder="Reason"
              className={`${CONTROL} flex-1`}
            />
            <button
              type="button"
              onClick={async () => {
                if (!newDomain.trim() || !newReason.trim()) return;
                try {
                  await addBlockedDomain(newDomain.trim(), newReason.trim());
                  setNewDomain('');
                  setNewReason('');
                  setDomains(await fetchBlockedDomains());
                  flash('ok', 'Domain blocked');
                } catch (e: unknown) {
                  flash('err', errDetail(e, 'Failed to add domain'));
                }
              }}
              className="h-9 rounded-lg bg-slate-900 px-4 text-xs font-semibold text-white hover:bg-slate-800 dark:bg-white dark:text-slate-900"
            >
              Add
            </button>
          </div>
          <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 dark:divide-slate-700/40 dark:border-slate-500/30">
            {domains.map((d) => (
              <li key={d.domain} className="flex min-h-9 items-center justify-between gap-3 px-3 py-2 text-sm">
                <div>
                  <div className="font-medium text-slate-900 dark:text-white">{d.domain}</div>
                  <div className={FIELD_HINT}>{d.reason}</div>
                </div>
                <button
                  type="button"
                  onClick={() => setDomainToDelete(d.domain)}
                  className="rounded-md p-1.5 text-[#94a3b8] hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10"
                  aria-label={`Remove ${d.domain}`}
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
            {!domains.length ? (
              <li className={`px-3 py-6 text-center text-sm ${FIELD_HINT}`}>No blocked domains</li>
            ) : null}
          </ul>
        </SettingsCard>
      </div>

      <ConfirmDialog
        open={domainToDelete != null}
        title="Remove blocked domain?"
        description={
          domainToDelete ? (
            <>
              Unblock <strong>{domainToDelete}</strong>?
            </>
          ) : (
            ''
          )
        }
        confirmLabel="Remove"
        variant="danger"
        onConfirm={async () => {
          if (!domainToDelete) return;
          try {
            await removeBlockedDomain(domainToDelete);
            setDomains(await fetchBlockedDomains());
            flash('ok', 'Domain removed');
          } catch {
            flash('err', 'Failed to remove domain');
          } finally {
            setDomainToDelete(null);
          }
        }}
        onCancel={() => setDomainToDelete(null)}
      />

      <ConfirmDialog
        open={queueToClear != null}
        title="Clear queue?"
        description={
          queueToClear ? (
            <>
              Delete all pending jobs in the <strong>{queueToClear}</strong> queue. In-flight work is
              not cancelled. This cannot be undone.
            </>
          ) : (
            ''
          )
        }
        confirmLabel="Clear"
        variant="danger"
        onConfirm={async () => {
          if (!queueToClear) return;
          try {
            await clearQueue(queueToClear);
            setOps(await fetchOpsOverview());
            flash('ok', `Cleared ${queueToClear} queue`);
          } catch (e: unknown) {
            flash('err', errDetail(e, 'Failed to clear queue'));
          } finally {
            setQueueToClear(null);
          }
        }}
        onCancel={() => setQueueToClear(null)}
      />
    </PageScrollArea>
  );
}

function Stat({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className={`px-3 py-2.5 ${SURFACE_CARD}`}>
      <div className={FIELD_LABEL}>{label}</div>
      <div
        className={`mt-0.5 text-sm font-bold ${
          ok === true
            ? 'text-emerald-600 dark:text-emerald-400'
            : ok === false
              ? 'text-rose-600 dark:text-rose-400'
              : 'text-slate-900 dark:text-white'
        }`}
      >
        {value}
      </div>
    </div>
  );
}
