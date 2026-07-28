import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, ChevronDown, Check, Loader2, RefreshCw } from 'lucide-react';
import { fetchUserSettings, updateUserSettings } from '../../api/settingsApi';
import { apiClient } from '../../api/client';
import { LlmModelGlyph, llmModelFamilyLabel } from '../shared/LlmModelIcon';

type DiscoveredModel = {
  id: string;
  owned_by?: string | null;
  usable_for_chat: boolean;
};

type ModelsResponse = {
  provider: string;
  base_url?: string | null;
  models: DiscoveredModel[];
  chat_models: DiscoveredModel[];
  count: number;
  message?: string | null;
};

const MENU_WIDTH = 288;
/** Match SyncButton: above stats/filter board, below modals. */
const MENU_Z = 180;

function shortModelLabel(id: string): string {
  if (id.length <= 28) return id;
  return `${id.slice(0, 25)}…`;
}

export function LlmProviderSelector() {
  /** Explicit user choice; null = use system default. */
  const [userModel, setUserModel] = useState<string | null>(null);
  const [defaultModel, setDefaultModel] = useState<string>('');
  const [models, setModels] = useState<DiscoveredModel[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const triggerRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  const loadModels = async () => {
    setModelsLoading(true);
    setError('');
    try {
      const { data } = await apiClient.get<ModelsResponse>('/settings/llm/models');
      if (!mounted.current) return;
      const raw =
        data.chat_models?.length > 0
          ? data.chat_models
          : data.models?.length
            ? data.models
            : [];
      // Hide gateway sandbox / test-* ids from the dashboard picker.
      const list = raw.filter((m) => {
        const id = (m.id || '').toLowerCase();
        return id && !id.startsWith('test-') && !id.startsWith('test_');
      });
      setModels(list);
      if (data.message && list.length === 0) {
        setError(data.message);
      }
    } catch (err: unknown) {
      if (!mounted.current) return;
      const msg =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : null;
      setError(typeof msg === 'string' ? msg : 'Failed to discover models.');
      setModels([]);
    } finally {
      if (mounted.current) setModelsLoading(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    void (async () => {
      try {
        const data = await fetchUserSettings();
        if (!mounted.current) return;
        setDefaultModel(data.default_llm_model || '');
        setUserModel(data.llm_model);
        await loadModels();
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

  const activeModel = userModel || defaultModel || '—';

  const handleSelect = async (next: string | null) => {
    setOpen(false);
    setError('');
    const prev = userModel;
    setUserModel(next);
    setSaving(true);
    try {
      const data = next
        ? await updateUserSettings({ llm_model: next })
        : await updateUserSettings({ clear_llm_model: true });
      if (!mounted.current) return;
      setDefaultModel(data.default_llm_model || '');
      setUserModel(data.llm_model);
    } catch (err: unknown) {
      if (!mounted.current) return;
      setUserModel(prev);
      const msg =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : null;
      setError(typeof msg === 'string' ? msg : 'Failed to switch model.');
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const updateMenuPos = () => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - MENU_WIDTH - 8);
    setMenuPos({ top: rect.bottom + 4, left });
  };

  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    updateMenuPos();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onReposition = () => updateMenuPos();
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    return () => {
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [open]);

  const modelMissing =
    !!userModel && models.length > 0 && !models.some((m) => m.id === userModel);

  const menu =
    open && menuPos
      ? createPortal(
          <>
            <div
              className="fixed inset-0"
              style={{ zIndex: MENU_Z }}
              onClick={() => setOpen(false)}
            />
            <div
              className="fixed max-h-[min(24rem,70vh)] w-72 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl dark:border-slate-500/50 dark:bg-[#0b1220]"
              style={{ zIndex: MENU_Z + 1, top: menuPos.top, left: menuPos.left }}
              role="menu"
            >
              <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-1.5 dark:border-white/10">
                <span className="text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-[#cbd5e1]">
                  AI model
                </span>
                <button
                  type="button"
                  onClick={() => void loadModels()}
                  disabled={modelsLoading}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-700 disabled:opacity-50 dark:text-[#cbd5e1] dark:hover:bg-white/10 dark:hover:text-white"
                  title="Refresh models from gateway"
                >
                  <RefreshCw size={11} className={modelsLoading ? 'animate-spin' : ''} />
                  Refresh
                </button>
              </div>
              <div className="max-h-[min(20rem,60vh)] overflow-y-auto py-1">
                {modelsLoading && models.length === 0 ? (
                  <div className="flex items-center gap-2 px-3 py-3 text-sm text-slate-500 dark:text-[#cbd5e1]">
                    <Loader2 size={14} className="animate-spin" />
                    Discovering models…
                  </div>
                ) : null}
                {!modelsLoading && models.length === 0 ? (
                  <div className="px-3 py-3 text-xs leading-snug text-slate-500 dark:text-[#cbd5e1]">
                    {error || 'No chat models discovered for this key.'}
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={() => void handleSelect(null)}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-slate-50 dark:hover:bg-white/10 ${
                    userModel == null ? 'bg-sky-50 dark:bg-sky-500/25' : ''
                  }`}
                >
                  <Bot size={15} className="shrink-0 text-slate-400 dark:text-[#94a3b8]" />
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block font-medium text-slate-900 dark:text-white">
                      System default
                    </span>
                    {defaultModel ? (
                      <span className="block truncate text-[11px] text-slate-500 dark:text-[#94a3b8]">
                        {defaultModel}
                      </span>
                    ) : null}
                  </span>
                  {userModel == null ? (
                    <Check size={14} className="shrink-0 text-emerald-500" />
                  ) : null}
                </button>
                {modelMissing ? (
                  <button
                    type="button"
                    onClick={() => void handleSelect(userModel)}
                    className="flex w-full items-center gap-2 bg-sky-50 px-3 py-2 text-sm transition-colors hover:bg-slate-50 dark:bg-sky-500/25 dark:hover:bg-white/10"
                  >
                    <LlmModelGlyph modelId={userModel || ''} size={14} />
                    <span className="min-w-0 flex-1 truncate text-left font-medium text-slate-900 dark:text-white">
                      {userModel}
                    </span>
                    <Check size={14} className="shrink-0 text-emerald-500" />
                  </button>
                ) : null}
                {models.map((m) => {
                  const active = userModel === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => void handleSelect(m.id)}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-slate-50 dark:hover:bg-white/10 ${
                        active ? 'bg-sky-50 dark:bg-sky-500/25' : ''
                      }`}
                    >
                      <LlmModelGlyph modelId={m.id} size={14} />
                      <span className="min-w-0 flex-1 text-left">
                        <span className="block truncate font-medium text-slate-900 dark:text-white">
                          {m.id}
                        </span>
                        <span className="block truncate text-[11px] text-slate-500 dark:text-[#94a3b8]">
                          {llmModelFamilyLabel(m.id)}
                        </span>
                      </span>
                      {active ? <Check size={14} className="shrink-0 text-emerald-500" /> : null}
                    </button>
                  );
                })}
              </div>
              <div className="border-t border-slate-100 px-3 py-1.5 text-[11px] leading-snug text-slate-500 dark:border-white/10 dark:text-[#94a3b8]">
                Fallback when a job has no Admin → System Settings model binding.
              </div>
            </div>
          </>,
          document.body,
        )
      : null;

  return (
    <div className="flex flex-col items-start gap-1">
      <div ref={triggerRef} className="relative inline-flex">
        <button
          type="button"
          disabled={loading}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="menu"
          title="Dashboard fallback model. Admin job bindings override this per pipeline stage."
          className="inline-flex max-w-[16rem] items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving || loading ? (
            <Loader2 size={16} className="shrink-0 animate-spin text-slate-400" />
          ) : (
            <LlmModelGlyph modelId={activeModel === '—' ? '' : activeModel} size={14} />
          )}
          <span className="hidden text-xs text-slate-400 sm:inline">Model</span>
          <span className="truncate font-semibold">{shortModelLabel(activeModel)}</span>
          <ChevronDown size={14} className="shrink-0 text-slate-400" />
        </button>
      </div>

      {menu}

      {error && !open ? (
        <p className="max-w-[16rem] text-right text-[11px] text-rose-600">{error}</p>
      ) : null}
    </div>
  );
}
