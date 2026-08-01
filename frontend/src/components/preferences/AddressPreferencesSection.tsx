import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, MapPin, Plus, X } from 'lucide-react';
import { SettingsCard } from '../settings/SettingsCard';
import { prefsSaveBtnClass } from '../settings/prefsSaveButtonClass';
import { BrandedLoader } from '../layout/BrandedLoader';
import { fetchProfileForm, saveUserProfile } from '../../api/profileApi';
import type { AddressInfo, ProfileFormData } from '../../types/profile';
import { emptyAddress } from '../../utils/profileFormData';

const MAX_LOCAL_PREFS = 30;
const MAX_PREF_LEN = 120;

const ADDRESS_FIELDS: Array<{
  key: keyof AddressInfo;
  label: string;
  placeholder?: string;
  autoComplete?: string;
  span?: string;
}> = [
  {
    key: 'line1',
    label: 'Legal address line 1',
    placeholder: '123 Main St',
    autoComplete: 'address-line1',
    span: 'col-span-1 sm:col-span-2',
  },
  {
    key: 'line2',
    label: 'Legal address line 2',
    placeholder: 'Apt, suite, unit (optional)',
    autoComplete: 'address-line2',
    span: 'col-span-1 sm:col-span-2',
  },
  { key: 'city', label: 'City', placeholder: 'San Francisco', autoComplete: 'address-level2', span: 'col-span-1' },
  {
    key: 'state',
    label: 'State / Province',
    placeholder: 'California',
    autoComplete: 'address-level1',
    span: 'col-span-1',
  },
  {
    key: 'postal_code',
    label: 'Postal code',
    placeholder: '94105',
    autoComplete: 'postal-code',
    span: 'col-span-1',
  },
  {
    key: 'country',
    label: 'Country',
    placeholder: 'United States of America',
    autoComplete: 'country-name',
    span: 'col-span-1',
  },
];

function errDetail(e: unknown, fallback: string): string {
  const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
  return typeof msg === 'string' ? msg : fallback;
}

function normalizePrefs(list: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list ?? []) {
    const text = raw.trim().slice(0, MAX_PREF_LEN);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= MAX_LOCAL_PREFS) break;
  }
  return out;
}

