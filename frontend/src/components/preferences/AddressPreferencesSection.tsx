import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, MapPin } from 'lucide-react';
import { SettingsCard } from '../settings/SettingsCard';
import { prefsSaveBtnClass } from '../settings/prefsSaveButtonClass';
import { BrandedLoader } from '../layout/BrandedLoader';
import { fetchProfileForm, saveUserProfile } from '../../api/profileApi';
import type { AddressInfo, ProfileFormData } from '../../types/profile';
import { emptyAddress } from '../../utils/profileFormData';

const ADDRESS_FIELDS: Array<{
  key: keyof AddressInfo;
  label: string;
  placeholder?: string;
  autoComplete?: string;
  /** Tailwind col-span classes for the field within the address grid. */
  span?: string;
}> = [
  {
    key: 'line1',
    label: 'Address line 1',
    placeholder: '123 Main St',
    autoComplete: 'address-line1',
    span: 'col-span-1 sm:col-span-2',
  },
  {
    key: 'line2',
    label: 'Address line 2',
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

export function AddressPreferencesSection() {
  const [baseForm, setBaseForm] = useState<ProfileFormData | null>(null);
  const [address, setAddress] = useState<AddressInfo>(emptyAddress());
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
      setMsg({ ok: false, text: errDetail(e, 'Failed to load address') });
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
    JSON.stringify(address) !== JSON.stringify(baseForm.address ?? emptyAddress());

  const handleSave = async () => {
    if (!baseForm || !dirty) return;
    setSaving(true);
    setMsg(null);
    try {
      const next = { ...baseForm, address };
      await saveUserProfile(next);
      const form = await fetchProfileForm();
      setBaseForm(form);
      setAddress(form.address ?? emptyAddress());
      setMsg({ ok: true, text: 'Address saved.' });
    } catch (e: unknown) {
      setMsg({ ok: false, text: errDetail(e, 'Failed to save address') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      icon={MapPin}
      iconClass="bg-gradient-to-br from-teal-500 to-emerald-600"
      title="Mailing address"
      description="Used to auto-fill Address / City / State / Postal Code on application forms."
      className="!p-3 sm:!p-3.5"
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
        <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
          {ADDRESS_FIELDS.map((f) => (
            <label key={f.key} className={`flex w-full min-w-0 flex-col gap-1 ${f.span ?? ''}`}>
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                {f.label}
              </span>
              <input
                value={address[f.key] ?? ''}
                onChange={(e) => setAddress((s) => ({ ...s, [f.key]: e.target.value }))}
                placeholder={f.placeholder}
                autoComplete={f.autoComplete}
                title={address[f.key] || f.placeholder}
                className="h-8 w-full min-w-0 rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-white/10 dark:bg-[#0f172a]"
              />
            </label>
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
