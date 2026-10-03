import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Plus, RotateCw, X } from 'lucide-react';
import { toast } from 'sonner';
import { SectionCard } from '@/components/app/PageLayout';
import { SaveBar } from '@/components/app/SaveBar';
import { Alert, AlertAction, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { saveAddressPreferences, saveEeoPreferences } from '@/api/profileApi';
import type { AddressInfo, EEOPreferences } from '@/types/profile';
import { GENDER_OPTIONS, RACE_OPTIONS, SEXUAL_ORIENTATION_OPTIONS } from '@/types/profile';
import { emptyAddress, emptyEEO } from '@/utils/profileFormData';
import { extractApiErrorMessage } from '@/utils/profileErrors';
import { TriStateToggle } from './controls';
import { useProfileFormQuery } from './queries';
import { sameJson, useDraft, useReportDirty } from './useDraft';

const MAX_LOCAL_PREFS = 30;
const MAX_PREF_LEN = 120;
const UNSPECIFIED = '__unspecified';

type AddressField = Exclude<keyof AddressInfo, 'local_preferences'>;

const ADDRESS_FIELDS: { key: AddressField; label: string; placeholder: string; autoComplete: string; wide?: boolean }[] = [
  { key: 'line1', label: 'Address line 1', placeholder: '123 Main St', autoComplete: 'address-line1', wide: true },
  { key: 'line2', label: 'Address line 2', placeholder: 'Apt, suite, unit (optional)', autoComplete: 'address-line2', wide: true },
  { key: 'city', label: 'City', placeholder: 'San Francisco', autoComplete: 'address-level2' },
  { key: 'state', label: 'State / Province', placeholder: 'California', autoComplete: 'address-level1' },
  { key: 'postal_code', label: 'Postal code', placeholder: '94105', autoComplete: 'postal-code' },
  { key: 'country', label: 'Country', placeholder: 'United States of America', autoComplete: 'country-name' },
];

type EeoChoiceKey = 'hispanic_latino' | 'veteran_status' | 'disability_status' | 'work_authorized' | 'needs_sponsorship';

const EEO_CHOICES: { key: EeoChoiceKey; label: string; yesLabel?: string; noLabel?: string }[] = [
  { key: 'hispanic_latino', label: 'Hispanic or Latino' },
  { key: 'veteran_status', label: 'Protected veteran', yesLabel: 'I am a veteran', noLabel: 'Not a veteran' },
  { key: 'disability_status', label: 'Disability status', yesLabel: 'Have a disability', noLabel: 'No disability' },
  { key: 'work_authorized', label: 'Authorized to work in the country' },
  { key: 'needs_sponsorship', label: 'Require visa sponsorship' },
];

type EeoSelectKey = 'gender' | 'race' | 'sexual_orientation';

const EEO_SELECTS: { key: EeoSelectKey; label: string; options: readonly string[]; unspecifiedLabel: string; hint?: string }[] = [
  { key: 'gender', label: 'Gender', options: GENDER_OPTIONS, unspecifiedLabel: 'Unspecified' },
  { key: 'race', label: 'Race / Ethnicity', options: RACE_OPTIONS, unspecifiedLabel: 'Unspecified' },
  {
    key: 'sexual_orientation',
    label: 'Sexual orientation',
    options: SEXUAL_ORIENTATION_OPTIONS,
    unspecifiedLabel: 'Unspecified (decline on forms)',
    hint: 'Forms with multiple choices get only this answer. Unspecified maps to "I don\'t wish to answer" when available.',
  },
];

function normalizePrefs(list: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list ?? []) {
    const text = raw.trim().slice(0, MAX_PREF_LEN);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= MAX_LOCAL_PREFS) break;
  }
  return out;
}

const normalizedAddress = (a: AddressInfo) => ({ ...a, local_preferences: normalizePrefs(a.local_preferences) });

