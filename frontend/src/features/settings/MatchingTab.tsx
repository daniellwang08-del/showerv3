import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileText, Loader2, Search, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { SectionCard } from '@/components/app/PageLayout';
import { SaveBar } from '@/components/app/SaveBar';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Field, FieldContent, FieldDescription, FieldLabel, FieldTitle } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import {
  applyDedupRules,
  applyMinMatchScore,
  previewDedupRules,
  previewMinMatchScore,
  saveAutoPrepareSettings,
  saveDedupSettings,
  saveApplicationResumeSource,
  saveManualSubmitPipelineSettings,
  saveMatchQualityCheckSettings,
  saveMinMatchScoreSettings,
  uploadOriginalResume,
  type DedupRulesPreview,
  type MinMatchScoreDraft,
  type MinMatchScorePreview,
} from '@/api/settingsApi';
import type { ApplicationResumeSource, MatchQualityCheckMode, SettingsMode, UserSettings } from '@/types/settings';
import { extractApiErrorMessage } from '@/utils/profileErrors';
import { ModeToggle, SettingRow, StatTiles } from './controls';
import { RESUME_SOURCE_OPTIONS } from './resumeSourceOptions';
import { ORIGINAL_RESUME_KEY, refreshJobStores, SETTINGS_KEY, useOriginalResumeQuery, useSetSettings } from './queries';
import { useDraft, useReportDirty } from './useDraft';

const DEDUP_SLIDER_MAX = 365;
const DEDUP_MAX = 3650;
const DEDUP_PRESETS = [30, 60, 90, 180] as const;

type Pipeline = UserSettings['manual_submit_pipeline'];

const PIPELINE_OPTIONS: { value: Pipeline; label: string; hint: string }[] = [
  { value: 'extract', label: 'Extraction only', hint: 'Fetch the job description. Run matching and tailoring yourself later.' },
  { value: 'match', label: 'Up to analysis', hint: 'Extract and score the match. Skip the tailored resume and cover letter.' },
  { value: 'full', label: 'Full pipeline', hint: 'Extract, score, and write a tailored resume and cover letter (when allowed).' },
];

const QUALITY_CHECK_OPTIONS: { value: MatchQualityCheckMode; label: string; hint: string }[] = [
  {
    value: 'rescore',
    label: 'When I re-run a job',
    hint: 'Re-running a score asks the AI model to double-check it. Everything else stays on the free engine.',
  },
  {
    value: 'auto',
    label: 'Also for strong new matches',
    hint: 'New jobs that score at or above your threshold are double-checked automatically, plus any job you re-run.',
  },
  {
    value: 'off',
    label: 'Off',
    hint: 'Always use the free engine, even when you re-run a job.',
  },
];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const clampScore = (n: number) => Math.max(0, Math.min(100, Math.round(Number.isFinite(n) ? n : 0)));
const clampDays = (n: number) => Math.max(1, Math.min(DEDUP_MAX, Math.round(Number.isFinite(n) ? n : 1)));
const sliderValue = (v: number | readonly number[]) => (Array.isArray(v) ? v[0] : v) as number;

function previewSummary(p: MinMatchScorePreview) {
  if (p.threshold <= 0) {
    return p.analyzed_visible_count === 0
      ? 'No analyzed jobs in your dashboard yet.'
      : `All ${p.analyzed_visible_count} analyzed jobs are shown (threshold 0).`;
  }
  if (p.would_hide_count === 0) {
    return `None of your ${p.analyzed_visible_count} analyzed dashboard jobs score below ${p.threshold}.`;
  }
  return `${plural(p.would_hide_count, 'analyzed job')} in your dashboard score below ${p.threshold}.`;
}

