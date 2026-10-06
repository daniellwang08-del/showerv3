import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { SectionCard } from '@/components/app/PageLayout';
import { SaveBar } from '@/components/app/SaveBar';
import { Badge } from '@/components/ui/badge';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { saveLlmJobBindings, updateSystemSettings } from '@/api/adminApi';
import type { LlmJobBinding, LlmKeysResponse, SystemSettingsResponse } from '@/types/admin';
import { NumberSetting, OptionSelect, SelectSetting, ToggleSetting } from './fields';
import { LLM_KEYS_KEY, useSetSystemSettings, type ModelCatalog } from './queries';
import {
  BREAKER_THRESHOLD_OPTIONS,
  errDetail,
  FAMILY_LABEL,
  modelFamily,
  PHASE_A_TOKEN_OPTIONS,
  PHASE_B_TOKEN_OPTIONS,
  PROVIDER_OPTIONS,
  PROVIDERS,
  REASONING_EFFORT_OPTIONS,
  withSavedValue,
  type Option,
} from './settingsModel';
import { useReportDirty, useSettingsDraft } from './useSettingsDraft';

const DRAFT_KEYS = [
  'default_llm_provider',
  'openai_reasoning_effort',
  'phase_a_max_tokens',
  'phase_b_max_tokens',
  'llm_circuit_breaker_threshold',
  'llm_circuit_breaker_cooldown_seconds',
  'auto_prepare_daily_cap_per_user',
  'auto_prepare_pending_cap_per_user',
  'auto_score_on_visit_limit',
  'auto_score_on_visit_cooldown_seconds',
  'match_quality_check_model',
  'match_quality_check_daily_cap_per_user',
  ...PROVIDERS.flatMap((p) => [p.modelKey, p.timeoutKey]),
];

const DEFAULT_MODEL = '__default__';

