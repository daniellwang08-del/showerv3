import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  FileText,
  Loader2,
  Mail,
  RefreshCw,
  Search,
  Target,
  UserCog,
} from 'lucide-react';
import {
  fetchUserSettings,
  saveDedupSettings,
  saveMinMatchScoreSettings,
  saveResumeTailoringPromptSettings,
  saveCoverLetterPromptSettings,
  saveJobMatchPreferences,
  fetchCoverLetterPromptDefaults,
  previewMinMatchScore,
  applyMinMatchScore,
  type MinMatchScorePreview,
} from '../api/settingsApi';
import type { SettingsMode, UserSettings } from '../types/settings';
import { RESUME_TAILORING_PROMPT_MIN_LENGTH, COVER_LETTER_PROMPT_MIN_LENGTH } from '../types/settings';
import {
  BUILTIN_COVER_LETTER_PROMPT_INSTRUCTIONS,
  BUILTIN_COVER_LETTER_PROMPT_MAX_LENGTH,
} from '../constants/builtinCoverLetterPrompt';
import { MarkdownPromptEditor } from '../components/settings/MarkdownPromptEditor';
import { JobSyncSettingsSection } from '../components/settings/JobSyncSettingsSection';
import { ProviderKeysCard } from '../components/settings/ProviderKeysCard';
import { SettingsCard } from '../components/settings/SettingsCard';
import { prefsSaveBtnClass } from '../components/settings/prefsSaveButtonClass';
import { EeoPreferencesSection } from '../components/preferences/EeoPreferencesSection';
import { AddressPreferencesSection } from '../components/preferences/AddressPreferencesSection';
import { PageScrollArea } from '../components/layout/PageScrollArea';
import { PageHeader } from '../components/layout/PageHeader';
import { BrandedLoader } from '../components/layout/BrandedLoader';
import type { AppShellOutletContext } from '../components/layout/AppShell';
import { useJobsStore } from '../stores/jobsStore';
import { useScraperStore } from '../stores/scraperStore';
import { useOutletContext } from 'react-router-dom';

const DEDUP_SLIDER_MAX = 365;
const DEDUP_PRESETS = [30, 60, 90, 180] as const;
function resolveStoredPromptText(data: Pick<UserSettings, 'resume_tailoring_prompt_instructions_custom' | 'default_resume_tailoring_prompt_instructions'>) {
  return (
    data.resume_tailoring_prompt_instructions_custom ||
    data.default_resume_tailoring_prompt_instructions ||
    ''
  );
}

