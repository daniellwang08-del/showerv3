import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FileUp,
  Link2,
  Loader2,
  Puzzle,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/api/client';
import { fetchUserProfile, saveUserProfile } from '@/api/profileApi';
import { fetchUserSettings, updateUserSettings } from '@/api/settingsApi';
import { PageTitle } from '@/components/app/PageTitle';
import { CountryPicker } from '@/components/app/CountryPicker';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { COUNTRY_CODES } from '@/constants/countryCodes';
import { submitJobUrls } from '@/features/jobs/submitJobUrls';
import { cn } from '@/lib/utils';
import type { ProfileFormData, UserProfile } from '@/types/profile';
import { extractHttpUrlsFromText } from '@/utils/extractHttpUrls';
import { profileErrorFromUnknown } from '@/utils/profileErrors';
import { profileToForm } from '@/utils/profileFormData';
import { validateProfileForSave } from '@/utils/profileValidation';
import { mergeResumeImport, type ResumeDraft } from '@/utils/resumeMerge';
import { ONBOARDING_STEPS, readOnboarding, writeOnboarding, type OnboardingStatus } from './onboardingState';

const STEP_LABELS = ['Résumé', 'Essentials', 'Preferences', 'First jobs'];
const ESSENTIAL_FIELDS = [
  'name_first',
  'name_last',
  'title',
  'email',
  'phone_country_code',
  'phone_number',
  'linkedin_url',
  'profile_summary',
] as const;
type EssentialField = (typeof ESSENTIAL_FIELDS)[number];

const PREFERENCE_HINTS = ['Remote only', 'Senior or lead roles', 'Product companies', 'No contract roles', 'Visa sponsorship'];
const MAX_RESUME_BYTES = 6 * 1024 * 1024;

type ParseResponse = { draft?: ResumeDraft; warnings?: string[]; source_kind?: string };

const draftKey = (userId: string) => `nao.onboarding.form.v1.${userId}`;

/** The parsed résumé lives here until the essentials step saves it, so a reload doesn't lose it. */
function readDraft(userId: string | undefined): ProfileFormData | null {
  if (!userId) return null;
  try {
    const raw = sessionStorage.getItem(draftKey(userId));
    return raw ? (JSON.parse(raw) as ProfileFormData) : null;
  } catch {
    return null;
  }
}

function writeDraft(userId: string | undefined, form: ProfileFormData | null) {
  if (!userId) return;
  try {
    if (form) sessionStorage.setItem(draftKey(userId), JSON.stringify(form));
    else sessionStorage.removeItem(draftKey(userId));
  } catch {
    // Storage unavailable: the draft just won't survive a reload.
  }
}