export function LlmTab({
  settings,
  llm,
  catalog,
  active,
  onDirtyChange,
}: {
  settings: SystemSettingsResponse;
  llm: LlmKeysResponse;
  catalog: ModelCatalog;
  active: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const setSettings = useSetSystemSettings();
  const draft = useSettingsDraft(settings, DRAFT_KEYS);
  const [bindingDraft, setBindingDraft] = useState<Record<string, string | null>>({});
  const [saving, setSaving] = useState(false);

  const bindingModel = (b: LlmJobBinding) => (b.job_type in bindingDraft ? bindingDraft[b.job_type] : b.model);
  const bindingsDirty = llm.bindings.some((b) => (bindingModel(b) ?? null) !== (b.model ?? null));
  const dirty = draft.dirty || bindingsDirty;
  useReportDirty(dirty, onDirtyChange);

  const handleSave = async () => {
    setSaving(true);
    try {
      if (draft.dirty) {
        setSettings(await updateSystemSettings(draft.payload()));
        draft.clear();
      }
      if (bindingsDirty) {
        const saved = await saveLlmJobBindings(
          llm.bindings.map((b) => ({
            job_type: b.job_type,
            provider_key_id: b.provider_key_id,
            provider: b.provider,
            model: bindingModel(b) ?? null,
          })),
        );
        queryClient.setQueryData<LlmKeysResponse>(LLM_KEYS_KEY, (prev) => (prev ? { ...prev, bindings: saved } : prev));
        setBindingDraft({});
      }
      toast.success('LLM settings saved');
    } catch (err) {
      toast.error(errDetail(err, 'Failed to save LLM settings'));
    } finally {
      setSaving(false);
    }
  };

  const defaultModelId = draft.value('openai_model') || draft.value('anthropic_model') || draft.value('gemini_model');

  return (
    <div className="space-y-6">
      <SectionCard title="LLM defaults" description="Platform-wide provider, token budgets, and failover behaviour.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <SelectSetting draft={draft} k="default_llm_provider" label="Default provider" options={PROVIDER_OPTIONS} fallback="openai" />
          <SelectSetting
            draft={draft}
            k="openai_reasoning_effort"
            label="Reasoning effort"
            fallback="low"
            hint="GPT-5 / o-series reasoning depth."
            options={withSavedValue(REASONING_EFFORT_OPTIONS, draft.value('openai_reasoning_effort'))}
          />
          <SelectSetting
            draft={draft}
            k="llm_circuit_breaker_threshold"
            label="Breaker threshold"
            hint="Consecutive failures before a provider is skipped."
            options={withSavedValue(BREAKER_THRESHOLD_OPTIONS, draft.value('llm_circuit_breaker_threshold'), (v) => `${v} failures`)}
          />
          <SelectSetting
            draft={draft}
            k="phase_a_max_tokens"
            label="Phase A tokens"
            hint="Extraction + scoring output budget."
            options={withSavedValue(PHASE_A_TOKEN_OPTIONS, draft.value('phase_a_max_tokens'), (v) => Number(v).toLocaleString())}
          />
          <SelectSetting
            draft={draft}
            k="phase_b_max_tokens"
            label="Phase B tokens"
            hint="Tailored resume + cover letter budget."
            options={withSavedValue(PHASE_B_TOKEN_OPTIONS, draft.value('phase_b_max_tokens'), (v) => Number(v).toLocaleString())}
          />
          <NumberSetting draft={draft} k="llm_circuit_breaker_cooldown_seconds" label="Breaker cooldown" suffix="s" />
          <NumberSetting
            draft={draft}
            k="auto_prepare_daily_cap_per_user"
            label="Auto-prepare daily cap"
            hint="Per user per day. 0 = unlimited."
          />
          <NumberSetting draft={draft} k="auto_prepare_pending_cap_per_user" label="Auto-prepare pending cap" hint="Per user." />
        </div>
      </SectionCard>

      <SectionCard
        title="Free scoring and AI check"
        description="The vector engine scores for free when users open Jobs. The AI check is a paid second opinion users turn on in Preferences."
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <NumberSetting
            draft={draft}
            k="auto_score_on_visit_limit"
            label="Catch-up per visit"
            hint="Unscored jobs queued when a user opens Jobs. 0 = off."
          />
          <NumberSetting
            draft={draft}
            k="auto_score_on_visit_cooldown_seconds"
            label="Catch-up cooldown"
            suffix="s"
            hint="Per user, minimum 30."
          />
          <Field>
            <FieldLabel htmlFor="sys-match-quality-check-model">AI check model</FieldLabel>
            <Input
              id="sys-match-quality-check-model"
              value={draft.value('match_quality_check_model')}
              className="font-mono"
              placeholder="gpt-5.6-luna"
              onChange={(e) => draft.set('match_quality_check_model', e.target.value)}
            />
            <FieldDescription>OpenAI model id. A binding for the AI check job below wins over this.</FieldDescription>
          </Field>
          <NumberSetting
            draft={draft}
            k="match_quality_check_daily_cap_per_user"
            label="AI check daily cap"
            hint="Per user per day. 0 = unlimited."
          />
        </div>
      </SectionCard>

      <SectionCard title="Automation" description="These switches save immediately.">
        <div className="space-y-3">
          <ToggleSetting
            item={draft.item('llm_fallback_enabled')}
            label="Provider fallback"
            description="When the chosen provider fails, retry on the next available provider."
          />
          <Separator />
          <ToggleSetting
            item={draft.item('auto_generate_tailored_content')}
            label="Auto tailor"
            description="Generate the tailored resume and cover letter after a successful analysis."
          />
          <Separator />
          <ToggleSetting
            item={draft.item('auto_prepare_enabled')}
            label="Auto-prepare"
            description="Allow background preparation of new jobs for users who opted in."
          />
        </div>
      </SectionCard>

      <SectionCard
        title="Provider models"
        description="Models are grouped by vendor from the gateway catalogue and registered keys. Test models are hidden."
      >
        <div className="divide-y">
          {PROVIDERS.map((p) => {
            const models = catalog.modelsForProvider(p.id);
            const loading = catalog.providerLoading(p.id);
            const current = draft.value(p.modelKey);
            const envReady = Boolean(settings.secrets_presence?.[`${p.id}_api_key`]);
            const options: Option[] = withSavedValue(
              models.map((m) => ({ value: m.id, label: m.id })),
              current,
            ).map((o) => (o.description ? { ...o, description: 'Saved, not in catalogue' } : o));
            const modelId = `sys-${p.modelKey.replace(/_/g, '-')}`;
            const modelItem = draft.item(p.modelKey);
            return (
              <div key={p.id} className="grid gap-4 py-4 first:pt-0 last:pb-0 sm:grid-cols-[10rem_minmax(0,1fr)_10rem]">
                <div className="flex items-center gap-2 sm:flex-col sm:items-start">
                  <span className="text-sm font-medium">{p.label}</span>
                  <Badge variant={envReady ? 'secondary' : 'outline'}>{envReady ? '.env key ready' : 'No .env key'}</Badge>
                </div>
                {modelItem ? (
                  <Field>
                    <div className="flex items-center gap-1.5">
                      <FieldLabel htmlFor={modelId}>{p.label} model</FieldLabel>
                      <Badge variant={modelItem.overridden ? 'secondary' : 'outline'} className="h-4 px-1.5 text-[10px]">
                        {modelItem.overridden ? 'DB' : '.env'}
                      </Badge>
                      <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
                        {loading ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
                        {models.length ? `${models.length} available` : null}
                      </span>
                    </div>
                    {models.length > 0 ? (
                      <OptionSelect id={modelId} value={current} options={options} onChange={(v) => draft.set(p.modelKey, v)} />
                    ) : (
                      <Input
                        id={modelId}
                        value={current}
                        className="font-mono"
                        placeholder={p.id === 'anthropic' ? 'claude-…' : loading ? 'Loading models…' : 'Model id'}
                        onChange={(e) => draft.set(p.modelKey, e.target.value)}
                      />
                    )}
                    {!loading && models.length === 0 ? (
                      <FieldDescription>No {p.label} models in the catalogue yet. Type a model id or register a key.</FieldDescription>
                    ) : null}
                  </Field>
                ) : (
                  <div />
                )}
                <NumberSetting draft={draft} k={p.timeoutKey} label="Timeout" suffix="s" />
              </div>
            );
          })}
        </div>
      </SectionCard>

      <SectionCard
        title="Job → model bindings"
        description="Which catalogue model each job uses. Keys resolve from user settings or the server .env."
      >
        {llm.bindings.length === 0 ? (
          <p className="text-sm text-muted-foreground">No job bindings reported by the server.</p>
        ) : (
          <div className="divide-y">
            {llm.bindings.map((b) => {
              const { models, loading, error } = catalog.modelsForBinding(b);
              const selected = bindingModel(b) ?? '';
              const options: Option[] = [
                { value: DEFAULT_MODEL, label: defaultModelId ? `Default · ${defaultModelId}` : 'System default' },
                ...(selected && !models.some((m) => m.id === selected)
                  ? [{ value: selected, label: selected, description: 'Saved, not in catalogue' }]
                  : []),
                ...models.map((m) => ({ value: m.id, label: m.id, description: FAMILY_LABEL[modelFamily(m.id)] })),
              ];
              const id = `binding-${b.job_type}`;
              return (
                <div key={b.job_type} className="grid gap-2 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_18rem] sm:items-center">
                  <div className="min-w-0">
                    <label htmlFor={id} className="text-sm font-medium">
                      {b.label}
                    </label>
                    <p className="text-sm text-muted-foreground">{b.description}</p>
                    {error ? <p className="text-xs text-destructive">{error}</p> : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <OptionSelect
                      id={id}
                      value={selected || DEFAULT_MODEL}
                      options={options}
                      onChange={(v) => setBindingDraft((d) => ({ ...d, [b.job_type]: v === DEFAULT_MODEL ? null : v }))}
                    />
                    {loading ? <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Loading models" /> : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>

      <SaveBar
        dirty={dirty && active}
        saving={saving}
        disabled={!draft.valid}
        onSave={() => void handleSave()}
        onDiscard={() => {
          draft.clear();
          setBindingDraft({});
        }}
      />
    </div>
  );
}
