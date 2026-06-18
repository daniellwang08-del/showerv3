import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, KeyRound, Loader2, Shield, Zap } from 'lucide-react';
import { saveProviderKeySettings, testProviderKey } from '../../api/settingsApi';
import type { SettingsMode, UserSettings } from '../../types/settings';

type ByokProvider = 'anthropic' | 'gemini';

const PROVIDER_META: Record<ByokProvider, { title: string; placeholder: string; gradient: string; accentRing: string; docs: string }> = {
  anthropic: {
    title: 'Anthropic API key',
    placeholder: 'sk-ant-…',
    gradient: 'from-orange-500 to-amber-600',
    accentRing: 'focus:border-orange-400 focus:ring-orange-200',
    docs: 'console.anthropic.com',
  },
  gemini: {
    title: 'Gemini API key',
    placeholder: 'AIza…',
    gradient: 'from-blue-500 to-indigo-600',
    accentRing: 'focus:border-blue-400 focus:ring-blue-200',
    docs: 'aistudio.google.com',
  },
};

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

interface ProviderKeySectionProps {
  provider: ByokProvider;
  settings: UserSettings;
  onSaved: (data: UserSettings) => void;
}

export function ProviderKeySection({ provider, settings, onSaved }: ProviderKeySectionProps) {
  const meta = PROVIDER_META[provider];
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
  }, [savedMode, savedConfigured, savedHint]);

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
      const result = await testProviderKey(provider, keyInput.trim() || undefined);
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
      if (mode === 'default') {
        const data = await saveProviderKeySettings(provider, { mode: 'default', clear: true });
        onSaved(data);
        setSaveOk(true);
        setSaveMsg(`Using the system default ${meta.title.replace(' API key', '')} key.`);
      } else {
        const data = await saveProviderKeySettings(provider, {
          mode: 'custom',
          apiKey: keyDirty ? keyInput.trim() : undefined,
        });
        onSaved(data);
        setSaveOk(true);
        setSaveMsg('Custom key saved.');
      }
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
    <section className="h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-start gap-4">
        <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${meta.gradient} text-white`}>
          <KeyRound className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold text-slate-900">{meta.title}</h2>
            <ModeToggle value={mode} onChange={handleModeChange} disabled={saving || testing} />
          </div>
          <p className="mt-1 text-sm leading-relaxed text-slate-600">
            Used when {meta.title.replace(' API key', '')} is the selected provider (or a fallback). Keys are
            encrypted and never shown in full. Get one at {meta.docs}.
          </p>

          {mode === 'default' ? (
            <div className="mt-4 flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
              <Shield size={16} className="mt-0.5 shrink-0 text-slate-400" />
              <span>
                System default key
                {systemAvailable ? ' is available on this server.' : ' is not configured — use a custom key instead.'}
              </span>
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              {savedHint && !keyDirty && (
                <p className="text-xs text-slate-500">
                  Saved key: <code className="rounded bg-slate-100 px-1.5 py-0.5">{savedHint}</code> — enter a new key
                  to replace, or test the saved key.
                </p>
              )}
              <div>
                <label htmlFor={`${provider}-key`} className="text-xs font-semibold text-slate-700">
                  Your {meta.title.replace(' API key', '')} API key
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
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleTest()}
                  disabled={testing || (keyDirty ? !keyInput.trim() : !savedConfigured)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-800 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {testing ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
                  {testing ? 'Testing…' : 'Test API key'}
                </button>
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={!saveEnabled || saving}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save key'}
                </button>
              </div>
              {testMsg && <SectionMessage ok={testOk === true} text={testMsg} />}
              {testOk !== true && !testMsg && (
                <p className="text-xs text-slate-500">
                  Test your key to enable save{keyDirty ? '' : ' (or test the saved key)'}.
                </p>
              )}
            </div>
          )}

          {mode === 'default' && (
            <div className="mt-4">
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={!saveEnabled || saving}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save key'}
              </button>
            </div>
          )}

          {saveMsg && <SectionMessage ok={saveOk} text={saveMsg} />}
        </div>
      </div>
    </section>
  );
}