function resolveStoredCoverLetterPromptText(
  data: Pick<UserSettings, 'cover_letter_prompt_instructions_custom' | 'default_cover_letter_prompt_instructions'>,
) {
  return (
    data.cover_letter_prompt_instructions_custom ||
    data.default_cover_letter_prompt_instructions ||
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
    <div className="inline-flex max-w-full flex-wrap rounded-lg border border-slate-200 bg-slate-50 p-0.5">
      {(['default', 'custom'] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          disabled={disabled}
          onClick={() => onChange(mode)}
          className={[
            'rounded-md px-2.5 py-1.5 text-xs font-semibold capitalize transition sm:px-3',
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

export function MyPreferencesPage() {
  const { isAdmin } = useOutletContext<AppShellOutletContext>();
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

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

  // Cover letter prompt section state
  const [coverPromptMode, setCoverPromptMode] = useState<SettingsMode>('default');
  const [coverPromptText, setCoverPromptText] = useState('');
  const [coverPromptSaving, setCoverPromptSaving] = useState(false);
  const [coverPromptSaveMsg, setCoverPromptSaveMsg] = useState('');
  const [coverPromptSaveOk, setCoverPromptSaveOk] = useState(false);
  const [coverPromptDefaults, setCoverPromptDefaults] = useState(BUILTIN_COVER_LETTER_PROMPT_INSTRUCTIONS);

  // Job match preferences (Phase A scoring input)
  const [matchPreferences, setMatchPreferences] = useState('');
  const [matchPreferencesSaving, setMatchPreferencesSaving] = useState(false);
  const [matchPreferencesSaveMsg, setMatchPreferencesSaveMsg] = useState('');
  const [matchPreferencesSaveOk, setMatchPreferencesSaveOk] = useState(false);

  const applySettings = useCallback((data: UserSettings) => {
    setSettings(data);
    setDedupMode(data.dedup_recycle_mode);
    setDedupDays(data.dedup_recycle_days_custom);
    setMinScoreMode(data.min_match_score_mode);
    setMinScore(data.min_match_score_custom);
    setPromptMode(data.resume_tailoring_prompt_mode ?? 'default');
    setPromptText(resolveStoredPromptText(data));
    setCoverPromptMode(data.cover_letter_prompt_mode ?? 'default');
    setCoverPromptText(resolveStoredCoverLetterPromptText(data));
    setMatchPreferences(data.job_match_preferences ?? '');
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
    const fromSettings =
      settings?.default_cover_letter_prompt_instructions?.trim() ||
      settings?.cover_letter_prompt_instructions?.trim() ||
      '';
    if (fromSettings) {
      setCoverPromptDefaults(fromSettings);
      return;
    }
    if (!settings) return;
    void fetchCoverLetterPromptDefaults()
      .then((data) => {
        setCoverPromptDefaults(data.default_instructions.trim() || BUILTIN_COVER_LETTER_PROMPT_INSTRUCTIONS);
      })
      .catch(() => setCoverPromptDefaults(BUILTIN_COVER_LETTER_PROMPT_INSTRUCTIONS));
  }, [settings]);

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

  useEffect(() => {
    if (!coverPromptSaveOk) return;
    const t = window.setTimeout(() => setCoverPromptSaveOk(false), 3000);
    return () => window.clearTimeout(t);
  }, [coverPromptSaveOk]);

  useEffect(() => {
    if (!matchPreferencesSaveOk) return;
    const t = window.setTimeout(() => setMatchPreferencesSaveOk(false), 3000);
    return () => window.clearTimeout(t);
  }, [matchPreferencesSaveOk]);

  const defaultDedup = settings?.default_dedup_recycle_days ?? 60;
  const defaultMinScore = settings?.default_min_match_score ?? 0;
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
  const savedCoverPromptMode = settings?.cover_letter_prompt_mode ?? 'default';
  const savedCoverPromptText = resolveStoredCoverLetterPromptText({
    cover_letter_prompt_instructions_custom: settings?.cover_letter_prompt_instructions_custom ?? '',
    default_cover_letter_prompt_instructions: settings?.default_cover_letter_prompt_instructions ?? '',
  });
  const defaultCoverPromptInstructions =
    settings?.default_cover_letter_prompt_instructions?.trim() ||
    coverPromptDefaults ||
    settings?.cover_letter_prompt_instructions?.trim() ||
    BUILTIN_COVER_LETTER_PROMPT_INSTRUCTIONS;
  const coverPromptMaxLength =
    settings?.cover_letter_prompt_max_length ?? BUILTIN_COVER_LETTER_PROMPT_MAX_LENGTH;
  const safeCoverPromptText = coverPromptText ?? '';
  const matchPreferencesMaxLength = settings?.job_match_preferences_max_length ?? 4000;
  const savedMatchPreferences = settings?.job_match_preferences ?? '';
  const matchPreferencesChanged = matchPreferences.trim() !== savedMatchPreferences.trim();

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

  // Persist threshold as soon as mode/value settle — no separate Save button.
  // "Hide from dashboard" still applies the hide/restore pass on top of this.
  useEffect(() => {
    if (!settings || !minScoreChanged) return;
    if (minScoreMode === 'custom' && (minScore < 0 || minScore > 100)) return;

    const timer = window.setTimeout(() => {
      void (async () => {
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
              ? `Threshold saved (system default: ${data.default_min_match_score ?? defaultMinScore}). New analyses use this automatically.`
              : `Threshold saved at ${minScore}. New analyses below this are hidden automatically.`,
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
      })();
    }, 450);

    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: save when draft differs from saved settings
  }, [minScoreMode, minScore, minScoreChanged, settings]);

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

  const coverPromptTrimmed = safeCoverPromptText.trim();
  const savedCoverPromptTextTrimmed = savedCoverPromptText.trim();
  const coverPromptChanged =
    coverPromptMode !== savedCoverPromptMode ||
    (coverPromptMode === 'custom' && coverPromptTrimmed !== savedCoverPromptTextTrimmed);
  const coverPromptValidLength =
    coverPromptTrimmed.length >= COVER_LETTER_PROMPT_MIN_LENGTH &&
    coverPromptTrimmed.length <= coverPromptMaxLength;
  const coverPromptSaveEnabled =
    coverPromptMode === 'default'
      ? savedCoverPromptMode !== 'default'
      : coverPromptChanged && coverPromptValidLength;

  const handleCoverPromptModeChange = (mode: SettingsMode) => {
    setCoverPromptMode(mode);
    setCoverPromptSaveMsg('');
    if (mode === 'custom' && !coverPromptTrimmed) {
      setCoverPromptText(defaultCoverPromptInstructions);
    }
  };

  const handleResetCoverPrompt = () => {
    setCoverPromptText(defaultCoverPromptInstructions);
    setCoverPromptSaveMsg('');
  };

  const handleSaveCoverPrompt = async () => {
    if (!settings || !coverPromptSaveEnabled) return;
    setCoverPromptSaving(true);
    setCoverPromptSaveMsg('');
    try {
      const data =
        coverPromptMode === 'default'
          ? await saveCoverLetterPromptSettings({ cover_letter_prompt_mode: 'default' })
          : await saveCoverLetterPromptSettings({
              cover_letter_prompt_mode: 'custom',
              cover_letter_prompt_custom: coverPromptTrimmed,
            });
      applySettings(data);
      setCoverPromptSaveOk(true);
      setCoverPromptSaveMsg(
        coverPromptMode === 'default'
          ? 'Using the built-in cover letter prompt for new generations.'
          : 'Custom cover letter prompt saved. Rerun jobs to regenerate documents.',
      );
    } catch (err: unknown) {
      setCoverPromptSaveOk(false);
      const msg =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : null;
      setCoverPromptSaveMsg(typeof msg === 'string' ? msg : 'Failed to save cover letter prompt.');
    } finally {
      setCoverPromptSaving(false);
    }
  };

  const handleSaveMatchPreferences = async () => {
    if (!settings || !matchPreferencesChanged) return;
    const trimmed = matchPreferences.trim();
    if (trimmed.length > matchPreferencesMaxLength) return;
    setMatchPreferencesSaving(true);
    setMatchPreferencesSaveMsg('');
    try {
      const data = await saveJobMatchPreferences(
        trimmed
          ? { job_match_preferences: trimmed }
          : { clear_job_match_preferences: true },
      );
      applySettings(data);
      setMatchPreferencesSaveOk(true);
      setMatchPreferencesSaveMsg(
        trimmed
          ? 'Job match preferences saved. Re-run match analysis on jobs to apply the new scoring.'
          : 'Job match preferences cleared.',
      );
    } catch (err: unknown) {
      setMatchPreferencesSaveOk(false);
      const msg =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : null;
      setMatchPreferencesSaveMsg(typeof msg === 'string' ? msg : 'Failed to save job match preferences.');
    } finally {
      setMatchPreferencesSaving(false);
    }
  };

  const sliderValue = Math.min(dedupDays, DEDUP_SLIDER_MAX);

  return (
    <PageScrollArea>
      <div className="w-full space-y-4 px-3 py-4 sm:space-y-5 sm:px-5 sm:py-5">
        <PageHeader
          icon={UserCog}
          gradient="from-slate-700 to-slate-900"
          title="My Preferences"
          description={
            isAdmin
              ? 'API keys, match scoring, prompts, EEO, address, and job sync - your personal defaults.'
              : 'API keys, match scoring, prompts, EEO, and address - your personal defaults.'
          }
        />

        {loading ? (
          <BrandedLoader label="Loading preferences…" className="min-h-[60vh]" />
        ) : loadError ? (
          <p className="text-sm text-rose-700">{loadError}</p>
        ) : (
          <div className="space-y-3 sm:space-y-4">
            <div className="grid items-start gap-3 sm:gap-4 xl:grid-cols-2">
              <EeoPreferencesSection />
              <AddressPreferencesSection />
            </div>

            {settings && <ProviderKeysCard settings={settings} onSaved={applySettings} />}

            <div className="grid items-stretch gap-3 sm:gap-4 xl:grid-cols-2">
              {/* Minimum match score */}
              <SettingsCard
                icon={Target}
                iconClass="bg-gradient-to-br from-rose-500 to-orange-600"
                title="Minimum match score"
                description="Auto-hide jobs scoring below this after AI analysis."
                actions={
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
                }
              >
                {minScoreMode === 'default' ? (
                  <div className="rounded-lg border border-rose-100 bg-rose-50/60 px-3 py-2 text-sm text-rose-900">
                    System default: <strong>{defaultMinScore}</strong>
                    {defaultMinScore === 0 ? ' (show all)' : '+'}
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-center gap-3">
                      <input
                        id="min-score-slider"
                        type="range"
                        min={0}
                        max={100}
                        value={minScore}
                        onChange={(e) => handleMinScoreChange(Number(e.target.value))}
                        className="h-5 flex-1 cursor-pointer accent-rose-600 text-rose-600"
                      />
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={minScore}
                        onChange={(e) => handleMinScoreChange(Number(e.target.value) || 0)}
                        className="w-16 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-center text-sm font-semibold text-slate-800 shadow-sm focus:border-rose-400 focus:outline-none focus:ring-2 focus:ring-rose-200"
                      />
                    </div>
                  </div>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleCheckMinScoreJobs()}
                    disabled={minScoreChecking || minScoreApplying || minScoreSaving}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {minScoreChecking ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                    {minScoreChecking ? 'Checking…' : 'Check jobs'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleHideMinScoreJobs()}
                    disabled={!hideJobsEnabled || minScoreApplying || minScoreChecking || minScoreSaving}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {minScoreApplying ? <Loader2 size={14} className="animate-spin" /> : null}
                    {minScoreApplying ? 'Applying…' : 'Hide from dashboard'}
                  </button>
                  {minScoreSaving ? (
                    <span className="ml-auto inline-flex items-center gap-1.5 text-xs font-medium text-slate-500">
                      <Loader2 size={13} className="animate-spin" />
                      Saving threshold…
                    </span>
                  ) : null}
                </div>

                {minScoreCheckMsg && (
                  <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                    {minScoreCheckMsg}
                  </div>
                )}

                {minScoreCheckResult && (
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {[
                      ['Visible', minScoreCheckResult.analyzed_visible_count],
                      ['Hide', minScoreCheckResult.would_hide_count],
                      ['Hidden', minScoreCheckResult.already_hidden_count],
                      ['Restore', minScoreCheckResult.would_restore_count],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-center">
                        <div className="text-base font-bold tabular-nums text-slate-900">{value}</div>
                        <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">{label}</div>
                      </div>
                    ))}
                  </div>
                )}

                {minScoreSaveMsg && <SectionMessage ok={minScoreSaveOk} text={minScoreSaveMsg} />}
              </SettingsCard>

              {/* Company check cycle */}
              <SettingsCard
                icon={RefreshCw}
                iconClass="bg-gradient-to-br from-indigo-500 to-purple-600"
                title="Company check cycle"
                description="Days before a repeat posting counts as fresh."
                actions={
                  <ModeToggle
                    value={dedupMode}
                    onChange={(m) => {
                      setDedupMode(m);
                      setDedupSaveMsg('');
                    }}
                    disabled={dedupSaving}
                  />
                }
              >
                {dedupMode === 'default' ? (
                  <div className="rounded-lg border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-sm text-indigo-900">
                    System default: <strong>{defaultDedup} days</strong>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-center gap-3">
                      <input
                        id="dedup-slider"
                        type="range"
                        min={1}
                        max={DEDUP_SLIDER_MAX}
                        value={sliderValue}
                        onChange={(e) => handleDedupDaysChange(Number(e.target.value))}
                        className="h-5 flex-1 cursor-pointer accent-indigo-600 text-indigo-600"
                      />
                      <input
                        type="number"
                        min={1}
                        max={3650}
                        value={dedupDays}
                        onChange={(e) => handleDedupDaysChange(Number(e.target.value) || 1)}
                        className="w-16 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-center text-sm font-semibold text-slate-800 shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200"
                      />
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {DEDUP_PRESETS.map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => handleDedupDaysChange(preset)}
                          className={`rounded-md border px-2.5 py-1 text-xs font-semibold transition ${
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
                )}

                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleSaveDedup()}
                    disabled={!dedupSaveEnabled || dedupSaving}
                    className={`ml-auto ${prefsSaveBtnClass(dedupSaveEnabled)}`}
                  >
                    {dedupSaving ? 'Saving…' : 'Save'}
                  </button>
                </div>

                {dedupSaveMsg && <SectionMessage ok={dedupSaveOk} text={dedupSaveMsg} />}
              </SettingsCard>
            </div>

            <SettingsCard
              icon={Target}
              iconClass="bg-gradient-to-br from-violet-500 to-fuchsia-600"
              title="Job match preferences"
              description="Tell the AI what kinds of roles you want. This feeds the User Preferences dimension (15% of match score) during analysis."
            >
              <div className="space-y-2.5">
                <p className="text-xs text-slate-600">
                  Examples: preferred work mode (remote only), target titles, industries, salary range,
                  company size, tech stack, locations, or roles to avoid.
                </p>
                <div className="flex items-center justify-between">
                  <span
                    className={`text-xs tabular-nums ${
                      matchPreferences.trim().length <= matchPreferencesMaxLength
                        ? 'text-slate-400'
                        : 'text-rose-600'
                    }`}
                  >
                    {matchPreferences.trim().length.toLocaleString()} / {matchPreferencesMaxLength.toLocaleString()}
                  </span>
                </div>
                <textarea
                  id="job-match-preferences"
                  value={matchPreferences}
                  maxLength={matchPreferencesMaxLength}
                  disabled={matchPreferencesSaving}
                  onChange={(e) => {
                    setMatchPreferences(e.target.value);
                    setMatchPreferencesSaveMsg('');
                  }}
                  rows={6}
                  placeholder={`e.g.\n- Remote only (US time zones)\n- Senior backend / platform engineer roles\n- Prefer fintech, developer tools, or infra startups\n- Target compensation $160k+\n- Avoid roles requiring security clearance`}
                  className="w-full resize-y rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 shadow-sm focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-200 disabled:opacity-60"
                />
              </div>
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleSaveMatchPreferences()}
                  disabled={
                    !matchPreferencesChanged ||
                    matchPreferencesSaving ||
                    matchPreferences.trim().length > matchPreferencesMaxLength
                  }
                  className={`ml-auto ${prefsSaveBtnClass(
                    matchPreferencesChanged &&
                      matchPreferences.trim().length <= matchPreferencesMaxLength
                  )}`}
                >
                  {matchPreferencesSaving ? 'Saving…' : 'Save preferences'}
                </button>
              </div>
              {matchPreferencesSaveMsg && (
                <SectionMessage ok={matchPreferencesSaveOk} text={matchPreferencesSaveMsg} />
              )}
            </SettingsCard>

            <div className="grid items-start gap-3 sm:gap-4 xl:grid-cols-2">
              {/* Resume tailoring prompt */}
              <SettingsCard
                icon={FileText}
                iconClass="bg-gradient-to-br from-blue-500 to-indigo-600"
                title="Resume tailoring prompt"
                description="How AI writes tailored resume content."
                actions={<ModeToggle value={promptMode} onChange={handlePromptModeChange} disabled={promptSaving} />}
              >
                {promptMode === 'default' ? (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                    Using built-in instructions. Switch to <span className="font-semibold text-slate-700">Custom</span> to edit.
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className={`text-xs tabular-nums ${promptValidLength ? 'text-slate-400' : 'text-rose-600'}`}>
                        {promptTrimmed.length.toLocaleString()} / {promptMaxLength.toLocaleString()}
                      </span>
                      <button
                        type="button"
                        onClick={handleResetPrompt}
                        disabled={promptSaving}
                        className="text-xs font-semibold text-slate-500 transition hover:text-slate-800 disabled:opacity-50"
                      >
                        Reset to default
                      </button>
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
                      <p className="text-xs text-rose-600">
                        Must be {RESUME_TAILORING_PROMPT_MIN_LENGTH}–{promptMaxLength.toLocaleString()} characters.
                      </p>
                    )}
                  </div>
                )}

                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleSavePrompt()}
                    disabled={!promptSaveEnabled || promptSaving}
                    className={`ml-auto ${prefsSaveBtnClass(promptSaveEnabled)}`}
                  >
                    {promptSaving ? 'Saving…' : 'Save'}
                  </button>
                </div>

                {promptSaveMsg && <SectionMessage ok={promptSaveOk} text={promptSaveMsg} />}
              </SettingsCard>

              {/* Cover letter prompt */}
              <SettingsCard
                icon={Mail}
                iconClass="bg-gradient-to-br from-violet-500 to-purple-600"
                title="Cover letter prompt"
                description="How AI writes the cover letter body."
                actions={<ModeToggle value={coverPromptMode} onChange={handleCoverPromptModeChange} disabled={coverPromptSaving} />}
              >
                {coverPromptMode === 'default' ? (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                    Using built-in instructions. Switch to <span className="font-semibold text-slate-700">Custom</span> to edit.
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className={`text-xs tabular-nums ${coverPromptValidLength ? 'text-slate-400' : 'text-rose-600'}`}>
                        {coverPromptTrimmed.length.toLocaleString()} / {coverPromptMaxLength.toLocaleString()}
                      </span>
                      <button
                        type="button"
                        onClick={handleResetCoverPrompt}
                        disabled={coverPromptSaving}
                        className="text-xs font-semibold text-slate-500 transition hover:text-slate-800 disabled:opacity-50"
                      >
                        Reset to default
                      </button>
                    </div>
                    <MarkdownPromptEditor
                      id="cover-letter-prompt"
                      value={safeCoverPromptText}
                      maxLength={coverPromptMaxLength}
                      disabled={coverPromptSaving}
                      onChange={(next) => {
                        setCoverPromptText(next);
                        setCoverPromptSaveMsg('');
                      }}
                    />
                    {!coverPromptValidLength && coverPromptTrimmed.length > 0 && (
                      <p className="text-xs text-rose-600">
                        Must be {COVER_LETTER_PROMPT_MIN_LENGTH}–{coverPromptMaxLength.toLocaleString()} characters.
                      </p>
                    )}
                  </div>
                )}

                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleSaveCoverPrompt()}
                    disabled={!coverPromptSaveEnabled || coverPromptSaving}
                    className={`ml-auto ${prefsSaveBtnClass(coverPromptSaveEnabled)}`}
                  >
                    {coverPromptSaving ? 'Saving…' : 'Save'}
                  </button>
                </div>

                {coverPromptSaveMsg && <SectionMessage ok={coverPromptSaveOk} text={coverPromptSaveMsg} />}
              </SettingsCard>
            </div>

            {isAdmin && <JobSyncSettingsSection />}
          </div>
        )}
      </div>
    </PageScrollArea>
  );
}
