import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { SectionCard } from '@/components/app/PageLayout';
import { FilenameTokenChips } from '@/components/app/FilenameTokenChips';
import { Button } from '@/components/ui/button';
import { Field, FieldContent, FieldDescription, FieldLabel, FieldTitle } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { previewDocumentFilename, saveResumeFilenameSettings } from '@/api/settingsApi';
import { DEFAULT_RESUME_FILENAME_PATTERN, type ResumeFilenameMode, type UserSettings } from '@/types/settings';
import { extractApiErrorMessage } from '@/utils/profileErrors';
import { SETTINGS_KEY } from './queries';

export const FILENAME_PRESETS: { value: string; label: string }[] = [
  { value: DEFAULT_RESUME_FILENAME_PATTERN, label: 'Name and document (default)' },
  { value: '{firstname}_{lastname}_{company}_{kind}', label: 'Name, company, document' },
  { value: '{fullname}_{title}_{company}', label: 'Name, job title, company' },
  { value: '{lastname}_{company}_{date}', label: 'Last name, company, date' },
];

const MODE_OPTIONS: { value: ResumeFilenameMode; label: string; hint: string }[] = [
  {
    value: 'pattern',
    label: 'Build from fields',
    hint: 'Mix your name with the company and job title of each job, so every application gets its own name.',
  },
  {
    value: 'static',
    label: 'Same name for every job',
    hint: 'One fixed name. Cover letters add _cover_letter so the two files never clash.',
  },
];

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

/** Preferences card for how resume and cover letter files are named on download and application upload. */
export function DocumentFilenameSection({ settings }: { settings: UserSettings }) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<ResumeFilenameMode>(settings.resume_filename_mode);
  const [value, setValue] = useState(settings.resume_filename_value);

  useEffect(() => {
    setMode(settings.resume_filename_mode);
    setValue(settings.resume_filename_value);
  }, [settings.resume_filename_mode, settings.resume_filename_value]);

  const dirty = mode !== settings.resume_filename_mode || value.trim() !== settings.resume_filename_value;
  const empty = mode === 'static' && !value.trim();
  const previewInput = useDebounced({ mode, value: value.trim() }, 250);
  const preview = useQuery({
    queryKey: ['document-filename-preview', previewInput.mode, previewInput.value],
    queryFn: () => previewDocumentFilename(previewInput),
    enabled: !(previewInput.mode === 'static' && !previewInput.value),
    retry: false,
    staleTime: 60_000,
  });

  const save = useMutation({
    mutationFn: () => saveResumeFilenameSettings({ resume_filename_mode: mode, resume_filename_value: value.trim() }),
    onSuccess: (data) => {
      queryClient.setQueryData(SETTINGS_KEY, data);
      toast.success('Saved. Downloads and application uploads use the new file names, including jobs already prepared.');
    },
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Could not save the file name rule.')),
  });

  const previewError = preview.isError ? extractApiErrorMessage(preview.error, 'Check the file name.') : null;

  return (
    <SectionCard
      title="Document file names"
      description="How your resume and cover letter files are named when you download them and when the extension uploads them to applications."
    >
      <div className="space-y-4">
        <RadioGroup
          aria-label="File name style"
          value={mode}
          disabled={save.isPending}
          onValueChange={(next) => {
            const nextMode = next as ResumeFilenameMode;
            setMode(nextMode);
            if (nextMode === settings.resume_filename_mode) setValue(settings.resume_filename_value);
            else setValue(nextMode === 'pattern' ? DEFAULT_RESUME_FILENAME_PATTERN : '');
          }}
        >
          {MODE_OPTIONS.map((opt) => (
            <FieldLabel key={opt.value} htmlFor={`filename-mode-${opt.value}`}>
              <Field orientation="horizontal">
                <RadioGroupItem
                  value={opt.value}
                  id={`filename-mode-${opt.value}`}
                  aria-labelledby={`filename-mode-${opt.value}-title`}
                  aria-describedby={`filename-mode-${opt.value}-hint`}
                />
                <FieldContent>
                  <FieldTitle id={`filename-mode-${opt.value}-title`}>{opt.label}</FieldTitle>
                  <FieldDescription id={`filename-mode-${opt.value}-hint`}>{opt.hint}</FieldDescription>
                </FieldContent>
              </Field>
            </FieldLabel>
          ))}
        </RadioGroup>

        <div className="space-y-2">
          <label htmlFor="document-filename-value" className="text-sm font-medium">
            {mode === 'pattern' ? 'File name pattern' : 'File name'}
          </label>
          <Input
            id="document-filename-value"
            ref={inputRef}
            value={value}
            maxLength={200}
            spellCheck={false}
            placeholder={mode === 'pattern' ? DEFAULT_RESUME_FILENAME_PATTERN : 'Jane_Doe_Resume'}
            className="font-mono"
            aria-invalid={previewError ? true : undefined}
            onChange={(e) => setValue(e.target.value)}
          />
          {mode === 'pattern' && (
            <>
              <FilenameTokenChips value={value} onChange={setValue} inputRef={inputRef} disabled={save.isPending} />
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Start from a preset">
                {FILENAME_PRESETS.map((preset) => (
                  <Button
                    key={preset.value}
                    type="button"
                    size="sm"
                    variant={value === preset.value ? 'secondary' : 'ghost'}
                    className="h-7 px-2 text-xs"
                    onClick={() => setValue(preset.value)}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Fields in braces are filled per job. A field with no value (a job with no company) is left out with its
                separator. Without {'{kind}'}, cover letters add _cover_letter.
              </p>
            </>
          )}
        </div>

        <div className="rounded-lg border bg-muted/30 px-3 py-2.5" aria-live="polite">
          <p className="mb-1.5 text-xs text-muted-foreground">Example for a Software Engineer job at Acme</p>
          {empty ? (
            <p className="text-sm text-muted-foreground">Enter a file name.</p>
          ) : previewError ? (
            <p className="text-sm text-destructive">{previewError}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {(['resume', 'cover_letter'] as const).map((kind) => (
                <li key={kind} className="flex items-center gap-2">
                  <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate font-mono" data-testid={`filename-preview-${kind}`}>
                    {preview.data?.[kind] ?? '…'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          Applies to every job, including ones already prepared. To name one job differently, rename its files from the
          job&apos;s documents.
        </p>

        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={!dirty || save.isPending}
            onClick={() => {
              setMode(settings.resume_filename_mode);
              setValue(settings.resume_filename_value);
            }}
          >
            Discard
          </Button>
          <Button type="button" disabled={!dirty || empty || !!previewError || save.isPending} onClick={() => save.mutate()}>
            {save.isPending && <Loader2 className="size-3.5 animate-spin" />}
            Save file names
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}
