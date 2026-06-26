import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, KeyRound, Loader2, Shield, Sparkles, Zap } from 'lucide-react';
import {
  saveOpenAiSettings,
  saveProviderKeySettings,
  testOpenAiKey,
  testProviderKey,
} from '../../api/settingsApi';
import type { SettingsMode, UserSettings } from '../../types/settings';

type ProviderId = 'openai' | 'anthropic' | 'gemini';

interface ProviderMeta {
  id: ProviderId;
  label: string;
  placeholder: string;
  gradient: string;
  dot: string;
  accentRing: string;
  accentBtn: string;
  docs: string;
  blurb: string;
}

const PROVIDERS: ProviderMeta[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    placeholder: 'sk-…',
    gradient: 'from-emerald-600 to-teal-600',
    dot: 'bg-emerald-500',
    accentRing: 'focus:border-emerald-400 focus:ring-emerald-200',
    accentBtn: 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100',
    docs: 'platform.openai.com',
    blurb: 'GPT models. Test your key before saving.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    placeholder: 'sk-ant-…',
    gradient: 'from-orange-500 to-amber-600',
    dot: 'bg-orange-500',
    accentRing: 'focus:border-orange-400 focus:ring-orange-200',
    accentBtn: 'border-orange-300 bg-orange-50 text-orange-800 hover:bg-orange-100',
    docs: 'console.anthropic.com',
    blurb: 'Claude models, used as the selected provider or a fallback.',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    placeholder: 'AIza…',
    gradient: 'from-blue-500 to-indigo-600',
    dot: 'bg-blue-500',
    accentRing: 'focus:border-blue-400 focus:ring-blue-200',
    accentBtn: 'border-blue-300 bg-blue-50 text-blue-800 hover:bg-blue-100',
    docs: 'aistudio.google.com',
    blurb: 'Google Gemini models, used as the selected provider or a fallback.',
  },
];

async function testKey(provider: ProviderId, apiKey?: string) {
  if (provider === 'openai') return testOpenAiKey(apiKey);
  return testProviderKey(provider, apiKey);
}

async function saveKey(
  provider: ProviderId,
  mode: SettingsMode,
  apiKey: string | undefined,
): Promise<UserSettings> {
  if (provider === 'openai') {
    return mode === 'default'
      ? saveOpenAiSettings({ openai_key_mode: 'default', clear_openai_api_key: true })
      : saveOpenAiSettings({
          openai_key_mode: 'custom',
          ...(apiKey ? { openai_api_key: apiKey } : {}),
        });
  }
  return saveProviderKeySettings(
    provider,
    mode === 'default' ? { mode: 'default', clear: true } : { mode: 'custom', apiKey },
  );
}

function ModeToggle({
  value,
  onChange,
  disabled,
}: {
  value: SettingsMode;
  onChange: (mode: SettingsMode) => void;
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
      {(['default', 'custom'] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          disabled={disabled}
          onClick={() => onChange(mode)}
          className={[
            'rounded-md px-3 py-1.5 text-xs font-semibold capitalize transition',
            value === mode
              ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
              : 'text-slate-500 hover:text-slate-700',
            disabled ? 'cursor-not-allowed opacity-50' : '',
          ].join(' ')}
        >
          {mode}
        </button>
      ))}
    </div>
  );
}

