import { Link } from 'react-router-dom';
import { COUNTRY_CODES } from '@/constants/countryCodes';
import type { ProfileFormData } from '@/types/profile';
import { CountryCodePicker, EmptyValue, TextField, ViewRow } from './fields';
import type { EditorProps } from './profileSections';

function ExternalLink({ href }: { href: string }) {
  const url = /^https?:\/\//i.test(href) ? href : `https://${href}`;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="text-brand underline-offset-4 hover:underline">
      {href.replace(/^https?:\/\/(www\.)?/i, '')}
    </a>
  );
}

export function PreferencesHint() {
  return (
    <p className="text-sm text-muted-foreground">
      EEO and address live in{' '}
      <Link to="/app/preferences" className="text-brand underline-offset-4 hover:underline">
        Preferences
      </Link>
      .
    </p>
  );
}

export function BasicsView({ form }: { form: ProfileFormData }) {
  const name = [form.name_first, form.name_middle, form.name_last].map((s) => s.trim()).filter(Boolean).join(' ');
  const country = COUNTRY_CODES.find((c) => c.code === form.phone_country_code);
  return (
    <div className="flex flex-col gap-4">
      <dl className="flex flex-col gap-2.5 text-sm">
        <ViewRow label="Name">{name || <EmptyValue />}</ViewRow>
        <ViewRow label="Title">{form.title.trim() || <EmptyValue />}</ViewRow>
        <ViewRow label="Email">{form.email.trim() || <EmptyValue />}</ViewRow>
        <ViewRow label="Phone">
          {form.phone_number.trim() ? (
            <span className="tabular-nums">
              {form.phone_country_code} {form.phone_number}
              {country ? <span className="text-muted-foreground"> · {country.country}</span> : null}
            </span>
          ) : (
            <EmptyValue />
          )}
        </ViewRow>
        <ViewRow label="LinkedIn">
          {form.linkedin_url.trim() ? <ExternalLink href={form.linkedin_url.trim()} /> : <EmptyValue />}
        </ViewRow>
        <ViewRow label="GitHub">
          {form.github_url.trim() ? <ExternalLink href={form.github_url.trim()} /> : <EmptyValue>Optional</EmptyValue>}
        </ViewRow>
      </dl>
      <PreferencesHint />
    </div>
  );
}

export function BasicsEdit({ form, update, err, touch }: EditorProps) {
  const text = (key: keyof ProfileFormData & string) => ({
    id: `profile-${key}`,
    value: String(form[key] ?? ''),
    onChange: (v: string) => update({ [key]: v } as Partial<ProfileFormData>),
    onBlur: () => touch(key),
    error: err(key),
  });
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField {...text('name_first')} label="First name" required autoComplete="given-name" />
        <TextField {...text('name_middle')} label="Middle name" autoComplete="additional-name" />
        <TextField {...text('name_last')} label="Last name" required autoComplete="family-name" />
      </div>
      <TextField
        {...text('title')}
        label="Professional title"
        required
        placeholder="e.g. Senior Software Engineer"
        autoComplete="organization-title"
      />
      <TextField {...text('email')} label="Email" required type="email" autoComplete="email" />
      <div className="grid gap-4 sm:grid-cols-[14rem_1fr]">
        <CountryCodePicker
          id="profile-phone_country_code"
          value={form.phone_country_code}
          onChange={(v) => {
            update({ phone_country_code: v });
            touch('phone_number');
          }}
          error={err('phone_country_code')}
        />
        <TextField
          {...text('phone_number')}
          label="Phone number"
          required
          type="tel"
          autoComplete="tel-national"
          description={
            form.phone_country_code.replace(/\D/g, '') === '1' ? '10 digits, e.g. (610) 234-7936' : '8–15 digits'
          }
        />
      </div>
      <TextField
        {...text('linkedin_url')}
        label="LinkedIn URL"
        required
        type="url"
        placeholder="https://www.linkedin.com/in/your-name"
      />
      <TextField {...text('github_url')} label="GitHub URL" type="url" placeholder="https://github.com/your-handle" />
      <PreferencesHint />
    </div>
  );
}

export function SummaryView({ form }: { form: ProfileFormData }) {
  const s = form.profile_summary.trim();
  if (!s) return <EmptyValue>No summary yet.</EmptyValue>;
  return <p className="text-sm leading-relaxed whitespace-pre-line">{s}</p>;
}

export function SummaryEdit({ form, update, err, touch }: EditorProps) {
  return (
    <TextField
      id="profile-profile_summary"
      label="Profile summary"
      required
      multiline
      rows={6}
      maxLength={5000}
      value={form.profile_summary}
      onChange={(v) => update({ profile_summary: v })}
      onBlur={() => touch('profile_summary')}
      error={err('profile_summary')}
      placeholder="Two or three sentences on what you do, your strengths, and the roles you want."
    />
  );
}