export function MatchingTab({
  settings,
  active,
  onDirtyChange,
}: {
  settings: UserSettings;
  active: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const setSettings = useSetSettings();
  const saved = {
    minScoreMode: settings.min_match_score_mode,
    minScore: settings.min_match_score_custom,
    dedupDays: settings.dedup_recycle_days,
    appliedEnabled: settings.dedup_applied_company_enabled,
    scoreCmpEnabled: settings.dedup_score_comparison_enabled,
  };
  const { values, set, clear } = useDraft(saved);
  const [saving, setSaving] = useState(false);

  const minScoreDirty =
    values.minScoreMode !== saved.minScoreMode ||
    (values.minScoreMode === 'custom' && values.minScore !== saved.minScore);
  const dedupDirty =
    values.dedupDays !== saved.dedupDays ||
    values.appliedEnabled !== saved.appliedEnabled ||
    values.scoreCmpEnabled !== saved.scoreCmpEnabled;
  const dirty = minScoreDirty || dedupDirty;
  useReportDirty(dirty, onDirtyChange);

  const [scorePreview, setScorePreview] = useState<MinMatchScorePreview | null>(null);
  const [dedupPreview, setDedupPreview] = useState<DedupRulesPreview | null>(null);
  const [confirm, setConfirm] = useState<'min-score' | 'dedup' | null>(null);

  const minScoreBody = (): MinMatchScoreDraft =>
    values.minScoreMode === 'default'
      ? { min_match_score_mode: 'default' }
      : { min_match_score_mode: 'custom', min_match_score: values.minScore };

  const editScore = (patch: Partial<typeof saved>) => {
    set(patch);
    setScorePreview(null);
  };
  const editDedup = (patch: Partial<typeof saved>) => {
    set(patch);
    setDedupPreview(null);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (minScoreDirty) {
        setSettings(await saveMinMatchScoreSettings(minScoreBody()));
        clear(['minScoreMode', 'minScore']);
      }
      if (dedupDirty) {
        setSettings(
          await saveDedupSettings({
            dedup_recycle_mode: 'custom',
            dedup_recycle_days: values.dedupDays,
            dedup_applied_company_mode: 'custom',
            dedup_applied_company_enabled: values.appliedEnabled,
            dedup_score_comparison_mode: 'custom',
            dedup_score_comparison_enabled: values.scoreCmpEnabled,
          }),
        );
        clear(['dedupDays', 'appliedEnabled', 'scoreCmpEnabled']);
        setDedupPreview(null);
      }
      toast.success('Matching preferences saved', {
        description: dedupDirty ? 'Preview or apply duplicate rules to update existing jobs.' : 'New analyses use this threshold automatically.',
      });
    } catch (err) {
      toast.error(extractApiErrorMessage(err, 'Failed to save matching preferences.'));
    } finally {
      setSaving(false);
    }
  };

  const checkScore = useMutation({
    mutationFn: (body: MinMatchScoreDraft) => previewMinMatchScore(body),
    onSuccess: setScorePreview,
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Failed to check jobs.')),
  });
  const applyScore = useMutation({
    mutationFn: (body: MinMatchScoreDraft) => applyMinMatchScore(body),
    onSuccess: (result) => {
      setSettings(result.settings);
      clear(['minScoreMode', 'minScore']);
      setScorePreview(null);
      const parts: string[] = [];
      if (result.hidden > 0) parts.push(`${plural(result.hidden, 'job')} hidden`);
      if (result.restored > 0) parts.push(`${plural(result.restored, 'job')} restored`);
      toast.success(parts.length ? `${parts.join(', ')}.` : 'No jobs needed to change.', {
        description: `Threshold saved at ${result.min_match_score}.`,
      });
      refreshJobStores();
    },
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Failed to hide jobs from dashboard.')),
  });
  const checkDedup = useMutation({
    mutationFn: () => previewDedupRules(),
    onSuccess: setDedupPreview,
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Failed to preview duplicate rules.')),
  });
  const applyDedup = useMutation({
    mutationFn: () => applyDedupRules(),
    onSuccess: (result) => {
      setSettings(result.settings);
      setDedupPreview(null);
      const parts = [
        result.restored ? `restored ${result.restored}` : null,
        result.hidden_applied_company ? `hid ${result.hidden_applied_company} at applied companies` : null,
        result.hidden_score_comparison ? `hid ${result.hidden_score_comparison} lower-scoring` : null,
        result.restored_location_unknown ? `cleared ${result.restored_location_unknown} unknown-location` : null,
      ].filter(Boolean);
      toast.success(parts.length ? `Applied: ${parts.join('; ')}.` : 'Applied. No status changes needed.');
      refreshJobStores();
    },
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Failed to apply duplicate rules.')),
  });

  const scoreBusy = saving || checkScore.isPending || applyScore.isPending;
  const dedupBusy = saving || checkDedup.isPending || applyDedup.isPending;
  const canHide =
    scorePreview !== null &&
    (scorePreview.would_hide_count > 0 || scorePreview.would_restore_count > 0 || minScoreDirty);
  const effectiveThreshold = values.minScoreMode === 'default' ? settings.default_min_match_score : values.minScore;

  return (
    <div className="space-y-6">
      <SectionCard
        title="Minimum match score"
        description="Jobs scoring below this after AI analysis are hidden from your dashboard."
        actions={
          <ModeToggle
            label="Minimum match score mode"
            value={values.minScoreMode}
            disabled={scoreBusy}
            onChange={(mode: SettingsMode) =>
              editScore(
                mode === 'custom'
                  ? { minScoreMode: mode, minScore: values.minScoreMode === 'custom' ? values.minScore : settings.min_match_score }
                  : { minScoreMode: mode },
              )
            }
          />
        }
      >
        <div className="space-y-4">
          {values.minScoreMode === 'default' ? (
            <p className="text-sm text-muted-foreground">
              Using the system default:{' '}
              <span className="font-medium text-foreground tabular-nums">{settings.default_min_match_score}</span>
              {settings.default_min_match_score === 0 ? ' (show all jobs)' : ' and above'}.
            </p>
          ) : (
            <div className="space-y-2">
              <p id="min-score-label" className="text-sm font-medium">
                Threshold
              </p>
              <div className="flex items-center gap-4">
                <Slider
                  aria-labelledby="min-score-label"
                  min={0}
                  max={100}
                  value={[values.minScore]}
                  disabled={scoreBusy}
                  onValueChange={(v) => editScore({ minScore: clampScore(sliderValue(v)) })}
                  className="flex-1"
                />
                <Input
                  type="number"
                  aria-label="Minimum match score"
                  min={0}
                  max={100}
                  value={values.minScore}
                  disabled={scoreBusy}
                  onChange={(e) => editScore({ minScore: clampScore(Number(e.target.value)) })}
                  className="w-20 text-center tabular-nums"
                />
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={scoreBusy}
              onClick={() => checkScore.mutate(minScoreBody())}
            >
              {checkScore.isPending ? <Loader2 className="animate-spin" /> : <Search />}
              Check jobs
            </Button>
            <Button variant="outline" size="sm" disabled={!canHide || scoreBusy} onClick={() => setConfirm('min-score')}>
              {applyScore.isPending ? <Loader2 className="animate-spin" /> : null}
              Hide from dashboard
            </Button>
          </div>

          {scorePreview ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{previewSummary(scorePreview)}</p>
              <StatTiles
                label="Match score preview"
                items={[
                  { label: 'Visible', value: scorePreview.analyzed_visible_count },
                  { label: 'Will hide', value: scorePreview.would_hide_count },
                  { label: 'Hidden', value: scorePreview.already_hidden_count },
                  { label: 'Will restore', value: scorePreview.would_restore_count },
                ]}
              />
            </div>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard
        title="Duplicate handling"
        description="How long companies stay on cooldown, and optional same-company hide rules."
      >
        <div className="space-y-5">
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <p id="dedup-days-label" className="text-sm font-medium">
                Company check cycle
              </p>
              <span className="text-sm text-muted-foreground tabular-nums">{plural(values.dedupDays, 'day')}</span>
            </div>
            <p className="text-sm text-muted-foreground">
              Days before a company you applied to counts as fresh again. Platform default:{' '}
              {plural(settings.default_dedup_recycle_days, 'day')}.
            </p>
            <div className="flex items-center gap-4">
              <Slider
                aria-labelledby="dedup-days-label"
                min={1}
                max={DEDUP_SLIDER_MAX}
                value={[Math.min(values.dedupDays, DEDUP_SLIDER_MAX)]}
                disabled={dedupBusy}
                onValueChange={(v) => editDedup({ dedupDays: clampDays(sliderValue(v)) })}
                className="flex-1"
              />
              <Input
                type="number"
                aria-label="Company check cycle (days)"
                min={1}
                max={DEDUP_MAX}
                value={values.dedupDays}
                disabled={dedupBusy}
                onChange={(e) => editDedup({ dedupDays: clampDays(Number(e.target.value)) })}
                className="w-20 text-center tabular-nums"
              />
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Cycle presets">
              {DEDUP_PRESETS.map((preset) => (
                <Button
                  key={preset}
                  variant={values.dedupDays === preset ? 'secondary' : 'ghost'}
                  size="xs"
                  aria-pressed={values.dedupDays === preset}
                  disabled={dedupBusy}
                  onClick={() => editDedup({ dedupDays: preset })}
                  className="tabular-nums"
                >
                  {preset} days
                </Button>
              ))}
            </div>
          </div>

          <Separator />
          <SettingRow
            id="dedup-applied"
            title="Hide applied companies"
            description="Hide jobs at companies you applied to within the check cycle."
          >
            <Switch
              aria-labelledby="dedup-applied-label"
              aria-describedby="dedup-applied-desc"
              checked={values.appliedEnabled}
              disabled={dedupBusy}
              onCheckedChange={(checked) => editDedup({ appliedEnabled: checked })}
            />
          </SettingRow>
          <SettingRow
            id="dedup-score"
            title="Score comparison"
            description="At the same company, keep only the higher-scoring job."
          >
            <Switch
              aria-labelledby="dedup-score-label"
              aria-describedby="dedup-score-desc"
              checked={values.scoreCmpEnabled}
              disabled={dedupBusy}
              onCheckedChange={(checked) => editDedup({ scoreCmpEnabled: checked })}
            />
          </SettingRow>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" disabled={dedupBusy || dedupDirty} onClick={() => checkDedup.mutate()}>
                {checkDedup.isPending ? <Loader2 className="animate-spin" /> : <Search />}
                Preview
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={dedupBusy || dedupDirty || !dedupPreview}
                onClick={() => setConfirm('dedup')}
              >
                {applyDedup.isPending ? <Loader2 className="animate-spin" /> : null}
                Apply to existing jobs
              </Button>
              {dedupDirty ? <span className="text-xs text-muted-foreground">Save changes first to preview.</span> : null}
            </div>
            {dedupPreview ? (
              <StatTiles
                label="Duplicate rules preview"
                items={[
                  { label: 'Will restore', value: dedupPreview.would_restore_count },
                  { label: 'Hide (applied)', value: dedupPreview.would_hide_applied_company_count },
                  { label: 'Hide (lower score)', value: dedupPreview.would_hide_score_comparison_count },
                ]}
              />
            ) : null}
          </div>
        </div>
      </SectionCard>

      <AutomationSection settings={settings} />

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === 'dedup' ? 'Apply duplicate rules to existing jobs?' : 'Hide low-scoring jobs?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === 'dedup'
                ? dedupPreview
                  ? `This hides ${dedupPreview.would_hide_applied_company_count + dedupPreview.would_hide_score_comparison_count} and restores ${dedupPreview.would_restore_count} jobs on your dashboard.`
                  : 'This updates which jobs are hidden on your dashboard.'
                : scorePreview
                  ? `Jobs scoring below ${effectiveThreshold} will be hidden (${scorePreview.would_hide_count}) and ${scorePreview.would_restore_count} restored. This also saves the threshold.`
                  : 'This updates which jobs are hidden on your dashboard.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirm === 'dedup') applyDedup.mutate();
                else applyScore.mutate(minScoreBody());
                setConfirm(null);
              }}
            >
              {confirm === 'dedup' ? 'Apply' : 'Hide jobs'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <SaveBar
        dirty={dirty && active}
        saving={saving}
        onSave={() => void handleSave()}
        onDiscard={() => {
          clear();
          setScorePreview(null);
          setDedupPreview(null);
        }}
      />
    </div>
  );
}

/** Saves one settings patch immediately, showing it optimistically and rolling back on error. */
function useImmediateSetting<T extends Partial<UserSettings>>(
  save: (body: T) => Promise<UserSettings>,
  successMessage: (body: T, previous: UserSettings | undefined) => string,
  errorMessage: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: T) => save(body),
    onMutate: async (body: T) => {
      await queryClient.cancelQueries({ queryKey: SETTINGS_KEY });
      const previous = queryClient.getQueryData<UserSettings>(SETTINGS_KEY);
      if (previous) queryClient.setQueryData(SETTINGS_KEY, { ...previous, ...body });
      return { previous };
    },
    onError: (err, _body, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(SETTINGS_KEY, ctx.previous);
      toast.error(extractApiErrorMessage(err, errorMessage));
    },
    onSuccess: (data, body, ctx) => {
      queryClient.setQueryData(SETTINGS_KEY, data);
      toast.success(successMessage(body, ctx?.previous));
    },
  });
}

