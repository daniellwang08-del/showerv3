import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { SectionCard } from '@/components/app/PageLayout';
import { SaveBar } from '@/components/app/SaveBar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel, FieldTitle } from '@/components/ui/field';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { saveCountryPreferences, saveJobMatchPreferences, saveJobShareDefaultSettings } from '@/api/settingsApi';
import { JOB_SHARE_DEFAULT_OPTIONS } from '@/features/jobs/jobAddShare';
import type { JobShareDefault, UserSettings } from '@/types/settings';
import { extractApiErrorMessage } from '@/utils/profileErrors';
import { refreshJobStores, useSetSettings } from './queries';
import { useDraft, useReportDirty } from './useDraft';

const SOURCE_HINTS: Record<UserSettings['country_preferences_source'], string> = {
  unset: 'Not set yet. Add countries, or parse your resume to detect them automatically.',
  auto: 'Detected from your resume. Editing here makes it manual.',
  manual: 'Set manually. Resume parsing will not overwrite this.',
};

export function JobSearchTab({
  settings,
  active,
  onDirtyChange,
}: {
  settings: UserSettings;
  active: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const setSettings = useSetSettings();
  const [savingShare, setSavingShare] = useState(false);
  const saved = { countries: settings.country_preferences, preferences: settings.job_match_preferences ?? '' };
  const { values, set, clear } = useDraft(saved);
  const [saving, setSaving] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const maxLength = settings.job_match_preferences_max_length || 4000;
  const prefsLength = values.preferences.trim().length;
  const prefsTooLong = prefsLength > maxLength;
  const countriesChanged =
    values.countries.length !== saved.countries.length ||
    values.countries.some((code, i) => saved.countries[i] !== code);
  const prefsChanged = values.preferences.trim() !== saved.preferences.trim();
  const dirty = countriesChanged || prefsChanged;
  useReportDirty(dirty, onDirtyChange);

  const nameByCode = new Map(settings.available_countries.map((c) => [c.code, c.name]));
  const addable = settings.available_countries.filter((c) => !values.countries.includes(c.code));

  const handleSave = async () => {
    setSaving(true);
    const notes: string[] = [];
    try {
      if (countriesChanged) {
        const countries = values.countries;
        setSettings(await saveCountryPreferences(countries));
        clear(['countries']);
        notes.push(
          countries.length
            ? 'Existing jobs are being re-checked in the background.'
            : 'Location filtering is off; jobs from every country stay visible.',
        );
        window.setTimeout(refreshJobStores, 1500);
      }
      if (prefsChanged) {
        const trimmed = values.preferences.trim();
        setSettings(
          await saveJobMatchPreferences(
            trimmed ? { job_match_preferences: trimmed } : { clear_job_match_preferences: true },
          ),
        );
        clear(['preferences']);
        notes.push(
          trimmed ? 'Re-run match analysis on existing jobs to apply your preferences.' : 'Job match preferences cleared.',
        );
      }
      toast.success('Job search preferences saved', { description: notes.join(' ') });
    } catch (err) {
      toast.error(extractApiErrorMessage(err, 'Failed to save job search preferences.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <SectionCard
        title="Job countries"
        description="Jobs located outside these countries are hidden automatically."
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2" aria-label="Selected countries" role="list">
            {values.countries.length === 0 ? (
              <span role="listitem" className="rounded-lg border border-dashed px-2.5 py-1 text-sm text-muted-foreground">
                No filter: worldwide
              </span>
            ) : (
              values.countries.map((code) => {
                const name = nameByCode.get(code) ?? code;
                return (
                  <Badge key={code} role="listitem" variant="secondary" className="h-7 gap-1 pr-1 pl-2.5 text-sm">
                    {name}
                    <button
                      type="button"
                      aria-label={`Remove ${name}`}
                      disabled={saving}
                      onClick={() => set({ countries: values.countries.filter((c) => c !== code) })}
                      className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  </Badge>
                );
              })
            )}
          </div>

          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger
              render={
                <Button variant="outline" size="sm" disabled={saving || addable.length === 0}>
                  <Plus />
                  Add a country
                </Button>
              }
            />
            <PopoverContent align="start" className="w-72 p-0">
              <Command>
                <CommandInput placeholder="Search countries…" aria-label="Search countries" />
                <CommandList>
                  <CommandEmpty>No matching country.</CommandEmpty>
                  <CommandGroup>
                    {addable.map((c) => (
                      <CommandItem
                        key={c.code}
                        value={`${c.name} ${c.code}`}
                        onSelect={() => {
                          set({ countries: [...values.countries, c.code] });
                          setPickerOpen(false);
                        }}
                      >
                        {c.name}
                        <span className="text-xs text-muted-foreground">{c.code}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>

          <p className="text-sm text-muted-foreground">
            {SOURCE_HINTS[settings.country_preferences_source]} Leave empty to see jobs from anywhere.
          </p>
        </div>
      </SectionCard>

      <SectionCard
        title="When you add jobs"
        description="Every job you add is stored with this sharing. You can change it later for a single add from the sidebar history."
      >
        <RadioGroup
          aria-label="Default sharing for jobs you add"
          value={settings.job_share_default}
          disabled={savingShare}
          onValueChange={(value) => {
            const next = value as JobShareDefault;
            if (next === settings.job_share_default) return;
            setSavingShare(true);
            void saveJobShareDefaultSettings({ job_share_default: next })
              .then((updated) => {
                setSettings(updated);
                toast.success('Default sharing saved');
              })
              .catch((err) => {
                toast.error(extractApiErrorMessage(err, 'Failed to save default sharing.'));
              })
              .finally(() => setSavingShare(false));
          }}
        >
          {JOB_SHARE_DEFAULT_OPTIONS.map((opt) => (
            <FieldLabel key={opt.value} htmlFor={`job-share-${opt.value}`}>
              <Field orientation="horizontal">
                <RadioGroupItem
                  value={opt.value}
                  id={`job-share-${opt.value}`}
                  aria-labelledby={`job-share-${opt.value}-title`}
                  aria-describedby={`job-share-${opt.value}-hint`}
                />
                <FieldContent>
                  <FieldTitle id={`job-share-${opt.value}-title`}>{opt.label}</FieldTitle>
                  <FieldDescription id={`job-share-${opt.value}-hint`}>{opt.hint}</FieldDescription>
                </FieldContent>
              </Field>
            </FieldLabel>
          ))}
        </RadioGroup>
      </SectionCard>

      <SectionCard
        title="Job match preferences"
        description="Tell the AI what roles you want. The match analysis uses this when scoring jobs."
      >
        <Field data-invalid={prefsTooLong || undefined}>
          <div className="flex items-baseline justify-between gap-2">
            <FieldLabel htmlFor="job-match-preferences">What you're looking for</FieldLabel>
            <span className={cn('text-xs tabular-nums text-muted-foreground', prefsTooLong && 'text-destructive')}>
              {prefsLength.toLocaleString()} / {maxLength.toLocaleString()}
            </span>
          </div>
          <Textarea
            id="job-match-preferences"
            value={values.preferences}
            maxLength={maxLength}
            disabled={saving}
            aria-invalid={prefsTooLong || undefined}
            onChange={(e) => set({ preferences: e.target.value })}
            rows={7}
            className="min-h-40"
            placeholder={
              'e.g.\n- Senior backend / platform engineer roles\n- Prefer fintech, developer tools, or infra startups\n- Target compensation $160k+\n- Avoid roles requiring security clearance'
            }
          />
          <FieldDescription>
            Titles, industries, salary, company size, tech stack, or roles to avoid. Remote vs onsite is not used in
            the score. Re-run analysis to apply changes to existing jobs.
          </FieldDescription>
          {prefsTooLong ? <FieldError>Keep it under {maxLength.toLocaleString()} characters.</FieldError> : null}
        </Field>
      </SectionCard>

      <SaveBar
        dirty={dirty && active}
        saving={saving}
        disabled={prefsTooLong}
        onSave={() => void handleSave()}
        onDiscard={() => clear()}
      />
    </div>
  );
}