export function AddressPreferencesSection() {
  const [baseForm, setBaseForm] = useState<ProfileFormData | null>(null);
  const [address, setAddress] = useState<AddressInfo>(emptyAddress());
  const [prefDraft, setPrefDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const form = await fetchProfileForm();
      setBaseForm(form);
      setAddress(form.address ?? emptyAddress());
    } catch (e: unknown) {
      setMsg({ ok: false, text: errDetail(e, 'Failed to load location preferences') });
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
    JSON.stringify({
      ...address,
      local_preferences: normalizePrefs(address.local_preferences),
    }) !==
      JSON.stringify({
        ...(baseForm.address ?? emptyAddress()),
        local_preferences: normalizePrefs(baseForm.address?.local_preferences),
      });

  const localPrefs = normalizePrefs(address.local_preferences);

  const addPreference = () => {
    const next = normalizePrefs([...localPrefs, prefDraft]);
    if (next.length === localPrefs.length && prefDraft.trim()) {
      setMsg({ ok: false, text: 'That location is already in your list.' });
      return;
    }
    if (localPrefs.length >= MAX_LOCAL_PREFS && prefDraft.trim()) {
      setMsg({ ok: false, text: `You can add at most ${MAX_LOCAL_PREFS} local preferences.` });
      return;
    }
    setAddress((s) => ({ ...s, local_preferences: next }));
    setPrefDraft('');
  };

  const removePreference = (value: string) => {
    setAddress((s) => ({
      ...s,
      local_preferences: normalizePrefs(s.local_preferences).filter((p) => p !== value),
    }));
  };

  const handleSave = async () => {
    if (!baseForm || !dirty) return;
    setSaving(true);
    setMsg(null);
    try {
      const nextAddress: AddressInfo = {
        ...address,
        local_preferences: normalizePrefs(address.local_preferences),
      };
      const next = { ...baseForm, address: nextAddress };
      await saveUserProfile(next);
      const form = await fetchProfileForm();
      setBaseForm(form);
      setAddress(form.address ?? emptyAddress());
      setMsg({ ok: true, text: 'Location preferences saved.' });
    } catch (e: unknown) {
      setMsg({ ok: false, text: errDetail(e, 'Failed to save location preferences') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      icon={MapPin}
      iconClass="bg-gradient-to-br from-teal-500 to-emerald-600"
      title="Location preferences"
      description="Your legal / home address for application autofill, plus preferred job locales."
      className="!p-3 sm:!p-3.5 h-full"
      actions={
        <button
          type="button"
          disabled={!dirty || saving || loading}
          onClick={() => void handleSave()}
          className={prefsSaveBtnClass(dirty && !loading)}
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : null}
          {saving ? 'Saving…' : 'Save'}
        </button>
      }
    >
      {loading ? (
        <BrandedLoader compact label="Loading…" />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Legal address
            </p>
            <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
              {ADDRESS_FIELDS.map((f) => (
                <label key={f.key} className={`flex w-full min-w-0 flex-col gap-1 ${f.span ?? ''}`}>
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    {f.label}
                  </span>
                  <input
                    value={(address[f.key] as string | null | undefined) ?? ''}
                    onChange={(e) => setAddress((s) => ({ ...s, [f.key]: e.target.value }))}
                    placeholder={f.placeholder}
                    autoComplete={f.autoComplete}
                    title={(address[f.key] as string) || f.placeholder}
                    className="h-8 w-full min-w-0 rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-white/10 dark:bg-[#0f172a]"
                  />
                </label>
              ))}
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-1.5 border-t border-slate-100 pt-3 dark:border-white/10">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                Local preferences for a job
              </p>
              <span className="text-[10px] tabular-nums text-slate-400">
                {localPrefs.length}/{MAX_LOCAL_PREFS}
              </span>
            </div>
            <p className="text-[11px] leading-snug text-slate-500 dark:text-slate-400">
              Regions or cities you prefer for roles (e.g. Bay Area, Remote US, Seattle metro).
            </p>

            <div className="flex gap-1.5">
              <input
                value={prefDraft}
                onChange={(e) => setPrefDraft(e.target.value.slice(0, MAX_PREF_LEN))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addPreference();
                  }
                }}
                placeholder="Add a preferred location…"
                className="h-8 min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-white/10 dark:bg-[#0f172a]"
              />
              <button
                type="button"
                onClick={addPreference}
                disabled={!prefDraft.trim() || localPrefs.length >= MAX_LOCAL_PREFS}
                className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-teal-200 bg-teal-50 px-2.5 text-xs font-semibold text-teal-800 transition hover:bg-teal-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-teal-500/30 dark:bg-teal-500/10 dark:text-teal-200"
              >
                <Plus size={13} />
                Add
              </button>
            </div>

            <div className="min-h-[7.5rem] flex-1 rounded-md border border-dashed border-slate-200 bg-slate-50/70 p-2 dark:border-white/10 dark:bg-[#0b1220]/60">
              {localPrefs.length === 0 ? (
                <p className="px-1 py-3 text-center text-[11px] text-slate-400">
                  No local preferences yet. Add cities, regions, or remote preferences.
                </p>
              ) : (
                <ul className="flex flex-wrap content-start gap-1.5">
                  {localPrefs.map((pref) => (
                    <li
                      key={pref}
                      className="inline-flex max-w-full items-center gap-1 rounded-full border border-teal-200 bg-white py-0.5 pl-2.5 pr-1 text-xs font-medium text-teal-900 dark:border-teal-500/30 dark:bg-teal-500/10 dark:text-teal-100"
                    >
                      <span className="truncate">{pref}</span>
                      <button
                        type="button"
                        onClick={() => removePreference(pref)}
                        title={`Remove ${pref}`}
                        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-teal-700 transition hover:bg-teal-100 dark:text-teal-200 dark:hover:bg-teal-500/20"
                      >
                        <X size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
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