const formatBytes = (n: number) => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** The imported resume file that original mode uploads unchanged, with a way to replace it. */
function OriginalResumeFileRow({ required }: { required: boolean }) {
  const queryClient = useQueryClient();
  const file = useOriginalResumeQuery();
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: (picked: File) => uploadOriginalResume(picked),
    onSuccess: (data) => {
      queryClient.setQueryData(ORIGINAL_RESUME_KEY, data);
      toast.success(`Saved ${data.filename}. Applications upload it as is.`);
    },
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Could not save that file. Upload a PDF or DOCX.')),
  });
  const current = file.data;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2.5">
      <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1 text-sm">
        {file.isLoading ? (
          <span className="text-muted-foreground">Checking your resume file…</span>
        ) : current ? (
          <>
            <p className="truncate font-medium">{current.filename}</p>
            <p className="text-xs text-muted-foreground">
              {current.kind === 'docx' ? 'Word file' : 'PDF'}, {formatBytes(current.byte_size)}. Uploaded to applications
              exactly as imported.
            </p>
          </>
        ) : (
          <>
            <p className="font-medium">No resume file on record</p>
            <p className={required ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
              {required
                ? 'Add the resume you want employers to receive. Until then, applications get a copy rendered from your profile.'
                : 'Add your resume file so applications can use it before a tailored resume is built.'}
            </p>
          </>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        className="sr-only"
        aria-label="Resume file for applications"
        onChange={(e) => {
          const picked = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (picked) upload.mutate(picked);
        }}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={upload.isPending}
        onClick={() => inputRef.current?.click()}
      >
        {upload.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
        {current ? 'Replace file' : 'Add resume file'}
      </Button>
    </div>
  );
}

function AutomationSection({ settings }: { settings: UserSettings }) {
  const autoPrepare = useImmediateSetting(
    saveAutoPrepareSettings,
    (body, prev) =>
      (body.auto_prepare_match && !prev?.auto_prepare_match) || (body.auto_prepare_full && !prev?.auto_prepare_full)
        ? 'Saved. Preparing existing jobs with a ready description in the background…'
        : 'Auto-prepare preference saved.',
    'Failed to save auto-prepare settings.',
  );
  const pipeline = useImmediateSetting(
    saveManualSubmitPipelineSettings,
    () => 'Saved how pasted job links are processed.',
    'Failed to save submit pipeline.',
  );
  const resumeSource = useImmediateSetting(
    saveApplicationResumeSource,
    (body) =>
      body.application_resume_source === 'original'
        ? 'Saved. Jobs get a cover letter, and applications use your original resume file.'
        : 'Saved. Jobs you score from now on get a tailored resume and cover letter.',
    'Failed to save the resume for applications.',
  );

  const match = settings.auto_prepare_match;
  const full = settings.auto_prepare_full;
  const original = settings.application_resume_source === 'original';

  return (
    <>
      <SectionCard
        title="Resume for applications"
        description="Choose what NAO prepares after scoring a job, and which resume the extension uploads and fills applications from."
      >
        <RadioGroup
          aria-label="Resume for applications"
          value={settings.application_resume_source}
          disabled={resumeSource.isPending}
          onValueChange={(value) => {
            if (value !== settings.application_resume_source) {
              resumeSource.mutate({ application_resume_source: value as ApplicationResumeSource });
            }
          }}
        >
          {RESUME_SOURCE_OPTIONS.map((opt) => (
            <FieldLabel key={opt.value} htmlFor={`resume-source-${opt.value}`}>
              <Field orientation="horizontal">
                <RadioGroupItem
                  value={opt.value}
                  id={`resume-source-${opt.value}`}
                  aria-labelledby={`resume-source-${opt.value}-title`}
                  aria-describedby={`resume-source-${opt.value}-hint`}
                />
                <FieldContent>
                  <FieldTitle id={`resume-source-${opt.value}-title`}>{opt.label}</FieldTitle>
                  <FieldDescription id={`resume-source-${opt.value}-hint`}>{opt.hint}</FieldDescription>
                </FieldContent>
              </Field>
            </FieldLabel>
          ))}
        </RadioGroup>
        <p className="mt-3 text-xs text-muted-foreground">
          {original
            ? 'Jobs prepared before you switched keep their documents until you build again from the job.'
            : 'Jobs scored before you switched keep their original resume until you build one from the job, or turn on Prepare documents automatically below.'}
        </p>
        <OriginalResumeFileRow required={original} />
      </SectionCard>

      <SectionCard
        title="Auto-prepare"
        description="When a job description is already available, prepare new jobs for you in the background. Scoring is on for new accounts."
      >
        <div className="space-y-4">
          <SettingRow
            id="auto-match"
            title="Score new jobs automatically"
            description="Scoring uses the free built-in engine, so new and shared jobs arrive scored, and any you missed are caught up when you open Jobs."
          >
            <Switch
              aria-labelledby="auto-match-label"
              aria-describedby="auto-match-desc"
              checked={match}
              disabled={autoPrepare.isPending}
              onCheckedChange={(next) => autoPrepare.mutate({ auto_prepare_match: next, auto_prepare_full: next ? full : false })}
            />
          </SettingRow>
          <Separator />
          <SettingRow
            id="auto-full"
            title="Prepare documents automatically"
            description={
              original
                ? 'Score plus a cover letter, so jobs are ready to apply with your original resume. Turns on scoring too.'
                : 'Score plus a tailored resume and cover letter, so jobs are ready to apply. Turns on scoring too.'
            }
          >
            <Switch
              aria-labelledby="auto-full-label"
              aria-describedby="auto-full-desc"
              checked={full}
              disabled={autoPrepare.isPending}
              onCheckedChange={(next) => autoPrepare.mutate({ auto_prepare_match: next ? true : match, auto_prepare_full: next })}
            />
          </SettingRow>
        </div>
      </SectionCard>

      <QualityCheckSection settings={settings} />

      <SectionCard
        title="When you paste job links"
        description="How far the pipeline runs after you add a job URL, in the app or the extension."
      >
        <RadioGroup
          aria-label="When you paste job links"
          value={settings.manual_submit_pipeline}
          disabled={pipeline.isPending}
          onValueChange={(value) => {
            if (value !== settings.manual_submit_pipeline) {
              pipeline.mutate({ manual_submit_pipeline: value as Pipeline });
            }
          }}
        >
          {PIPELINE_OPTIONS.map((opt) => (
            <FieldLabel key={opt.value} htmlFor={`pipeline-${opt.value}`}>
              <Field orientation="horizontal">
                <RadioGroupItem
                  value={opt.value}
                  id={`pipeline-${opt.value}`}
                  aria-labelledby={`pipeline-${opt.value}-title`}
                  aria-describedby={`pipeline-${opt.value}-hint`}
                />
                <FieldContent>
                  <FieldTitle id={`pipeline-${opt.value}-title`}>{opt.label}</FieldTitle>
                  <FieldDescription id={`pipeline-${opt.value}-hint`}>
                    {original && opt.value === 'full'
                      ? 'Extract, score, and write a cover letter. Your original resume is used as is.'
                      : original && opt.value === 'match'
                        ? 'Extract and score the match. Skip the cover letter.'
                        : opt.hint}
                  </FieldDescription>
                </FieldContent>
              </Field>
            </FieldLabel>
          ))}
        </RadioGroup>
      </SectionCard>
    </>
  );
}

function QualityCheckSection({ settings }: { settings: UserSettings }) {
  const save = useImmediateSetting(
    saveMatchQualityCheckSettings,
    (body) =>
      body.match_quality_check === 'off'
        ? 'Saved. Scores always come from the free engine.'
        : body.match_quality_check === 'auto'
          ? 'Saved. Strong new matches and re-runs get the AI check.'
          : body.match_quality_check === 'rescore'
            ? 'Saved. Re-running a job gets the AI check.'
            : 'Saved the AI check threshold.',
    'Failed to save the AI check setting.',
  );
  const mode = settings.match_quality_check;
  const [threshold, setThreshold] = useState(String(settings.match_quality_check_min_score));
  const [lastSaved, setLastSaved] = useState(settings.match_quality_check_min_score);
  if (lastSaved !== settings.match_quality_check_min_score) {
    setLastSaved(settings.match_quality_check_min_score);
    setThreshold(String(settings.match_quality_check_min_score));
  }

  const commitThreshold = () => {
    const next = clampScore(Number(threshold));
    setThreshold(String(next));
    if (next !== settings.match_quality_check_min_score) {
      save.mutate({ match_quality_check_min_score: next });
    }
  };

  return (
    <SectionCard
      title="AI quality check"
      description="Free scores come from NAO's built-in engine. An AI model (GPT-5.6 Luna) can double-check a score: it rewrites the explanation and fills job details the posting left out, like salary or work mode. Each check uses your AI credits and is capped per day."
    >
      <RadioGroup
        aria-label="AI quality check"
        value={mode}
        disabled={save.isPending}
        onValueChange={(value) => {
          if (value !== mode) save.mutate({ match_quality_check: value as MatchQualityCheckMode });
        }}
      >
        {QUALITY_CHECK_OPTIONS.map((opt) => (
          <FieldLabel key={opt.value} htmlFor={`quality-check-${opt.value}`}>
            <Field orientation="horizontal">
              <RadioGroupItem
                value={opt.value}
                id={`quality-check-${opt.value}`}
                aria-labelledby={`quality-check-${opt.value}-title`}
                aria-describedby={`quality-check-${opt.value}-hint`}
              />
              <FieldContent>
                <FieldTitle id={`quality-check-${opt.value}-title`}>{opt.label}</FieldTitle>
                <FieldDescription id={`quality-check-${opt.value}-hint`}>{opt.hint}</FieldDescription>
              </FieldContent>
            </Field>
          </FieldLabel>
        ))}
      </RadioGroup>
      {mode === 'auto' ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <label htmlFor="quality-check-threshold" className="text-sm font-medium">
            Check new matches scoring at least
          </label>
          <Input
            id="quality-check-threshold"
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            className="w-20"
            value={threshold}
            disabled={save.isPending}
            onChange={(e) => setThreshold(e.target.value)}
            onBlur={commitThreshold}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitThreshold();
            }}
          />
          <span className="text-sm text-muted-foreground">out of 100</span>
        </div>
      ) : null}
    </SectionCard>
  );
}
