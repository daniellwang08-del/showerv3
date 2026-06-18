import { useEffect, useRef, useState } from 'react';
import { Bot, ChevronDown, Check, Loader2, AlertTriangle } from 'lucide-react';
import {
  fetchUserSettings,
  setActiveLlmProvider,
} from '../../api/settingsApi';
import { LLM_PROVIDERS, LLM_PROVIDER_LABELS, type LlmProvider } from '../../types/settings';

const PROVIDER_ACCENT: Record<LlmProvider, string> = {
  openai: 'text-emerald-600',
  anthropic: 'text-orange-600',
  gemini: 'text-blue-600',
};

export function LlmProviderSelector() {
  const [provider, setProvider] = useState<LlmProvider>('openai');
  const [available, setAvailable] = useState<LlmProvider[]>(['openai']);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<LlmProvider | null>(null);
  const [error, setError] = useState('');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void (async () => {
      try {
        const data = await fetchUserSettings();
        if (!mounted.current) return;
        setProvider(data.llm_provider);
        setAvailable(data.available_providers?.length ? data.available_providers : ['openai']);
      } catch {
        /* keep defaults */
      } finally {
        if (mounted.current) setLoading(false);
      }
    })();
    return () => {
      mounted.current = false;
    };
  }, []);

  const handleSelect = async (next: LlmProvider) => {
    setOpen(false);
    setError('');
    if (next === provider) return;
    const prev = provider;
    setProvider(next);
    setSaving(next);
    try {
      const data = await setActiveLlmProvider(next);
      if (!mounted.current) return;
      setProvider(data.llm_provider);
      setAvailable(data.available_providers?.length ? data.available_providers : ['openai']);
    } catch (err: unknown) {
      if (!mounted.current) return;
      setProvider(prev);
      const msg =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : null;
      setError(typeof msg === 'string' ? msg : 'Failed to switch provider.');
    } finally {
      if (mounted.current) setSaving(null);
    }
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <div className="relative inline-flex">
        <button
          type="button"
          disabled={loading}
          onClick={() => setOpen((v) => !v)}
          title="Choose which LLM provider powers AI extraction, matching, and document generation"
          className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? (
            <Loader2 size={16} className="animate-spin text-slate-400" />
          ) : (
            <Bot size={16} className={PROVIDER_ACCENT[provider]} />
          )}
          <span className="hidden sm:inline text-xs text-slate-400">LLM</span>
          <span className="font-semibold">{LLM_PROVIDER_LABELS[provider]}</span>
          <ChevronDown size={14} className="text-slate-400" />
        </button>

        {open && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
            <div className="absolute left-0 top-full mt-1 z-20 w-64 rounded-lg border border-slate-200 bg-white shadow-lg py-1">
              <div className="px-3 py-1.5 text-xs font-medium text-slate-500 uppercase tracking-wider">
                AI provider
              </div>
              {LLM_PROVIDERS.map((p) => {
                const isAvailable = available.includes(p);
                const isActive = p === provider;
                return (
                  <button
                    key={p}
                    type="button"
                    disabled={!isAvailable}
                    onClick={() => void handleSelect(p)}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors ${
                      isAvailable
                        ? 'text-slate-700 hover:bg-slate-50'
                        : 'text-slate-400 cursor-not-allowed'
                    }`}
                  >
                    <Bot size={15} className={isAvailable ? PROVIDER_ACCENT[p] : 'text-slate-300'} />
                    <span className="flex-1 text-left font-medium">{LLM_PROVIDER_LABELS[p]}</span>
                    {isActive && <Check size={14} className="text-emerald-500 shrink-0" />}
                    {!isAvailable && (
                      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 font-medium">
                        <AlertTriangle size={10} />
                        No key
                      </span>
                    )}
                  </button>
                );
              })}
              <div className="px-3 pt-1.5 pb-1 text-[11px] leading-snug text-slate-400 border-t border-slate-100 mt-1">
                Add API keys for other providers in Settings.
              </div>
            </div>
          </>
        )}
      </div>

      {error && <p className="max-w-[14rem] text-right text-[11px] text-rose-600">{error}</p>}
    </div>
  );
}
