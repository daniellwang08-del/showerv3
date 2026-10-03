import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Info, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { SectionCard } from '@/components/app/PageLayout';
import { SaveBar } from '@/components/app/SaveBar';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/field';
import { cn } from '@/lib/utils';
import {
  fetchCoverLetterPromptDefaults,
  saveCoverLetterPromptSettings,
  saveResumeTailoringPromptSettings,
} from '@/api/settingsApi';
import {
  COVER_LETTER_PROMPT_MIN_LENGTH,
  RESUME_TAILORING_PROMPT_MIN_LENGTH,
  type SettingsMode,
  type UserSettings,
} from '@/types/settings';
import {
  BUILTIN_COVER_LETTER_PROMPT_INSTRUCTIONS,
  BUILTIN_COVER_LETTER_PROMPT_MAX_LENGTH,
} from '@/constants/builtinCoverLetterPrompt';
import { extractApiErrorMessage } from '@/utils/profileErrors';
import { ModeToggle } from './controls';
import { PromptEditor } from './PromptEditor';
import { useSetSettings } from './queries';
import { useDraft, useReportDirty } from './useDraft';

type PromptState = { mode: SettingsMode; text: string };

function promptStatus(value: PromptState, saved: PromptState, min: number, max: number) {
  const length = value.text.trim().length;
  const dirty = value.mode !== saved.mode || (value.mode === 'custom' && value.text.trim() !== saved.text.trim());
  const valid = value.mode === 'default' || (length >= min && length <= max);
  return { length, dirty, valid };
}

export function PromptsTab({
  settings,
  active,
  onDirtyChange,
}: {
  settings: UserSettings;
  active: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const setSettings = useSetSettings();

  const coverFromSettings =
    settings.default_cover_letter_prompt_instructions?.trim() || settings.cover_letter_prompt_instructions?.trim() || '';
  const coverDefaults = useQuery({
    queryKey: ['settings', 'cover-letter-prompt-defaults'],
    queryFn: fetchCoverLetterPromptDefaults,
    enabled: !coverFromSettings,
    staleTime: Infinity,
  });
  const resumeDefault = settings.default_resume_tailoring_prompt_instructions ?? '';
  const coverDefault =
    coverFromSettings || coverDefaults.data?.default_instructions.trim() || BUILTIN_COVER_LETTER_PROMPT_INSTRUCTIONS;

  const saved = {
    resume: {
      mode: settings.resume_tailoring_prompt_mode ?? 'default',
      text: settings.resume_tailoring_prompt_instructions_custom || resumeDefault,
    },
    cover: {
      mode: settings.cover_letter_prompt_mode ?? 'default',
      text: settings.cover_letter_prompt_instructions_custom || settings.default_cover_letter_prompt_instructions || '',
    },
  };
  const { values, set, clear } = useDraft(saved);
  const [saving, setSaving] = useState(false);

  const resumeMax = settings.resume_tailoring_prompt_max_length || 12000;
  const coverMax = settings.cover_letter_prompt_max_length || BUILTIN_COVER_LETTER_PROMPT_MAX_LENGTH;
  const resume = promptStatus(values.resume, saved.resume, RESUME_TAILORING_PROMPT_MIN_LENGTH, resumeMax);
  const cover = promptStatus(values.cover, saved.cover, COVER_LETTER_PROMPT_MIN_LENGTH, coverMax);
  const dirty = resume.dirty || cover.dirty;
  const invalid = (resume.dirty && !resume.valid) || (cover.dirty && !cover.valid);
  useReportDirty(dirty, onDirtyChange);

  const handleSave = async () => {
    setSaving(true);
    try {
      if (resume.dirty) {
        const text = values.resume.text.trim();
        setSettings(
          await saveResumeTailoringPromptSettings(
            values.resume.mode === 'default'
              ? { resume_tailoring_prompt_mode: 'default' }
              : { resume_tailoring_prompt_mode: 'custom', resume_tailoring_prompt_custom: text },
          ),
        );
        clear(['resume']);
      }
      if (cover.dirty) {
        const text = values.cover.text.trim();
        setSettings(
          await saveCoverLetterPromptSettings(
            values.cover.mode === 'default'
              ? { cover_letter_prompt_mode: 'default' }
              : { cover_letter_prompt_mode: 'custom', cover_letter_prompt_custom: text },
          ),
        );
        clear(['cover']);
      }
      toast.success('Prompts saved', { description: 'Re-run jobs to regenerate documents.' });
    } catch (err) {
      toast.error(extractApiErrorMessage(err, 'Failed to save prompts.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <Alert>
        <Info />
        <AlertDescription>
          These instructions shape newly generated documents. Re-run jobs to regenerate documents.
        </AlertDescription>
      </Alert>

      <PromptSection
        id="resume-prompt"
        title="Resume tailoring prompt"
        description="How AI writes tailored resume content. In Custom mode, your notes also guide match scoring."
        value={values.resume}
        status={resume}
        min={RESUME_TAILORING_PROMPT_MIN_LENGTH}
        max={resumeMax}
        defaultText={resumeDefault}
        disabled={saving}
        onChange={(resumeValue) => set({ resume: resumeValue })}
      />
      <PromptSection
        id="cover-prompt"
        title="Cover letter prompt"
        description="How AI writes the cover letter body."
        value={values.cover}
        status={cover}
        min={COVER_LETTER_PROMPT_MIN_LENGTH}
        max={coverMax}
        defaultText={coverDefault}
        disabled={saving}
        onChange={(coverValue) => set({ cover: coverValue })}
      />

      <SaveBar
        dirty={dirty && active}
        saving={saving}
        disabled={invalid}
        message={invalid ? 'Fix the highlighted prompt to save' : undefined}
        onSave={() => void handleSave()}
        onDiscard={() => clear()}
      />
    </div>
  );
}

function PromptSection({
  id,
  title,
  description,
  value,
  status,
  min,
  max,
  defaultText,
  disabled,
  onChange,
}: {
  id: string;
  title: string;
  description: string;
  value: PromptState;
  status: { length: number; valid: boolean };
  min: number;
  max: number;
  defaultText: string;
  disabled?: boolean;
  onChange: (value: PromptState) => void;
}) {
  return (
    <SectionCard
      title={title}
      description={description}
      actions={
        <ModeToggle
          label={`${title} mode`}
          value={value.mode}
          disabled={disabled}
          onChange={(mode) =>
            onChange(mode === 'custom' && !value.text.trim() ? { mode, text: defaultText } : { ...value, mode })
          }
        />
      }
    >
      {value.mode === 'default' ? (
        <p className="text-sm text-muted-foreground">
          Using the built-in instructions. Switch to <span className="font-medium text-foreground">Custom</span> to
          edit them.
        </p>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className={cn('text-xs text-muted-foreground tabular-nums', !status.valid && 'text-destructive')}>
              {status.length.toLocaleString()} / {max.toLocaleString()}
            </span>
            <Button
              variant="ghost"
              size="xs"
              disabled={disabled || !defaultText}
              onClick={() => onChange({ ...value, text: defaultText })}
            >
              <RotateCcw />
              Reset to default
            </Button>
          </div>
          <PromptEditor
            id={id}
            label={`${title} instructions`}
            value={value.text}
            maxLength={max}
            invalid={!status.valid}
            describedBy={!status.valid ? `${id}-error` : undefined}
            disabled={disabled}
            onChange={(text) => onChange({ ...value, text })}
          />
          {!status.valid ? (
            <FieldError id={`${id}-error`}>
              Must be {min}–{max.toLocaleString()} characters.
            </FieldError>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}
