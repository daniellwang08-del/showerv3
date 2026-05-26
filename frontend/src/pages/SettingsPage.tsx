import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  FileText,
  KeyRound,
  Loader2,
  RefreshCw,
  Search,
  Settings2,
  Shield,
  Target,
  Zap,
} from 'lucide-react';
import {
  fetchUserSettings,
  saveDedupSettings,
  saveMinMatchScoreSettings,
  saveOpenAiSettings,
  saveResumeTailoringPromptSettings,
  testOpenAiKey,
  previewMinMatchScore,
  applyMinMatchScore,
  type MinMatchScorePreview,
} from '../api/settingsApi';
import type { SettingsMode, UserSettings } from '../types/settings';
import { RESUME_TAILORING_PROMPT_MIN_LENGTH } from '../types/settings';
import { MarkdownPromptEditor, MarkdownPromptPreview } from '../components/settings/MarkdownPromptEditor';
import { ResumeTemplateSection } from '../components/settings/ResumeTemplateSection';
import { PageScrollArea } from '../components/layout/PageScrollArea';
import { useJobsStore } from '../stores/jobsStore';
import { useScraperStore } from '../stores/scraperStore';

const DEDUP_SLIDER_MAX = 365;
const DEDUP_PRESETS = [30, 60, 90, 180] as const;
const MATCH_SCORE_PRESETS = [0, 40, 50, 60, 70, 80] as const;