function SectionMessage({ ok, text }: { ok?: boolean; text: string }) {
  if (!text) return null;
  return (
    <p className={`mt-3 flex items-center gap-1.5 text-sm font-medium ${ok ? 'text-emerald-700' : 'text-rose-700'}`}>
      {ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
      {text}
    </p>
  );
}

interface PanelProps {
  meta: ProviderMeta;
  settings: UserSettings;
  onSaved: (data: UserSettings) => void;
}

function ProviderPanel({ meta, settings, onSaved }: PanelProps) {
  const provider = meta.id;
  const savedMode = settings[`${provider}_key_mode`];
  const savedConfigured = settings[`${provider}_key_configured`];
  const savedHint = settings[`${provider}_key_hint`];
  const systemAvailable = settings[`system_${provider}_available`];

  const [mode, setMode] = useState<SettingsMode>(savedMode);
  const [keyInput, setKeyInput] = useState('');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [testMsg, setTestMsg] = useState('');
  const [saveMsg, setSaveMsg] = useState('');
  const [saveOk, setSaveOk] = useState(false);

  useEffect(() => {
    setMode(savedMode);
    setKeyInput('');
    setTestOk(null);
    setTestMsg('');
    setSaveMsg('');
  }, [provider, savedMode, savedConfigured, savedHint]);

  useEffect(() => {
    if (!saveOk) return;
    const t = window.setTimeout(() => setSaveOk(false), 3000);
    return () => window.clearTimeout(t);
  }, [saveOk]);

  const keyDirty = keyInput.trim().length > 0;

  const handleModeChange = (next: SettingsMode) => {
    setMode(next);
    setTestOk(null);
    setTestMsg('');
    setSaveMsg('');
  };

  const handleKeyChange = (value: string) => {
    setKeyInput(value);
    setTestOk(null);
    setTestMsg('');
    setSaveMsg('');
  };

  const handleTest = async () => {
    setTesting(true);
    setTestMsg('');
    setTestOk(null);
    setSaveMsg('');
    try {
      const result = await testKey(provider, keyInput.trim() || undefined);
      setTestOk(result.ok);
      setTestMsg(result.message);
    } catch (err: unknown) {
      setTestOk(false);
      const msg =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : null;
      setTestMsg(typeof msg === 'string' ? msg : 'Key test failed.');
    } finally {
      setTesting(false);
    }
  };

  const saveEnabled = useMemo(() => {
    if (mode === 'default') return savedMode !== 'default';
    if (testOk !== true) return false;
    if (keyDirty) return true;
    if (savedMode !== 'custom') return true;
    return false;
  }, [mode, testOk, keyDirty, savedMode]);

  const handleSave = async () => {
    if (!saveEnabled) return;
    setSaving(true);
    setSaveMsg('');
    try {
      const data = await saveKey(provider, mode, keyDirty ? keyInput.trim() : undefined);
      onSaved(data);
      setSaveOk(true);
      setSaveMsg(mode === 'default' ? `Using the system default ${meta.label} key.` : `Custom ${meta.label} key saved.`);
    } catch (err: unknown) {
      setSaveOk(false);
      const msg =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : null;
      setSaveMsg(typeof msg === 'string' ? msg : 'Failed to save key.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600">{meta.blurb} Get a key at {meta.docs}.</p>
        <ModeToggle value={mode} onChange={handleModeChange} disabled={saving || testing} />
      </div>

      {mode === 'default' ? (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
          <Shield size={16} className="mt-0.5 shrink-0 text-slate-400" />
          <span>
            System default {meta.label} key
            {systemAvailable ? ' is available on this server.' : ' is not configured - use a custom key instead.'}
          </span>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {savedHint && !keyDirty && (
            <p className="text-xs text-slate-500">
              Saved key: <code className="rounded bg-slate-100 px-1.5 py-0.5">{savedHint}</code> - enter a new key to
              replace, or test the saved key.
            </p>
          )}
          <div>
            <label htmlFor={`${provider}-key`} className="text-xs font-semibold text-slate-700">
              Your {meta.label} API key
            </label>
            <input
              id={`${provider}-key`}
              type="password"
              autoComplete="off"
              placeholder={meta.placeholder}
              value={keyInput}
              onChange={(e) => handleKeyChange(e.target.value)}
              className={`mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-mono text-slate-800 shadow-sm focus:outline-none focus:ring-2 ${meta.accentRing}`}
            />
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {mode === 'custom' && (
          <button
            type="button"
            onClick={() => void handleTest()}
            disabled={testing || (keyDirty ? !keyInput.trim() : !savedConfigured)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${meta.accentBtn}`}
          >
            {testing ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
            {testing ? 'Testing…' : 'Test API key'}
          </button>
        )}
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!saveEnabled || saving}
          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? 'Saving…' : `Save ${meta.label} key`}
        </button>
      </div>

      {mode === 'custom' && testMsg && <SectionMessage ok={testOk === true} text={testMsg} />}
      {mode === 'custom' && testOk !== true && !testMsg && (
        <p className="mt-2 text-xs text-slate-500">
          Test your key to enable save{keyDirty ? '' : ' (or test the saved key)'}.
        </p>
      )}
      {saveMsg && <SectionMessage ok={saveOk} text={saveMsg} />}
    </div>
  );
}

interface ProviderKeysCardProps {
  settings: UserSettings;
  onSaved: (data: UserSettings) => void;
}

export function ProviderKeysCard({ settings, onSaved }: ProviderKeysCardProps) {
  const [active, setActive] = useState<ProviderId>('openai');
  const activeMeta = PROVIDERS.find((p) => p.id === active) ?? PROVIDERS[0];

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-slate-800 to-slate-900 text-white">
          <KeyRound size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-bold text-slate-900">AI provider API keys</h2>
          <p className="mt-0.5 text-sm leading-snug text-slate-500">
            Bring your own OpenAI, Anthropic, or Gemini key - saved independently and encrypted.
          </p>

          {/* Provider tabs */}
          <div className="mt-3 grid grid-cols-3 gap-2 rounded-xl border border-slate-200 bg-slate-50 p-1">
            {PROVIDERS.map((p) => {
              const mode = settings[`${p.id}_key_mode`];
              const configured = settings[`${p.id}_key_configured`];
              const isActive = p.id === active;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setActive(p.id)}
                  className={[
                    'group flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition',
                    isActive
                      ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
                      : 'text-slate-500 hover:text-slate-700',
                  ].join(' ')}
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${p.dot}`} />
                  <span className="truncate">{p.label}</span>
                  {mode === 'custom' && configured ? (
                    <CheckCircle2 size={14} className="shrink-0 text-emerald-500" />
                  ) : (
                    <span className="hidden text-[10px] font-medium uppercase tracking-wide text-slate-400 sm:inline">
                      {mode === 'custom' ? 'Custom' : 'Default'}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Active provider header accent */}
          <div className="mt-5 flex items-center gap-2.5">
            <div className={`flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br ${activeMeta.gradient} text-white`}>
              <Sparkles className="h-3.5 w-3.5" />
            </div>
            <h3 className="text-sm font-bold text-slate-900">{activeMeta.label}</h3>
          </div>

          <div className="mt-3">
            <ProviderPanel key={active} meta={activeMeta} settings={settings} onSaved={onSaved} />
          </div>
        </div>
      </div>
    </section>
  );
}
