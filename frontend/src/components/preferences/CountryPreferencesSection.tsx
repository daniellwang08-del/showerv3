import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Globe2, Loader2, X } from 'lucide-react';
import { saveCountryPreferences } from '../../api/settingsApi';
import type { UserSettings } from '../../types/settings';
import { SettingsCard } from '../settings/SettingsCard';
import { prefsSaveBtnClass } from '../settings/prefsSaveButtonClass';
import { useJobsStore } from '../../stores/jobsStore';
import { useScraperStore } from '../../stores/scraperStore';
import { input, mutedText, sectionAccents } from '../../ui/tokens';

const SOURCE_LABELS: Record<UserSettings['country_preferences_source'], string> = {
  unset: 'Not set — add countries or parse your resume to auto-detect.',
  auto: 'Auto-detected from your resume. Editing here makes it manual.',
  manual: 'Set manually. Resume parsing will not overwrite this.',
};

export function CountryPreferencesSection({
  settings,
  onSaved,
}: {
  settings: UserSettings;
  onSaved: (next: UserSettings) => void;
}) {
  const [selected, setSelected] = useState<string[]>(settings.country_preferences);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [ok, setOk] = useState(false);

  useEffect(() => {
    setSelected(settings.country_preferences);
  }, [settings.country_preferences]);

  useEffect(() => {
    if (!ok) return;
    const t = window.setTimeout(() => {
      setOk(false);
      setMsg('');
    }, 4000);
    return () => window.clearTimeout(t);
  }, [ok]);

  const nameByCode = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of settings.available_countries) map.set(c.code, c.name);
    return map;
  }, [settings.available_countries]);

  const addable = useMemo(
    () => settings.available_countries.filter((c) => !selected.includes(c.code)),
    [settings.available_countries, selected],
  );

  const changed =
    selected.length !== settings.country_preferences.length ||
    selected.some((code, i) => settings.country_preferences[i] !== code);

  const handleAdd = (code: string) => {
    if (!code || selected.includes(code)) return;
    setSelected((prev) => [...prev, code]);
    setMsg('');
  };

  const handleRemove = (code: string) => {
    setSelected((prev) => prev.filter((c) => c !== code));
    setMsg('');
  };

  const handleSave = async () => {
    if (!changed || saving) return;
    setSaving(true);
    setMsg('');
    try {
      const data = await saveCountryPreferences(selected);
      onSaved(data);
      setOk(true);
      setMsg(
        selected.length
          ? 'Country preferences saved. Existing jobs are being re-checked in the background.'
          : 'Location filtering disabled — jobs from all countries stay visible.',
      );
      // Reconcile runs server-side; refresh lists shortly so moves show up.
      window.setTimeout(() => {
        void useJobsStore.getState().refreshLists({ showLoading: false, reset: true });
        void useScraperStore.getState().loadJobs();
      }, 1500);
    } catch (err: unknown) {
      setOk(false);
      const detail =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : null;
      setMsg(typeof detail === 'string' ? detail : 'Failed to save country preferences.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      icon={Globe2}
      iconClass={sectionAccents.sky}
      title="Job countries"
      description="Jobs with locations outside these countries are hidden automatically. Leave empty to see jobs from anywhere."
    >
      <div className="space-y-3">
        <p className={`text-xs ${mutedText}`}>
          {SOURCE_LABELS[settings.country_preferences_source]}
        </p>

        <div className="flex flex-wrap items-center gap-1.5">
          {selected.length === 0 ? (
            <span className={`rounded-xl border border-dashed border-slate-300 px-2.5 py-1.5 text-xs font-medium ${mutedText}`}>
              No filter — worldwide
            </span>
          ) : (
            selected.map((code) => (
              <span
                key={code}
                className="inline-flex items-center gap-1 rounded-xl border border-sky-200 bg-sky-50 px-2 py-1 text-xs font-semibold text-sky-900 dark:border-sky-400/40 dark:bg-sky-500/15 dark:text-sky-200"
              >
                {nameByCode.get(code) ?? code}
                <button
                  type="button"
                  onClick={() => handleRemove(code)}
                  disabled={saving}
                  aria-label={`Remove ${nameByCode.get(code) ?? code}`}
                  className="rounded p-0.5 text-sky-700 transition hover:bg-sky-100 hover:text-sky-900 disabled:opacity-50 dark:text-sky-300 dark:hover:bg-sky-500/20"
                >
                  <X size={12} />
                </button>
              </span>
            ))
          )}
        </div>

        <div className="flex items-center gap-2">
          <select
            value=""
            onChange={(e) => handleAdd(e.target.value)}
            disabled={saving || addable.length === 0}
            className={`max-w-xs ${input}`}
          >
            <option value="" disabled>
              Add a country…
            </option>
            {addable.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!changed || saving}
            className={`ml-auto ${prefsSaveBtnClass(changed)}`}
          >
            {saving ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 size={14} className="animate-spin" />
                Saving…
              </span>
            ) : (
              'Save'
            )}
          </button>
        </div>

        {msg ? (
          <p
            className={`flex items-center gap-1.5 text-sm font-medium ${
              ok ? 'text-emerald-700' : 'text-rose-700'
            }`}
          >
            {ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
            {msg}
          </p>
        ) : null}
      </div>
    </SettingsCard>
  );
}
