import type { LlmProvider, SystemSettingItem, SystemSettingsResponse } from '@/types/admin';

export const BOOL_KEYS = new Set([
  'llm_fallback_enabled',
  'auto_generate_tailored_content',
  'auto_prepare_enabled',
  'dedup_rule_applied_company_enabled',
  'dedup_rule_score_comparison_enabled',
]);

export const WORKER_KEYS = [
  { key: 'extraction_worker_max_jobs', label: 'Extraction' },
  { key: 'analysis_worker_max_jobs', label: 'Analysis (Phase A)' },
  { key: 'tailoring_worker_max_jobs', label: 'Tailoring (Phase B)' },
  { key: 'save_worker_max_jobs', label: 'Save' },
  { key: 'autopost_worker_max_jobs', label: 'Autopost (Sheets / Pumble)' },
  { key: 'resume_worker_max_jobs', label: 'Resume build' },
  { key: 'scraper_worker_max_jobs', label: 'Scraper' },
  { key: 'encoding_worker_max_jobs', label: 'Encoding (embeddings)' },
] as const;

const NUMBER_KEYS = new Set<string>([
  'phase_a_max_tokens',
  'phase_b_max_tokens',
  ...WORKER_KEYS.map((w) => w.key),
  'llm_circuit_breaker_threshold',
  'default_min_match_score',
  'default_dedup_recycle_days',
  'extension_token_expire_days',
  'openai_timeout_seconds',
  'anthropic_timeout_seconds',
  'gemini_timeout_seconds',
  'llm_circuit_breaker_cooldown_seconds',
  'auto_prepare_daily_cap_per_user',
  'auto_prepare_pending_cap_per_user',
  'auto_score_on_visit_limit',
  'auto_score_on_visit_cooldown_seconds',
  'match_quality_check_daily_cap_per_user',
]);

/** Smallest accepted value per numeric key (default 0). */
const NUMBER_MIN: Record<string, number> = {
  ...Object.fromEntries(WORKER_KEYS.map((w) => [w.key, 1])),
  auto_score_on_visit_cooldown_seconds: 30,
  openai_timeout_seconds: 1,
  anthropic_timeout_seconds: 1,
  gemini_timeout_seconds: 1,
  extension_token_expire_days: 1,
  default_dedup_recycle_days: 1,
};

const NUMBER_MAX: Record<string, number> = {
  default_min_match_score: 100,
};

export const PROVIDERS: {
  id: LlmProvider;
  label: string;
  modelKey: string;
  timeoutKey: string;
  placeholder: string;
}[] = [
  { id: 'openai', label: 'OpenAI', modelKey: 'openai_model', timeoutKey: 'openai_timeout_seconds', placeholder: 'sk-…' },
  {
    id: 'anthropic',
    label: 'Anthropic',
    modelKey: 'anthropic_model',
    timeoutKey: 'anthropic_timeout_seconds',
    placeholder: 'sk-ant-…',
  },
  { id: 'gemini', label: 'Gemini', modelKey: 'gemini_model', timeoutKey: 'gemini_timeout_seconds', placeholder: 'AIza…' },
];

export type Option = { value: string; label: string; description?: string };

export const PROVIDER_OPTIONS: Option[] = PROVIDERS.map((p) => ({ value: p.id, label: p.label }));

/** Phase A is hard-capped at 16384 in job_match_service. */
export const PHASE_A_TOKEN_OPTIONS: Option[] = [
  { value: '4096', label: '4,096', description: 'Light / short postings' },
  { value: '8192', label: '8,192', description: 'Recommended default' },
  { value: '12288', label: '12,288', description: 'Longer job descriptions' },
  { value: '16384', label: '16,384', description: 'Maximum (Phase A cap)' },
];