export function OnboardingPage({
  userId,
  accountEmail,
  onProfileSaved,
}: {
  userId?: string;
  accountEmail?: string;
  onProfileSaved?: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStepState] = useState(() => readOnboarding(userId)?.step ?? 0);
  const profileQuery = useQuery({ queryKey: ['profile'], queryFn: fetchUserProfile });
  const [form, setFormState] = useState<ProfileFormData | null>(() => readDraft(userId));
  const setForm = (next: ProfileFormData | null) => {
    setFormState(next);
    writeDraft(userId, next);
  };

  const persist = (next: number, status: OnboardingStatus = 'active') =>
    writeOnboarding(userId, { step: next, status });
  const setStep = (next: number) => {
    setStepState(next);
    persist(next);
  };
  const leave = (status: 'done' | 'skipped', to: string) => {
    persist(step, status);
    navigate(to, { replace: true });
  };

  const baseForm = (): ProfileFormData => {
    const f = profileToForm(profileQuery.data ?? null);
    return { ...f, email: f.email || accountEmail || '' };
  };
  const currentForm = form ?? baseForm();

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <PageTitle title="Get started" />
      <header className="flex h-14 shrink-0 items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-2">
          <img src="/nao-logo.png" alt="" className="h-6 w-auto" />
          <span className="text-[15px] font-semibold tracking-tight">NAO</span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => leave('skipped', '/app')}>
          Skip for now
        </Button>
      </header>

      <main className="flex flex-1 justify-center px-4 pt-6 pb-16 sm:pt-12">
        <div className="w-full max-w-xl">
          <Stepper step={step} onJump={(i) => i < step && setStep(i)} />
          <div className="mt-8">
            {profileQuery.isPending ? (
              <div className="space-y-3">
                <Skeleton className="h-8 w-2/3" />
                <Skeleton className="h-40 w-full" />
              </div>
            ) : step === 0 ? (
              <ResumeStep
                profile={profileQuery.data ?? null}
                accountEmail={accountEmail}
                onParsed={(merged) => {
                  setForm(merged);
                  setStep(1);
                }}
                onManual={() => {
                  setForm(baseForm());
                  setStep(1);
                }}
              />
            ) : step === 1 ? (
              <EssentialsStep
                form={currentForm}
                onBack={() => setStep(0)}
                onSaved={(saved) => {
                  queryClient.setQueryData(['profile'], saved);
                  setForm(null);
                  onProfileSaved?.();
                  setStep(2);
                }}
              />
            ) : step === 2 ? (
              <PreferencesStep onBack={() => setStep(1)} onDone={() => setStep(3)} />
            ) : (
              <JobsStep
                onBack={() => setStep(2)}
                onFinish={(to) => {
                  toast.success("You're all set");
                  leave('done', to);
                }}
              />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function Stepper({ step, onJump }: { step: number; onJump: (i: number) => void }) {
  return (
    <ol className="flex items-center gap-2" aria-label="Onboarding progress">
      {ONBOARDING_STEPS.map((id, i) => {
        const done = i < step;
        const current = i === step;
        return (
          <li key={id} className="flex flex-1 flex-col gap-1.5">
            <button
              type="button"
              onClick={() => onJump(i)}
              disabled={!done}
              aria-current={current ? 'step' : undefined}
              className={cn(
                'h-1.5 rounded-full transition-colors',
                done ? 'bg-brand' : current ? 'bg-brand/60' : 'bg-muted',
                done && 'cursor-pointer hover:bg-brand/80',
              )}
              aria-label={`${STEP_LABELS[i]}${done ? ' (done)' : current ? ' (current)' : ''}`}
            />
            <span className={cn('text-xs', current ? 'font-medium text-foreground' : 'text-muted-foreground')}>
              {STEP_LABELS[i]}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function StepHeader({ title, description }: { title: string; description: ReactNode }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1.5 text-muted-foreground">{description}</p>
    </div>
  );
}

function StepActions({ children }: { children: ReactNode }) {
  return <div className="mt-8 flex items-center justify-between gap-3">{children}</div>;
}

function ResumeStep({
  profile,
  accountEmail,
  onParsed,
  onManual,
}: {
  profile: UserProfile | null;
  accountEmail?: string;
  onParsed: (merged: ProfileFormData) => void;
  onManual: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);

  const onFile = async (file: File | undefined) => {
    if (!file || busy) return;
    const name = file.name.toLowerCase();
    if (!name.endsWith('.pdf') && !name.endsWith('.docx')) {
      setError('Choose a PDF or DOCX file.');
      return;
    }
    if (file.size > MAX_RESUME_BYTES) {
      setError('File must be 6 MB or smaller.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { data } = await apiClient.post<ParseResponse>('/profile/resume-parse', fd);
      if (!data?.draft) throw new Error('No data returned from parser.');
      for (const w of data.warnings ?? []) toast.warning(w);
      onParsed(mergeResumeImport(profile, data.draft, accountEmail, 'empty_only'));
    } catch (err) {
      setError(profileErrorFromUnknown(err, 'Could not read that résumé.'));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void onFile(e.dataTransfer.files?.[0]);
  };

  return (
    <>
      <StepHeader
        title="Let's start with your résumé"
        description="NAO reads it to build your profile, match you to jobs, and tailor documents. You can review everything next."
      />
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'flex flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-12 text-center transition-colors',
          dragging ? 'border-brand bg-brand-soft/40' : 'border-border',
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="hidden"
          aria-label="Résumé file"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        {busy ? (
          <>
            <Loader2 className="size-8 animate-spin text-brand" />
            <p className="mt-3 font-medium">Reading your résumé…</p>
            <p className="text-sm text-muted-foreground">This usually takes a few seconds.</p>
          </>
        ) : (
          <>
            <div className="flex size-12 items-center justify-center rounded-full bg-brand-soft text-brand">
              <FileUp className="size-6" />
            </div>
            <p className="mt-3 font-medium">Drop your résumé here</p>
            <p className="text-sm text-muted-foreground">PDF or DOCX, up to 6 MB</p>
            <Button className="mt-4" onClick={() => inputRef.current?.click()}>
              Choose file
            </Button>
          </>
        )}
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <StepActions>
        <span />
        <Button variant="ghost" onClick={onManual} disabled={busy}>
          I'll fill it in myself
          <ArrowRight />
        </Button>
      </StepActions>
    </>
  );
}

function EssentialsStep({
  form: initial,
  onBack,
  onSaved,
}: {
  form: ProfileFormData;
  onBack: () => void;
  onSaved: (saved: UserProfile) => void;
}) {
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Partial<Record<EssentialField, string>>>({});
  const [saving, setSaving] = useState(false);
  const set = (key: EssentialField, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const counted = (n: number, one: string, many: string) => (n ? `${n} ${n === 1 ? one : many}` : '');
  const found = [
    counted(form.work_experience.filter((w) => w.company_name.trim()).length, 'role', 'roles'),
    counted(form.technical_skills.filter((s) => s.skills.trim()).length, 'skill group', 'skill groups'),
    counted(form.education.filter((e) => e.university_name.trim()).length, 'school', 'schools'),
  ].filter(Boolean);

  const save = async () => {
    const all = validateProfileForSave(form);
    const essential: Partial<Record<EssentialField, string>> = {};
    for (const k of ESSENTIAL_FIELDS) if (all[k]) essential[k] = all[k];
    setErrors(essential);
    if (Object.keys(essential).length) {
      document.getElementById(`onb-${Object.keys(essential)[0]}`)?.focus();
      return;
    }
    const other = Object.keys(all).filter((k) => !(ESSENTIAL_FIELDS as readonly string[]).includes(k));
    if (other.length) {
      toast.error('Some imported details need fixing. Finish setup, then review them in Profile.');
    }
    setSaving(true);
    try {
      onSaved(await saveUserProfile(form));
    } catch (err) {
      toast.error(profileErrorFromUnknown(err, 'Could not save your profile.'));
    } finally {
      setSaving(false);
    }
  };

  const field = (key: EssentialField, label: string, props: React.ComponentProps<typeof Input> = {}) => (
    <Field data-invalid={!!errors[key] || undefined}>
      <FieldLabel htmlFor={`onb-${key}`}>{label}</FieldLabel>
      <Input
        id={`onb-${key}`}
        value={form[key]}
        aria-invalid={!!errors[key] || undefined}
        onChange={(e) => set(key, e.target.value)}
        {...props}
      />
      {errors[key] ? <FieldError>{errors[key]}</FieldError> : null}
    </Field>
  );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      noValidate
    >
      <StepHeader
        title="Confirm the essentials"
        description={
          found.length ? (
            <>
              We also found {found.join(', ')}. You can refine everything later in Profile.
            </>
          ) : (
            'These details go on your tailored résumés and application forms.'
          )
        }
      />
      <FieldGroup>
        <div className="grid gap-4 sm:grid-cols-2">
          {field('name_first', 'First name', { autoComplete: 'given-name' })}
          {field('name_last', 'Last name', { autoComplete: 'family-name' })}
        </div>
        {field('title', 'Professional title', { placeholder: 'Senior Software Engineer' })}
        {field('email', 'Email', { type: 'email', autoComplete: 'email' })}
        <Field data-invalid={!!errors.phone_number || undefined}>
          <FieldLabel htmlFor="onb-phone_number">Phone</FieldLabel>
          <div className="flex gap-2">
            <Select
              items={COUNTRY_CODES.map((c) => ({ value: c.code, label: `${c.code} ${c.country}` }))}
              value={form.phone_country_code || '+1'}
              onValueChange={(v) => set('phone_country_code', String(v ?? '+1'))}
            >
              <SelectTrigger className="w-40 shrink-0" aria-label="Phone country code">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COUNTRY_CODES.map((c) => (
                  <SelectItem key={`${c.code}-${c.country}`} value={c.code}>
                    {c.code} {c.country}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              id="onb-phone_number"
              type="tel"
              autoComplete="tel-national"
              value={form.phone_number}
              aria-invalid={!!errors.phone_number || undefined}
              onChange={(e) => set('phone_number', e.target.value)}
            />
          </div>
          {errors.phone_number ? <FieldError>{errors.phone_number}</FieldError> : null}
        </Field>
        {field('linkedin_url', 'LinkedIn profile URL', { placeholder: 'https://linkedin.com/in/you' })}
        <Field data-invalid={!!errors.profile_summary || undefined}>
          <FieldLabel htmlFor="onb-profile_summary">Professional summary</FieldLabel>
          <Textarea
            id="onb-profile_summary"
            rows={5}
            maxLength={5000}
            value={form.profile_summary}
            aria-invalid={!!errors.profile_summary || undefined}
            onChange={(e) => set('profile_summary', e.target.value)}
            placeholder="Two or three sentences about your experience and what you do best."
          />
          {errors.profile_summary ? <FieldError>{errors.profile_summary}</FieldError> : null}
        </Field>
      </FieldGroup>
      <StepActions>
        <Button type="button" variant="ghost" onClick={onBack} disabled={saving}>
          <ArrowLeft /> Back
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? <Loader2 className="animate-spin" /> : null}
          Save and continue
        </Button>
      </StepActions>
    </form>
  );
}

function PreferencesStep({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: fetchUserSettings });
  const [draft, setDraft] = useState<{ countries: string[]; prefs: string; autoScore: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const s = settings.data;
  const loaded = {
    countries: s?.country_preferences ?? [],
    prefs: s?.job_match_preferences ?? '',
    autoScore: s?.auto_prepare_match ?? false,
  };
  const value = draft ?? loaded;
  type Draft = typeof value;
  const update = (patch: Partial<Draft> | ((d: Draft) => Partial<Draft>)) =>
    setDraft((d) => {
      const cur = d ?? loaded;
      return { ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) };
    });
  const maxLen = s?.job_match_preferences_max_length || 4000;

  const save = async () => {
    setSaving(true);
    try {
      const prefs = value.prefs.trim();
      const next = await updateUserSettings({
        country_preferences: value.countries,
        ...(prefs ? { job_match_preferences: prefs } : { clear_job_match_preferences: true }),
        auto_prepare_match: value.autoScore,
        ...(value.autoScore ? {} : { auto_prepare_full: false }),
      });
      queryClient.setQueryData(['settings'], next);
      onDone();
    } catch (err) {
      toast.error(profileErrorFromUnknown(err, 'Could not save your preferences.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <StepHeader
        title="What are you looking for?"
        description="NAO uses this to filter and score jobs. Change it any time in Preferences."
      />
      {settings.isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : settings.isError ? (
        <div className="rounded-xl border p-4 text-sm">
          Could not load your preferences.{' '}
          <Button variant="link" className="h-auto p-0" onClick={() => void settings.refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <FieldGroup>
          <Field>
            <FieldLabel>Countries you can work in</FieldLabel>
            <CountryPicker
              value={value.countries}
              options={s?.available_countries ?? []}
              onChange={(countries) => update({ countries })}
            />
            <FieldDescription>
              {s?.country_preferences_source === 'auto' && !draft
                ? 'Suggested from your résumé.'
                : 'Leave empty to see jobs from anywhere.'}
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="onb-prefs">Describe your ideal role</FieldLabel>
            <Textarea
              id="onb-prefs"
              rows={5}
              maxLength={maxLen}
              value={value.prefs}
              onChange={(e) => update({ prefs: e.target.value })}
              placeholder="e.g. Backend or platform roles, Python or Go, remote in the US, no agencies."
            />
            <div className="flex flex-wrap gap-1.5">
              {PREFERENCE_HINTS.map((hint) => (
                <button
                  key={hint}
                  type="button"
                  onClick={() =>
                    update((d) => ({ prefs: d.prefs.trim() ? `${d.prefs.trim()}\n${hint}` : hint }))
                  }
                  className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Sparkles className="size-3 text-brand" />
                  {hint}
                </button>
              ))}
            </div>
          </Field>
          <Field orientation="horizontal">
            <Switch
              id="onb-autoscore"
              checked={value.autoScore}
              onCheckedChange={(autoScore) => update({ autoScore })}
            />
            <div>
              <FieldLabel htmlFor="onb-autoscore">Score new jobs automatically</FieldLabel>
              <FieldDescription>Every job you add gets a match analysis without asking.</FieldDescription>
            </div>
          </Field>
        </FieldGroup>
      )}
      <StepActions>
        <Button variant="ghost" onClick={onBack} disabled={saving}>
          <ArrowLeft /> Back
        </Button>
        <Button onClick={() => void save()} disabled={saving || settings.isPending || settings.isError}>
          {saving ? <Loader2 className="animate-spin" /> : null}
          Save and continue
        </Button>
      </StepActions>
    </>
  );
}

function JobsStep({ onBack, onFinish }: { onBack: () => void; onFinish: (to: string) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const count = extractHttpUrlsFromText(text).length;

  const submit = async () => {
    setBusy(true);
    const ok = await submitJobUrls(text);
    setBusy(false);
    if (ok) onFinish('/app/jobs');
  };

  return (
    <>
      <StepHeader
        title="Add your first jobs"
        description="Paste links to postings you're interested in. NAO extracts each one, scores it against your profile, and prepares documents."
      />
      <Field>
        <FieldLabel htmlFor="onb-links">Job links</FieldLabel>
        <Textarea
          id="onb-links"
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && count > 0) void submit();
          }}
          placeholder={'https://boards.greenhouse.io/company/jobs/123\nhttps://jobs.lever.co/company/abc'}
        />
        <FieldDescription>
          <Link2 className="mr-1 inline size-3.5" />
          {count > 0 ? `${count} link${count === 1 ? '' : 's'} detected` : 'One or more links, any format'}
        </FieldDescription>
      </Field>
      <button
        type="button"
        onClick={() => onFinish('/app/integrations')}
        className="mt-4 flex w-full items-center gap-3 rounded-xl border p-4 text-left transition-colors hover:bg-muted/50"
      >
        <div className="flex size-9 items-center justify-center rounded-lg bg-muted">
          <Puzzle className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Connect a job site instead</p>
          <p className="text-xs text-muted-foreground">Pull new listings automatically from boards like Remote OK or Adzuna.</p>
        </div>
        <ArrowRight className="size-4 text-muted-foreground" />
      </button>
      <StepActions>
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          <ArrowLeft /> Back
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => onFinish('/app')} disabled={busy}>
            Finish
          </Button>
          <Button onClick={() => void submit()} disabled={busy || count === 0}>
            {busy ? <Loader2 className="animate-spin" /> : <Check />}
            {count > 0 ? `Add ${count} job${count === 1 ? '' : 's'}` : 'Add jobs'}
          </Button>
        </div>
      </StepActions>
    </>
  );
}
