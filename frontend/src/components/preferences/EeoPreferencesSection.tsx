import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';
import { SettingsCard } from '../settings/SettingsCard';
import { BrandedLoader } from '../layout/BrandedLoader';
import { fetchProfileForm, saveUserProfile } from '../../api/profileApi';
import type { EEOPreferences, ProfileFormData } from '../../types/profile';
import { GENDER_OPTIONS, RACE_OPTIONS } from '../../types/profile';
import { emptyEEO } from '../../utils/profileFormData';

const EEO_YESNO_FIELDS: Array<{
  key: keyof EEOPreferences;
  label: string;
  yesLabel?: string;
  noLabel?: string;
}> = [
  { key: 'hispanic_latino', label: 'Hispanic or Latino' },
  { key: 'veteran_status', label: 'Protected veteran', yesLabel: 'I am a veteran', noLabel: 'Not a veteran' },
  {
    key: 'disability_status',
    label: 'Disability status',
    yesLabel: 'Have a disability',
    noLabel: 'No disability',
  },
  { key: 'work_authorized', label: 'Authorized to work in the country' },
  { key: 'needs_sponsorship', label: 'Require visa sponsorship' },
];

/** Compact full-width 3-way control — equal columns, short hit area. */
function TriStateToggle({
  value,
  onChange,
  yesLabel = 'Yes',
  noLabel = 'No',
}: {
  value: boolean | null | undefined;
  onChange: (v: boolean | null) => void;
  yesLabel?: string;
  noLabel?: string;
}) {
  const opts: Array<{ v: boolean | null; label: string }> = [
    { v: true, label: yesLabel },
    { v: false, label: noLabel },
    { v: null, label: 'Unspecified' },
  ];
  const current = value ?? null;
  return (
    <div className="flex w-full rounded-md border border-slate-200 bg-slate-50 p-px dark:border-white/10 dark:bg-[#0b1220]">
      {opts.map((o) => {
        const active = current === o.v;
        return (
          <button
            key={String(o.v)}
            type="button"
            onClick={() => onChange(o.v)}
            className={`min-h-7 min-w-0 flex-1 rounded px-1.5 py-1 text-center text-[11px] font-semibold leading-tight transition sm:text-xs ${
              active
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-600 hover:bg-white dark:hover:bg-white/5'
            }`}
          >
            <span className="block whitespace-normal break-words">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function errDetail(e: unknown, fallback: string): string {
  const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
  return typeof msg === 'string' ? msg : fallback;
}

export function EeoPreferencesSection() {
  const [baseForm, setBaseForm] = useState<ProfileFormData | null>(null);
  const [eeo, setEeo] = useState<EEOPreferences>(emptyEEO());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const form = await fetchProfileForm();
      setBaseForm(form);
      setEeo(form.eeo_preferences ?? emptyEEO());
    } catch (e: unknown) {
      setMsg({ ok: false, text: errDetail(e, 'Failed to load EEO preferences') });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!msg?.ok) return;
    const t = window.setTimeout(() => setMsg(null), 3000);
    return () => window.clearTimeout(t);
  }, [msg]);

  const dirty =
    baseForm != null &&
    JSON.stringify(eeo) !== JSON.stringify(baseForm.eeo_preferences ?? emptyEEO());

  const handleSave = async () => {
    if (!baseForm || !dirty) return;
    setSaving(true);
    setMsg(null);
    try {
      const next = { ...baseForm, eeo_preferences: eeo };
      const saved = await saveUserProfile(next);
      const form = await fetchProfileForm();
      setBaseForm(form);
      setEeo(form.eeo_preferences ?? emptyEEO());
      void saved;
      setMsg({ ok: true, text: 'EEO preferences saved.' });
    } catch (e: unknown) {
      setMsg({ ok: false, text: errDetail(e, 'Failed to save EEO preferences') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      icon={ShieldCheck}
      iconClass="bg-gradient-to-br from-sky-500 to-blue-600"
      title="EEO / demographics"
      description="Voluntary answers used to auto-fill application forms (e.g. Workday). Leave Unspecified to skip."
      className="!p-3 sm:!p-3.5"
      actions={
        <button
          type="button"
          disabled={!dirty || saving || loading}
          onClick={() => void handleSave()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : null}
          {saving ? 'Saving…' : 'Save'}
        </button>
      }
    >
      {loading ? (
        <BrandedLoader compact label="Loading…" />
      ) : (
        <div className="flex w-full flex-col gap-2">
          <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="flex w-full min-w-0 flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                Gender
              </span>
              <select
                value={eeo.gender ?? ''}
                onChange={(e) => setEeo((s) => ({ ...s, gender: e.target.value }))}
                className="h-8 w-full min-w-0 rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-white/10 dark:bg-[#0f172a]"
              >
                <option value="">Unspecified</option>
                {GENDER_OPTIONS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex w-full min-w-0 flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                Race / Ethnicity
              </span>
              <select
                value={eeo.race ?? ''}
                onChange={(e) => setEeo((s) => ({ ...s, race: e.target.value }))}
                className="h-8 w-full min-w-0 rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-white/10 dark:bg-[#0f172a]"
              >
                <option value="">Unspecified</option>
                {RACE_OPTIONS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {EEO_YESNO_FIELDS.map((f) => (
            <div key={f.key} className="flex w-full min-w-0 flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                {f.label}
              </span>
              <TriStateToggle
                value={eeo[f.key] as boolean | null | undefined}
                onChange={(v) => setEeo((s) => ({ ...s, [f.key]: v }))}
                yesLabel={f.yesLabel}
                noLabel={f.noLabel}
              />
            </div>
          ))}
        </div>
      )}
      {msg ? (
        <p
          className={`mt-2 flex items-center gap-1.5 text-xs font-medium ${
            msg.ok ? 'text-emerald-700' : 'text-rose-700'
          }`}
        >
          {msg.ok ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
          {msg.text}
        </p>
      ) : null}
    </SettingsCard>
  );
}