/** Phase B is hard-capped at 32768 in job_match_service. */
export const PHASE_B_TOKEN_OPTIONS: Option[] = [
  { value: '8192', label: '8,192', description: 'Short tailored output' },
  { value: '12288', label: '12,288', description: 'Balanced' },
  { value: '16384', label: '16,384', description: 'Recommended default' },
  { value: '24576', label: '24,576', description: 'Long resume + letter' },
  { value: '32768', label: '32,768', description: 'Maximum (Phase B cap)' },
];

export const REASONING_EFFORT_OPTIONS: Option[] = [
  { value: 'low', label: 'Low', description: 'Fastest; recommended for production' },
  { value: 'medium', label: 'Medium', description: 'Balanced quality / latency' },
  { value: 'high', label: 'High', description: 'Slow; can empty completions on long JSON' },
];

export const BREAKER_THRESHOLD_OPTIONS: Option[] = [
  { value: '2', label: '2 failures', description: 'Fail over quickly' },
  { value: '3', label: '3 failures', description: 'Recommended default' },
  { value: '4', label: '4 failures', description: 'Slightly more tolerant' },
  { value: '5', label: '5 failures', description: 'Acceptable upper range' },
  { value: '7', label: '7 failures', description: 'Maximum recommended' },
];

export const MATCH_ENGINE_OPTIONS: Option[] = [
  { value: 'vector', label: 'Vector', description: 'Embedding engine scores matches; no LLM calls for Phase A.' },
  { value: 'shadow', label: 'Shadow', description: 'LLM stays authoritative; the vector scorer runs alongside for comparison.' },
  { value: 'llm', label: 'LLM', description: 'LLM scores every match (legacy).' },
];

/** Brand family of a gateway model id (gpt-5.1 → openai, gemini-2.5-pro → gemini, …). */
export function modelFamily(modelId: string): LlmProvider | 'other' {
  const id = (modelId || '').trim().toLowerCase();
  if (id.includes('gemini') || id.startsWith('gemma')) return 'gemini';
  if (id.includes('claude') || id.includes('anthropic')) return 'anthropic';
  if (id.includes('sonar') || id.includes('perplexity')) return 'other';
  if (
    id.includes('gpt') ||
    /^o[134]/.test(id) ||
    id.includes('chatgpt') ||
    id.includes('openai') ||
    id.includes('davinci')
  ) {
    return 'openai';
  }
  return 'other';
}

export const FAMILY_LABEL: Record<LlmProvider | 'other', string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  other: 'Other',
};

export function isNumberKey(key: string) {
  return NUMBER_KEYS.has(key);
}

export function formatLabel(key: string): string {
  return key.replace(/_/g, ' ');
}

/** The string a field edits for a setting; an overridden password is never echoed back. */
export function savedString(item: SystemSettingItem | undefined): string {
  if (!item) return '';
  if (item.key === 'auth_password' && item.overridden) return '';
  return String(item.value ?? '');
}

export function coerceValue(key: string, raw: string): string | number | boolean {
  if (BOOL_KEYS.has(key)) return raw === 'true';
  if (NUMBER_KEYS.has(key)) return Number(raw);
  return raw;
}

export function validateSetting(key: string, raw: string): string | null {
  if (!NUMBER_KEYS.has(key)) return null;
  if (raw.trim() === '') return 'Enter a number.';
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return 'Enter a whole number.';
  const min = NUMBER_MIN[key] ?? 0;
  const max = NUMBER_MAX[key];
  if (n < min) return `Must be at least ${min}.`;
  if (max != null && n > max) return `Must be at most ${max}.`;
  return null;
}

export function settingsByKey(payload: SystemSettingsResponse) {
  const map = new Map<string, SystemSettingItem>();
  for (const item of payload.settings) map.set(item.key, item);
  return map;
}

/** Options plus the saved value when it is not one of the presets. */
export function withSavedValue(options: Option[], value: string, label = (v: string) => v): Option[] {
  if (!value || options.some((o) => o.value === value)) return options;
  return [{ value, label: label(value), description: 'Custom saved value' }, ...options];
}

export function errDetail(err: unknown, fallback: string): string {
  const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