export function ApplicationDetailsTab({
  active,
  onDirtyChange,
}: {
  active: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const query = useProfileFormQuery();

  if (query.isPending) {
    return (
      <div className="space-y-6" aria-busy="true" aria-label="Loading application details">
        <Skeleton className="h-80 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>{extractApiErrorMessage(query.error, 'Failed to load application details.')}</AlertTitle>
        <AlertAction>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            <RotateCw />
            Retry
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  return (
    <ApplicationDetailsForm
      address={query.data.address ?? emptyAddress()}
      eeo={query.data.eeo_preferences ?? emptyEEO()}
      active={active}
      onDirtyChange={onDirtyChange}
    />
  );
}

function ApplicationDetailsForm({
  address: savedAddress,
  eeo: savedEeo,
  active,
  onDirtyChange,
}: {
  address: AddressInfo;
  eeo: EEOPreferences;
  active: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { values, set, clear } = useDraft({ address: savedAddress, eeo: savedEeo });
  const [saving, setSaving] = useState(false);
  const [prefDraft, setPrefDraft] = useState('');
  const [prefError, setPrefError] = useState('');

  const addressDirty = !sameJson(normalizedAddress(values.address), normalizedAddress(savedAddress));
  const eeoDirty = !sameJson(values.eeo, savedEeo);
  const dirty = addressDirty || eeoDirty;
  useReportDirty(dirty, onDirtyChange);

  const localPrefs = normalizePrefs(values.address.local_preferences);
  const setAddress = (patch: Partial<AddressInfo>) => set({ address: { ...values.address, ...patch } });
  const setEeo = (patch: Partial<EEOPreferences>) => set({ eeo: { ...values.eeo, ...patch } });

  const addPreference = () => {
    const text = prefDraft.trim();
    if (!text) return;
    if (localPrefs.length >= MAX_LOCAL_PREFS) {
      setPrefError(`You can add at most ${MAX_LOCAL_PREFS} local preferences.`);
      return;
    }
    if (localPrefs.some((p) => p.toLowerCase() === text.toLowerCase())) {
      setPrefError('That location is already in your list.');
      return;
    }
    setAddress({ local_preferences: [...localPrefs, text] });
    setPrefDraft('');
    setPrefError('');
  };

  const handleSave = async () => {
    setSaving(true);
    const done: ('address' | 'eeo')[] = [];
    try {
      if (addressDirty) {
        await saveAddressPreferences(normalizedAddress(values.address));
        done.push('address');
      }
      if (eeoDirty) {
        await saveEeoPreferences(values.eeo);
        done.push('eeo');
      }
      toast.success('Application details saved');
    } catch (err) {
      toast.error(extractApiErrorMessage(err, 'Failed to save application details.'));
    } finally {
      if (done.length) {
        await queryClient.invalidateQueries({ queryKey: ['profile'] });
        clear(done);
      }
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <SectionCard
        title="Address and location"
        description="Your legal address for autofilling applications, plus places you'd like to work."
      >
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {ADDRESS_FIELDS.map((f) => (
              <Field key={f.key} className={f.wide ? 'sm:col-span-2' : undefined}>
                <FieldLabel htmlFor={`address-${f.key}`}>{f.label}</FieldLabel>
                <Input
                  id={`address-${f.key}`}
                  value={values.address[f.key] ?? ''}
                  placeholder={f.placeholder}
                  autoComplete={f.autoComplete}
                  disabled={saving}
                  onChange={(e) => setAddress({ [f.key]: e.target.value })}
                />
              </Field>
            ))}
          </div>

          <Separator />

          <Field data-invalid={prefError ? true : undefined}>
            <div className="flex items-baseline justify-between gap-2">
              <FieldLabel htmlFor="local-pref-input">Local preferences</FieldLabel>
              <span className="text-xs text-muted-foreground tabular-nums">
                {localPrefs.length} / {MAX_LOCAL_PREFS}
              </span>
            </div>
            <FieldDescription>Regions or cities you prefer, e.g. Bay Area, Remote US, Seattle metro.</FieldDescription>
            <div className="flex gap-2">
              <Input
                id="local-pref-input"
                value={prefDraft}
                maxLength={MAX_PREF_LEN}
                placeholder="Add a preferred location…"
                disabled={saving}
                onChange={(e) => {
                  setPrefDraft(e.target.value);
                  setPrefError('');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addPreference();
                  }
                }}
              />
              <Button
                variant="outline"
                onClick={addPreference}
                disabled={saving || !prefDraft.trim() || localPrefs.length >= MAX_LOCAL_PREFS}
              >
                <Plus />
                Add
              </Button>
            </div>
            {prefError ? <FieldError>{prefError}</FieldError> : null}
            {localPrefs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No local preferences yet.</p>
            ) : (
              <ul className="flex flex-wrap gap-2" aria-label="Saved local preferences">
                {localPrefs.map((pref) => (
                  <li key={pref}>
                    <Badge variant="secondary" className="h-7 max-w-full gap-1 pr-1 pl-2.5 text-sm">
                      <span className="truncate">{pref}</span>
                      <button
                        type="button"
                        aria-label={`Remove ${pref}`}
                        disabled={saving}
                        onClick={() => setAddress({ local_preferences: localPrefs.filter((p) => p !== pref) })}
                        className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <X className="size-3.5" />
                      </button>
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </Field>
        </div>
      </SectionCard>

      <SectionCard
        title="EEO and work eligibility"
        description="Voluntary answers used to autofill application forms. Leave Unspecified to skip."
      >
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {EEO_SELECTS.map((f) => {
              const items = [
                { value: UNSPECIFIED, label: f.unspecifiedLabel },
                ...f.options.map((o) => ({ value: o, label: o })),
              ];
              return (
                <Field key={f.key} className={f.hint ? 'sm:col-span-2' : undefined}>
                  <FieldLabel htmlFor={`eeo-${f.key}`}>{f.label}</FieldLabel>
                  <Select
                    items={items}
                    value={values.eeo[f.key] || UNSPECIFIED}
                    disabled={saving}
                    onValueChange={(v) => setEeo({ [f.key]: !v || v === UNSPECIFIED ? '' : String(v) })}
                  >
                    <SelectTrigger id={`eeo-${f.key}`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {items.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {f.hint ? <FieldDescription>{f.hint}</FieldDescription> : null}
                </Field>
              );
            })}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {EEO_CHOICES.map((f) => (
              <div key={f.key} className="space-y-2">
                <p className="text-sm font-medium">{f.label}</p>
                <TriStateToggle
                  label={f.label}
                  value={values.eeo[f.key]}
                  yesLabel={f.yesLabel}
                  noLabel={f.noLabel}
                  onChange={(v) => setEeo({ [f.key]: v })}
                />
              </div>
            ))}
          </div>
        </div>
      </SectionCard>

      <SaveBar dirty={dirty && active} saving={saving} onSave={() => void handleSave()} onDiscard={() => clear()} />
    </div>
  );
}