function resolveStoredPromptText(data: Pick<UserSettings, 'resume_tailoring_prompt_instructions_custom' | 'default_resume_tailoring_prompt_instructions'>) {
  return (
    data.resume_tailoring_prompt_instructions_custom ||
    data.default_resume_tailoring_prompt_instructions ||
    ''
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
    <p
      className={`mt-3 flex items-center gap-1.5 text-sm font-medium ${
        ok ? 'text-emerald-700' : 'text-rose-700'
      }`}
    >
      {ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
      {text}
    </p>
  );
}

export function SettingsPage() {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // OpenAI section state
  const [openaiMode, setOpenaiMode] = useState<SettingsMode>('default');
  const [openaiKeyInput, setOpenaiKeyInput] = useState('');
  const [openaiTesting, setOpenaiTesting] = useState(false);
  const [openaiSaving, setOpenaiSaving] = useState(false);
  const [openaiTestOk, setOpenaiTestOk] = useState<boolean | null>(null);
  const [openaiTestMsg, setOpenaiTestMsg] = useState('');
  const [openaiSaveMsg, setOpenaiSaveMsg] = useState('');
  const [openaiSaveOk, setOpenaiSaveOk] = useState(false);

  // Dedup section state
  const [dedupMode, setDedupMode] = useState<SettingsMode>('default');
  const [dedupDays, setDedupDays] = useState(60);
  const [dedupSaving, setDedupSaving] = useState(false);
  const [dedupSaveMsg, setDedupSaveMsg] = useState('');
  const [dedupSaveOk, setDedupSaveOk] = useState(false);

  // Min match score section state
  const [minScoreMode, setMinScoreMode] = useState<SettingsMode>('default');
  const [minScore, setMinScore] = useState(0);
  const [minScoreSaving, setMinScoreSaving] = useState(false);
  const [minScoreSaveMsg, setMinScoreSaveMsg] = useState('');
  const [minScoreSaveOk, setMinScoreSaveOk] = useState(false);
  const [minScoreChecking, setMinScoreChecking] = useState(false);
  const [minScoreCheckResult, setMinScoreCheckResult] = useState<MinMatchScorePreview | null>(null);
  const [minScoreCheckMsg, setMinScoreCheckMsg] = useState('');
  const [minScoreApplying, setMinScoreApplying] = useState(false);

  // Resume tailoring prompt section state
  const [promptMode, setPromptMode] = useState<SettingsMode>('default');
  const [promptText, setPromptText] = useState('');
  const [promptSaving, setPromptSaving] = useState(false);
  const [promptSaveMsg, setPromptSaveMsg] = useState('');
  const [promptSaveOk, setPromptSaveOk] = useState(false);

  const applySettings = useCallback((data: UserSettings) => {
    setSettings(data);
    setOpenaiMode(data.openai_key_mode);
    setDedupMode(data.dedup_recycle_mode);
    setDedupDays(data.dedup_recycle_days_custom);
    setMinScoreMode(data.min_match_score_mode);
    setMinScore(data.min_match_score_custom);
    setPromptMode(data.resume_tailoring_prompt_mode ?? 'default');
    setPromptText(resolveStoredPromptText(data));
    setOpenaiKeyInput('');
    setOpenaiTestOk(null);
    setOpenaiTestMsg('');
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const data = await fetchUserSettings();
      applySettings(data);
    } catch (err: unknown) {
      const msg =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : null;
      setLoadError(typeof msg === 'string' ? msg : 'Failed to load settings.');
    } finally {
      setLoading(false);
    }
  }, [applySettings]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!openaiSaveOk) return;
    const t = window.setTimeout(() => setOpenaiSaveOk(false), 3000);
    return () => window.clearTimeout(t);
  }, [openaiSaveOk]);

  useEffect(() => {
    if (!dedupSaveOk) return;
    const t = window.setTimeout(() => setDedupSaveOk(false), 3000);
    return () => window.clearTimeout(t);
  }, [dedupSaveOk]);

  useEffect(() => {
    if (!minScoreSaveOk) return;
    const t = window.setTimeout(() => setMinScoreSaveOk(false), 3000);
    return () => window.clearTimeout(t);
  }, [minScoreSaveOk]);

  useEffect(() => {
    if (!promptSaveOk) return;
    const t = window.setTimeout(() => setPromptSaveOk(false), 3000);
    return () => window.clearTimeout(t);
  }, [promptSaveOk]);

  const defaultDedup = settings?.default_dedup_recycle_days ?? 60;
  const defaultMinScore = settings?.default_min_match_score ?? 0;
  const savedOpenaiMode = settings?.openai_key_mode ?? 'default';
  const savedDedupMode = settings?.dedup_recycle_mode ?? 'default';
  const savedDedupDays = settings?.dedup_recycle_days_custom ?? 60;
  const savedMinScoreMode = settings?.min_match_score_mode ?? 'default';
  const savedMinScore = settings?.min_match_score_custom ?? 0;
  const savedPromptMode = settings?.resume_tailoring_prompt_mode ?? 'default';
  const savedPromptText = resolveStoredPromptText({
    resume_tailoring_prompt_instructions_custom:
      settings?.resume_tailoring_prompt_instructions_custom ?? '',
    default_resume_tailoring_prompt_instructions:
      settings?.default_resume_tailoring_prompt_instructions ?? '',
  });
  const defaultPromptInstructions = settings?.default_resume_tailoring_prompt_instructions ?? '';
  const promptMaxLength = settings?.resume_tailoring_prompt_max_length ?? 12000;
  const safePromptText = promptText ?? '';

  const openaiKeyDirty = openaiKeyInput.trim().length > 0;

  const handleOpenaiModeChange = (mode: SettingsMode) => {
    setOpenaiMode(mode);
    setOpenaiTestOk(null);
    setOpenaiTestMsg('');
    setOpenaiSaveMsg('');
    if (mode === 'custom' && openaiKeyDirty) {
      setOpenaiTestOk(null);
    }
  };

  const handleOpenaiKeyChange = (value: string) => {
    setOpenaiKeyInput(value);
    setOpenaiTestOk(null);
    setOpenaiTestMsg('');
    setOpenaiSaveMsg('');
  };

  const handleTestOpenAiKey = async () => {
    setOpenaiTesting(true);
    setOpenaiTestMsg('');
    setOpenaiTestOk(null);
    setOpenaiSaveMsg('');
    try {
      const result = await testOpenAiKey(openaiKeyInput.trim() || undefined);
      setOpenaiTestOk(result.ok);
      setOpenaiTestMsg(result.message);
    } catch (err: unknown) {
      setOpenaiTestOk(false);
      const msg =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : null;
      setOpenaiTestMsg(typeof msg === 'string' ? msg : 'Key test failed.');
    } finally {
      setOpenaiTesting(false);
    }
  };

  const openaiSaveEnabled = useMemo(() => {
    if (!settings) return false;
    if (openaiMode === 'default') {
      return savedOpenaiMode !== 'default';
    }
    // custom mode — must pass test first
    if (openaiTestOk !== true) return false;
    if (openaiKeyDirty) return true;
    if (savedOpenaiMode !== 'custom') return true;
    return false;
  }, [settings, openaiMode, openaiTestOk, openaiKeyDirty, savedOpenaiMode]);

  const handleSaveOpenAi = async () => {
    if (!settings || !openaiSaveEnabled) return;
    setOpenaiSaving(true);
    setOpenaiSaveMsg('');
    try {
      if (openaiMode === 'default') {
        const data = await saveOpenAiSettings({
          openai_key_mode: 'default',
          clear_openai_api_key: true,
        });
        applySettings(data);
        setOpenaiSaveOk(true);
        setOpenaiSaveMsg('Using system default OpenAI key.');
      } else {
        const body: Parameters<typeof saveOpenAiSettings>[0] = {
          openai_key_mode: 'custom',
        };
        if (openaiKeyDirty) {
          body.openai_api_key = openaiKeyInput.trim();
        }
        const data = await saveOpenAiSettings(body);
        applySettings(data);
        setOpenaiSaveOk(true);
        setOpenaiSaveMsg('Custom OpenAI key saved.');
      }
    } catch (err: unknown) {
      setOpenaiSaveOk(false);
      const msg =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : null;
      setOpenaiSaveMsg(typeof msg === 'string' ? msg : 'Failed to save OpenAI settings.');
    } finally {
      setOpenaiSaving(false);
    }
  };

  const dedupChanged =
    dedupMode !== savedDedupMode ||
    (dedupMode === 'custom' && dedupDays !== savedDedupDays);

  const dedupSaveEnabled =
    dedupMode === 'default'
      ? savedDedupMode !== 'default'
      : dedupChanged && dedupDays >= 1 && dedupDays <= 3650;

  const handleDedupDaysChange = (value: number) => {
    const clamped = Math.max(1, Math.min(3650, value));
    setDedupDays(clamped);
    setDedupSaveMsg('');
  };

  const handleSaveDedup = async () => {
    if (!settings || !dedupSaveEnabled) return;
    setDedupSaving(true);
    setDedupSaveMsg('');
    try {
      const data =
        dedupMode === 'default'
          ? await saveDedupSettings({ dedup_recycle_mode: 'default' })
          : await saveDedupSettings({
              dedup_recycle_mode: 'custom',
              dedup_recycle_days: dedupDays,
            });
      applySettings(data);
      setDedupSaveOk(true);
      setDedupSaveMsg(
        dedupMode === 'default'
          ? `Using system default (${defaultDedup} days).`
          : `Custom check cycle saved (${dedupDays} days).`,
      );
    } catch (err: unknown) {
      setDedupSaveOk(false);
      const msg =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : null;
      setDedupSaveMsg(typeof msg === 'string' ? msg : 'Failed to save check cycle.');
    } finally {
      setDedupSaving(false);
    }
  };

  const minScoreChanged =
    minScoreMode !== savedMinScoreMode ||
    (minScoreMode === 'custom' && minScore !== savedMinScore);

  const minScoreSaveEnabled =
    minScoreMode === 'default'
      ? savedMinScoreMode !== 'default'
      : minScoreChanged && minScore >= 0 && minScore <= 100;

  const handleMinScoreChange = (value: number) => {
    setMinScore(Math.max(0, Math.min(100, value)));
    setMinScoreSaveMsg('');
    setMinScoreCheckResult(null);
    setMinScoreCheckMsg('');
  };

  const minScoreDraftBody = () =>
    minScoreMode === 'default'
      ? ({ min_match_score_mode: 'default' as const })
      : ({ min_match_score_mode: 'custom' as const, min_match_score: minScore });

  const draftThreshold = minScoreMode === 'default' ? defaultMinScore : minScore;

  const handleCheckMinScoreJobs = async () => {
    if (!settings) return;
    setMinScoreChecking(true);
    setMinScoreCheckMsg('');
    setMinScoreCheckResult(null);
    try {
      const result = await previewMinMatchScore(minScoreDraftBody());
      setMinScoreCheckResult(result);
      if (result.threshold <= 0) {
        setMinScoreCheckMsg(
          result.analyzed_visible_count === 0
            ? 'No analyzed jobs in your dashboard yet.'
            : `All ${result.analyzed_visible_count} analyzed jobs are shown (threshold 0).`,
        );
      } else if (result.would_hide_count === 0) {
        setMinScoreCheckMsg(
          `None of your ${result.analyzed_visible_count} analyzed dashboard jobs score below ${result.threshold}.`,
        );
      } else {
        setMinScoreCheckMsg(
          `${result.would_hide_count} analyzed job${result.would_hide_count === 1 ? '' : 's'} ` +
            `in your dashboard score below ${result.threshold}.`,
        );
      }
    } catch (err: unknown) {
      const msg =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : null;
      setMinScoreCheckMsg(typeof msg === 'string' ? msg : 'Failed to check jobs.');
    } finally {
      setMinScoreChecking(false);
    }
  };

  const hideJobsEnabled =
    minScoreCheckResult !== null &&
    (minScoreCheckResult.would_hide_count > 0 ||
      minScoreCheckResult.would_restore_count > 0 ||
      minScoreChanged);

  const handleHideMinScoreJobs = async () => {
    if (!settings || !minScoreCheckResult || !hideJobsEnabled) return;
    setMinScoreApplying(true);
    setMinScoreSaveMsg('');
    try {
      const result = await applyMinMatchScore(minScoreDraftBody());
      applySettings(result.settings);
      setMinScoreCheckResult(null);
      setMinScoreCheckMsg('');
      setMinScoreSaveOk(true);
      const parts: string[] = [];
      if (result.hidden > 0) {
        parts.push(`${result.hidden} job${result.hidden === 1 ? '' : 's'} hidden from dashboard`);
      }
      if (result.restored > 0) {
        parts.push(`${result.restored} job${result.restored === 1 ? '' : 's'} restored to dashboard`);
      }
      setMinScoreSaveMsg(
        parts.length > 0
          ? `${parts.join('; ')}. Threshold saved at ${result.min_match_score}.`
          : `Threshold saved at ${result.min_match_score}.`,
      );
      void useJobsStore.getState().refreshLists({ showLoading: false, reset: true });
      void useScraperStore.getState().loadJobs();
    } catch (err: unknown) {
      setMinScoreSaveOk(false);
      const msg =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : null;
      setMinScoreSaveMsg(typeof msg === 'string' ? msg : 'Failed to hide jobs from dashboard.');
    } finally {
      setMinScoreApplying(false);
    }
  };

  const handleSaveMinScore = async () => {
    if (!settings || !minScoreSaveEnabled) return;
    setMinScoreSaving(true);
    setMinScoreSaveMsg('');
    try {
      const data =
        minScoreMode === 'default'
          ? await saveMinMatchScoreSettings({ min_match_score_mode: 'default' })
          : await saveMinMatchScoreSettings({
              min_match_score_mode: 'custom',
              min_match_score: minScore,
            });
      applySettings(data);
      setMinScoreSaveOk(true);
      setMinScoreSaveMsg(
        minScoreMode === 'default'
          ? `Threshold saved (system default: ${defaultMinScore}). New analyses use this rule automatically.`
          : `Threshold saved (${minScore}). New analyses below this score will be hidden automatically.`,
      );
    } catch (err: unknown) {
      setMinScoreSaveOk(false);
      const msg =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : null;
      setMinScoreSaveMsg(typeof msg === 'string' ? msg : 'Failed to save match score threshold.');
    } finally {
      setMinScoreSaving(false);
    }
  };

  const promptTrimmed = safePromptText.trim();
  const savedPromptTextTrimmed = savedPromptText.trim();
  const promptChanged =
    promptMode !== savedPromptMode ||
    (promptMode === 'custom' && promptTrimmed !== savedPromptTextTrimmed);
  const promptValidLength =
    promptTrimmed.length >= RESUME_TAILORING_PROMPT_MIN_LENGTH &&
    promptTrimmed.length <= promptMaxLength;
  const promptSaveEnabled =
    promptMode === 'default'
      ? savedPromptMode !== 'default'
      : promptChanged && promptValidLength;

  const handlePromptModeChange = (mode: SettingsMode) => {
    setPromptMode(mode);
    setPromptSaveMsg('');
    if (mode === 'custom' && !promptTrimmed) {
      setPromptText(defaultPromptInstructions);
    }
  };

  const handleResetPrompt = () => {
    setPromptText(defaultPromptInstructions);
    setPromptSaveMsg('');
  };

  const handleSavePrompt = async () => {
    if (!settings || !promptSaveEnabled) return;
    setPromptSaving(true);
    setPromptSaveMsg('');
    try {
      const data =
        promptMode === 'default'
          ? await saveResumeTailoringPromptSettings({ resume_tailoring_prompt_mode: 'default' })
          : await saveResumeTailoringPromptSettings({
              resume_tailoring_prompt_mode: 'custom',
              resume_tailoring_prompt_custom: promptTrimmed,
            });
      applySettings(data);
      setPromptSaveOk(true);
      setPromptSaveMsg(
        promptMode === 'default'
          ? 'Using the built-in resume tailoring prompt for new generations.'
          : 'Custom resume tailoring prompt saved. Rerun jobs to regenerate documents.',
      );
    } catch (err: unknown) {
      setPromptSaveOk(false);
      const msg =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : null;
      setPromptSaveMsg(typeof msg === 'string' ? msg : 'Failed to save resume tailoring prompt.');
    } finally {
      setPromptSaving(false);
    }
  };

  const sliderValue = Math.min(dedupDays, DEDUP_SLIDER_MAX);

  return (
    <PageScrollArea>
      <div className="w-full px-5 py-5">
      <div className="mb-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-900 text-white">
            <Settings2 size={20} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Settings</h1>
            <p className="text-sm text-slate-500">
              OpenAI, company check cycle, match score threshold, and resume tailoring prompt are saved separately.
            </p>
          </div>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-slate-500">Loading settings…</p>
      ) : loadError ? (
        <p className="text-sm text-rose-700">{loadError}</p>
      ) : (
        <div className="space-y-5">
          <div className="grid gap-5 xl:grid-cols-3 items-start">
          {/* OpenAI */}
          <section className="h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-start gap-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-600 to-teal-600 text-white">
                <KeyRound className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-lg font-bold text-slate-900">OpenAI API key</h2>
                  <ModeToggle
                    value={openaiMode}
                    onChange={handleOpenaiModeChange}
                    disabled={openaiSaving || openaiTesting}
                  />
                </div>
                <p className="mt-1 text-sm leading-relaxed text-slate-600">
                  Test your key before saving. Custom keys are encrypted and never shown in full.
                </p>

                {openaiMode === 'default' ? (
                  <div className="mt-4 flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
                    <Shield size={16} className="mt-0.5 shrink-0 text-slate-400" />
                    <span>
                      System default key
                      {settings?.system_openai_available
                        ? ' is available on this server.'
                        : ' is not configured — use a custom key instead.'}
                    </span>
                  </div>
                ) : (
                  <div className="mt-4 space-y-3">
                    {settings?.openai_key_hint && !openaiKeyDirty && (
                      <p className="text-xs text-slate-500">
                        Saved key:{' '}
                        <code className="rounded bg-slate-100 px-1.5 py-0.5">{settings.openai_key_hint}</code>
                        {' '}— enter a new key to replace, or test the saved key.
                      </p>
                    )}
                    <div>
                      <label htmlFor="openai-key" className="text-xs font-semibold text-slate-700">
                        Your OpenAI API key
                      </label>
                      <input
                        id="openai-key"
                        type="password"
                        autoComplete="off"
                        placeholder="sk-…"
                        value={openaiKeyInput}
                        onChange={(e) => handleOpenaiKeyChange(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-mono text-slate-800 shadow-sm focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleTestOpenAiKey()}
                        disabled={
                          openaiTesting ||
                          (openaiKeyDirty ? !openaiKeyInput.trim() : !settings?.openai_key_configured)
                        }
                        className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {openaiTesting ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Zap size={14} />
                        )}
                        {openaiTesting ? 'Testing…' : 'Test API key'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleSaveOpenAi()}
                        disabled={!openaiSaveEnabled || openaiSaving}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {openaiSaving ? 'Saving…' : 'Save OpenAI settings'}
                      </button>
                    </div>
                    {openaiTestMsg && (
                      <SectionMessage ok={openaiTestOk === true} text={openaiTestMsg} />
                    )}
                    {openaiMode === 'custom' && openaiTestOk !== true && !openaiTestMsg && (
                      <p className="text-xs text-slate-500">
                        Test your key to enable save{openaiKeyDirty ? '' : ' (or test the saved key)'}.
                      </p>
                    )}
                  </div>
                )}

                {openaiMode === 'default' && (
                  <div className="mt-4">
                    <button
                      type="button"
                      onClick={() => void handleSaveOpenAi()}
                      disabled={!openaiSaveEnabled || openaiSaving}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {openaiSaving ? 'Saving…' : 'Save OpenAI settings'}
                    </button>
                  </div>
                )}

                {openaiSaveMsg && (
                  <SectionMessage ok={openaiSaveOk} text={openaiSaveMsg} />
                )}
              </div>
            </div>
          </section>

          {/* Min match score */}
          <section className="h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-start gap-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-rose-600 to-orange-600 text-white">
                <Target className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-lg font-bold text-slate-900">Minimum match score</h2>
                  <ModeToggle
                    value={minScoreMode}
                    onChange={(m) => {
                      setMinScoreMode(m);
                      setMinScoreSaveMsg('');
                      setMinScoreCheckResult(null);
                      setMinScoreCheckMsg('');
                    }}
                    disabled={minScoreSaving}
                  />
                </div>
                <p className="mt-1 text-sm leading-relaxed text-slate-600">
                  After each job finishes AI analysis, scores below this threshold are automatically
                  hidden from the dashboard (Low match tab). Use Check jobs to preview already-analyzed
                  jobs, then hide them from the main list.
                </p>

                {minScoreMode === 'default' ? (
                  <div className="mt-4 rounded-lg border border-rose-100 bg-rose-50/60 px-3 py-2.5 text-sm text-rose-900">
                    System default: <strong>{defaultMinScore}</strong>
                    {defaultMinScore === 0 ? ' (show all scored jobs)' : '+'}
                  </div>
                ) : (
                  <div className="mt-4 space-y-4">
                    <div>
                      <div className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-700">
                        <label htmlFor="min-score-slider">Minimum score</label>
                        <span className="tabular-nums text-rose-700">{minScore}</span>
                      </div>
                      <input
                        id="min-score-slider"
                        type="range"
                        min={0}
                        max={100}
                        value={minScore}
                        onChange={(e) => handleMinScoreChange(Number(e.target.value))}
                        className="h-2 w-full cursor-pointer accent-rose-600"
                      />
                      <div className="mt-1 flex w-full justify-between text-[10px] text-slate-400">
                        <span>0</span>
                        <span>100</span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-end gap-3">
                      <div>
                        <label htmlFor="min-score" className="text-xs font-semibold text-slate-700">
                          Exact score
                        </label>
                        <div className="mt-1 flex items-center gap-2">
                          <input
                            id="min-score"
                            type="number"
                            min={0}
                            max={100}
                            value={minScore}
                            onChange={(e) => handleMinScoreChange(Number(e.target.value) || 0)}
                            className="w-24 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 shadow-sm focus:border-rose-400 focus:outline-none focus:ring-2 focus:ring-rose-200"
                          />
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2 pb-[2px]">
                        {MATCH_SCORE_PRESETS.map((preset) => (
                          <button
                            key={preset}
                            type="button"
                            onClick={() => handleMinScoreChange(preset)}
                            className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${
                              minScore === preset
                                ? 'border-rose-400 bg-rose-100 text-rose-800'
                                : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                            }`}
                          >
                            {preset === 0 ? 'All' : preset}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleCheckMinScoreJobs()}
                    disabled={minScoreChecking || minScoreApplying || minScoreSaving}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {minScoreChecking ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Search size={14} />
                    )}
                    {minScoreChecking ? 'Checking…' : 'Check jobs'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleHideMinScoreJobs()}
                    disabled={!hideJobsEnabled || minScoreApplying || minScoreChecking || minScoreSaving}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {minScoreApplying ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : null}
                    {minScoreApplying ? 'Applying…' : 'Hide from dashboard'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSaveMinScore()}
                    disabled={!minScoreSaveEnabled || minScoreSaving || minScoreApplying}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {minScoreSaving ? 'Saving…' : 'Save threshold only'}
                  </button>
                </div>

                {!minScoreCheckResult && !minScoreCheckMsg && draftThreshold > 0 && (
                  <p className="mt-2 text-xs text-slate-500">
                    Set your threshold, click Check jobs to see how many existing analyzed jobs would be hidden.
                  </p>
                )}

                {minScoreCheckMsg && (
                  <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700">
                    {minScoreCheckMsg}
                  </div>
                )}

                {minScoreCheckResult && minScoreCheckResult.samples.length > 0 && (
                  <div className="mt-3 rounded-lg border border-rose-100 bg-rose-50/40 px-3 py-2.5">
                    <p className="text-xs font-semibold text-rose-900">
                      Most recent jobs below {minScoreCheckResult.threshold}
                    </p>
                    <ul className="mt-2 space-y-1.5">
                      {minScoreCheckResult.samples.map((job) => (
                        <li key={job.job_id} className="flex items-center justify-between gap-2 text-xs text-slate-700">
                          <span className="truncate">
                            {job.title || 'Untitled'}
                            {job.company ? ` · ${job.company}` : ''}
                          </span>
                          <span className="shrink-0 font-bold tabular-nums text-rose-700">{job.match_score}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {minScoreCheckResult && (
                  <div className="mt-3 grid grid-cols-2 gap-2 xl:grid-cols-2 2xl:grid-cols-4">
                    {[
                      ['Analyzed visible', minScoreCheckResult.analyzed_visible_count],
                      ['Would hide', minScoreCheckResult.would_hide_count],
                      ['Already hidden', minScoreCheckResult.already_hidden_count],
                      ['Would restore', minScoreCheckResult.would_restore_count],
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-center"
                      >
                        <div className="text-lg font-bold tabular-nums text-slate-900">{value}</div>
                        <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">{label}</div>
                      </div>
                    ))}
                  </div>
                )}

                {minScoreSaveMsg && <SectionMessage ok={minScoreSaveOk} text={minScoreSaveMsg} />}
              </div>
            </div>
          </section>

          {/* Company check cycle */}
          <section className="h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-start gap-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-purple-600 text-white">
                <RefreshCw className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-lg font-bold text-slate-900">Company check cycle</h2>
                  <ModeToggle
                    value={dedupMode}
                    onChange={(m) => {
                      setDedupMode(m);
                      setDedupSaveMsg('');
                    }}
                    disabled={dedupSaving}
                  />
                </div>
                <p className="mt-1 text-sm leading-relaxed text-slate-600">
                  Days before a new posting at the same company is treated as fresh again.
                </p>

                {dedupMode === 'default' ? (
                  <div className="mt-4 rounded-lg border border-indigo-100 bg-indigo-50/60 px-3 py-2.5 text-sm text-indigo-900">
                    System default: <strong>{defaultDedup} days</strong>
                  </div>
                ) : (
                  <div className="mt-4 space-y-4">
                    <div>
                      <div className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-700">
                        <label htmlFor="dedup-slider">Recycle period</label>
                        <span className="tabular-nums text-indigo-700">{dedupDays} days</span>
                      </div>
                      <input
                        id="dedup-slider"
                        type="range"
                        min={1}
                        max={DEDUP_SLIDER_MAX}
                        value={sliderValue}
                        onChange={(e) => handleDedupDaysChange(Number(e.target.value))}
                        className="h-2 w-full cursor-pointer accent-indigo-600"
                      />
                      <div className="mt-1 flex w-full justify-between text-[10px] text-slate-400">
                        <span>1d</span>
                        <span>{DEDUP_SLIDER_MAX}d</span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-end gap-3">
                      <div>
                        <label htmlFor="dedup-days" className="text-xs font-semibold text-slate-700">
                          Exact days
                        </label>
                        <div className="mt-1 flex items-center gap-2">
                          <input
                            id="dedup-days"
                            type="number"
                            min={1}
                            max={3650}
                            value={dedupDays}
                            onChange={(e) => handleDedupDaysChange(Number(e.target.value) || 1)}
                            className="w-24 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200"
                          />
                          <span className="text-sm text-slate-500">days</span>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2 pb-[2px]">
                        {DEDUP_PRESETS.map((preset) => (
                          <button
                            key={preset}
                            type="button"
                            onClick={() => handleDedupDaysChange(preset)}
                            className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${
                              dedupDays === preset
                                ? 'border-indigo-400 bg-indigo-100 text-indigo-800'
                                : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                            }`}
                          >
                            {preset}d
                          </button>
                        ))}
                      </div>
                    </div>
                    {dedupDays > DEDUP_SLIDER_MAX && (
                      <p className="text-xs text-slate-500">
                        Values above {DEDUP_SLIDER_MAX} days: use the number field (max 3650).
                      </p>
                    )}
                  </div>
                )}

                <div className="mt-4">
                  <button
                    type="button"
                    onClick={() => void handleSaveDedup()}
                    disabled={!dedupSaveEnabled || dedupSaving}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {dedupSaving ? 'Saving…' : 'Save check cycle'}
                  </button>
                </div>

                {dedupSaveMsg && <SectionMessage ok={dedupSaveOk} text={dedupSaveMsg} />}
              </div>
            </div>
          </section>

          </div>

          <div className="grid gap-5 xl:grid-cols-2 items-stretch">
          {/* Résumé template */}
          <ResumeTemplateSection />

          {/* Resume tailoring prompt */}
          <section className="flex h-full flex-col rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex min-h-0 flex-1 items-start gap-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 to-indigo-600 text-white">
                <FileText className="h-5 w-5" />
              </div>
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-lg font-bold text-slate-900">Resume tailoring prompt</h2>
                  <ModeToggle
                    value={promptMode}
                    onChange={handlePromptModeChange}
                    disabled={promptSaving}
                  />
                </div>
                <p className="mt-1 text-sm leading-relaxed text-slate-600">
                  Controls how AI writes tailored resume content and cover letter bodies during job analysis.
                </p>

                {promptMode === 'default' ? (
                  <div className="mt-4 flex flex-1 flex-col space-y-3">
                    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700">
                      Using the built-in resume tailoring instructions.
                    </div>
                    <div className="flex min-h-0 flex-1 flex-col">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Built-in instructions
                      </p>
                      <div className="mt-2 min-h-0 flex-1">
                        <MarkdownPromptPreview
                          value={defaultPromptInstructions}
                          className="h-full"
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="mt-4 space-y-3">
                    <div>
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <label htmlFor="resume-tailoring-prompt" className="text-xs font-semibold text-slate-700">
                          Custom instructions (Markdown)
                        </label>
                        <span
                          className={`text-xs tabular-nums ${
                            promptValidLength ? 'text-slate-500' : 'text-rose-600'
                          }`}
                        >
                          {promptTrimmed.length.toLocaleString()} / {promptMaxLength.toLocaleString()}
                        </span>
                      </div>
                      <MarkdownPromptEditor
                        id="resume-tailoring-prompt"
                        value={safePromptText}
                        maxLength={promptMaxLength}
                        disabled={promptSaving}
                        onChange={(next) => {
                          setPromptText(next);
                          setPromptSaveMsg('');
                        }}
                      />
                      {!promptValidLength && promptTrimmed.length > 0 && (
                        <p className="mt-2 text-xs text-rose-600">
                          Prompt must be between {RESUME_TAILORING_PROMPT_MIN_LENGTH} and{' '}
                          {promptMaxLength.toLocaleString()} characters.
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={handleResetPrompt}
                      disabled={promptSaving}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Reset to built-in default
                    </button>
                  </div>
                )}

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleSavePrompt()}
                    disabled={!promptSaveEnabled || promptSaving}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {promptSaving ? 'Saving…' : 'Save resume prompt'}
                  </button>
                </div>

                {promptMode === 'custom' && (
                  <p className="mt-2 text-xs text-slate-500">
                    Changes apply to future tailored resume and cover letter generations. Rerun a job to regenerate documents.
                  </p>
                )}

                {promptSaveMsg && <SectionMessage ok={promptSaveOk} text={promptSaveMsg} />}
              </div>
            </div>
          </section>
          </div>
        </div>
      )}
      </div>
    </PageScrollArea>
  );
}
