import { useState, useEffect, useMemo } from 'react';
import { UserCircle2, AlertCircle, CheckCircle2, ListChecks, CircleMinus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { apiClient } from '../../api/client';
import { ProfileForm } from './ProfileForm';
import { ResumeImportSection } from './ResumeImportSection';
import { PageHeader } from '../layout/PageHeader';
import { PageScrollArea } from '../layout/PageScrollArea';
import { BrandedLoader } from '../layout/BrandedLoader';
import type { UserProfile } from '../../types/profile';
import type { ProfileFormData } from '../../types/profile';
import { computeProfileCompletion } from '../../utils/profileCompletion';
import { formatProfileValidationSummary } from '../../utils/profileValidation';
import { profileFormToPayload } from '../../utils/profilePayload';

type Props = {
  onBack: () => void;
  userEmail?: string | null;
  /** Called after a successful save so the app can refresh the sidebar name. */
  onProfileSaved?: () => void | Promise<unknown>;
};

function ProfileFormSkeleton() {
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      {[1, 2, 3, 4, 5, 6].map((n) => (
        <div
          key={n}
          className={`h-40 rounded-2xl border border-slate-200 bg-slate-100/80 animate-pulse ${n >= 3 ? 'xl:col-span-2' : ''}`}
        />
      ))}
    </div>
  );
}

export function ProfilesManagementPage({ userEmail, onProfileSaved }: Props) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saveOk, setSaveOk] = useState(false);

  useEffect(() => {
    const fetchProfile = async () => {
      try {
        setLoading(true);
        setError('');
        const res = await apiClient.get<UserProfile>('/profile');
        setProfile(res.data ?? null);
      } catch (err: unknown) {
        const status = err && typeof err === 'object' && 'response' in err ? (err as { response?: { status?: number } }).response?.status : undefined;
        if (status === 404) {
          setProfile(null);
        } else {
          const detail =
            err && typeof err === 'object' && 'response' in err
              ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
              : undefined;
          setError(typeof detail === 'string' ? detail : 'Failed to load profile');
        }
      } finally {
        setLoading(false);
      }
    };
    void fetchProfile();
  }, []);

  useEffect(() => {
    if (!saveOk) return;
    const t = window.setTimeout(() => setSaveOk(false), 3500);
    return () => window.clearTimeout(t);
  }, [saveOk]);

  const completion = useMemo(() => computeProfileCompletion(profile), [profile]);

  const [importDraft, setImportDraft] = useState<ProfileFormData | null>(null);
  const [importErrors, setImportErrors] = useState<Record<string, string>>({});

  const handleSubmit = async (data: ProfileFormData) => {
    try {
      setError('');
      setSaveOk(false);
      const res = await apiClient.put<UserProfile>('/profile', profileFormToPayload(data));
      setProfile(res.data);
      setSaveOk(true);
      // Refresh the authenticated user so the sidebar name/avatar reflect the
      // just-saved profile name without requiring a page reload.
      void onProfileSaved?.();
    } catch (err: unknown) {
      let msg = 'Failed to save profile';
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'ERR_NETWORK') {
        msg = 'Network error. Is the server running?';
      } else if (err && typeof err === 'object' && 'response' in err) {
        const r = err as { response?: { data?: { detail?: unknown } } };
        const detail = r.response?.data?.detail;
        if (typeof detail === 'string') msg = detail;
        else if (Array.isArray(detail) && detail.length > 0) {
          msg = detail.map((d: { msg?: string }) => d.msg || JSON.stringify(d)).join('; ');
        }
      }
      setError(msg);
      throw err instanceof Error ? err : new Error(msg);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <BrandedLoader label="Loading your profile…" className="min-h-[60vh]" />
      </div>
    );
  }

  return (
    <PageScrollArea>
      <div className="w-full space-y-4 px-3 py-4 sm:space-y-5 sm:px-5 sm:py-5">
        <PageHeader
          icon={UserCircle2}
          gradient="from-blue-600 to-indigo-600"
          title="Your profile"
          description="Structured profile data powers match summaries, dimension scores, and gap analysis when you run job fit checks."
        />

        {/* Row 1 - overview + import */}
        <section className="space-y-5" aria-label="Profile overview">
          <div className="grid gap-5 xl:grid-cols-2">
              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:p-5">
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white">
                    <ListChecks className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="text-sm font-bold text-slate-900">Profile strength</h2>
                    <p className="mt-0.5 text-xs leading-snug text-slate-500">
                      How complete your saved profile is for AI matching.
                    </p>

                    {!loading ? (
                      <div className="mt-4 border-t border-slate-200 pt-4">
                        <div className="flex flex-wrap items-end justify-between gap-2">
                          <p className="text-sm text-slate-700">
                            <span className="font-semibold text-slate-900">
                              {completion.requiredFilled} of {completion.requiredTotal} core areas
                            </span>{' '}
                            complete from your last save
                          </p>
                          <p
                            className="text-2xl font-bold tabular-nums leading-none text-blue-800"
                            aria-live="polite"
                            aria-atomic="true"
                          >
                            {completion.requiredPercent}%
                          </p>
                        </div>
                        <div
                          className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-slate-200"
                          role="progressbar"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={completion.requiredPercent}
                          aria-label={`Profile completion ${completion.requiredPercent} percent`}
                        >
                          <div
                            className="h-full rounded-full bg-blue-600"
                            style={{ width: `${completion.requiredPercent}%` }}
                          />
                        </div>

                        {completion.missingRequired.length > 0 ? (
                          <div className="mt-4">
                            <p className="text-xs font-bold uppercase tracking-wide text-rose-700/90">Still needed for a complete profile</p>
                            <ul className="mt-2 space-y-1.5 text-sm text-slate-700">
                              {completion.missingRequired.map((item) => (
                                <li key={item.id} className="flex gap-2">
                                  <CircleMinus className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" aria-hidden />
                                  <span>{item.label}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : (
                          <p className="mt-4 flex items-center gap-2 text-sm font-semibold text-emerald-800">
                            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
                            Core profile is complete. Add optional items below to enrich matches.
                          </p>
                        )}

                        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
                          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Optional - nice to add</p>
                          <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
                            {completion.optionalItems.map((item) => (
                              <li key={item.id} className="flex items-center gap-2 text-xs font-medium text-slate-600">
                                {item.done ? (
                                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden />
                                ) : (
                                  <span className="inline-block h-3.5 w-3.5 shrink-0 rounded-full border border-slate-300" aria-hidden />
                                )}
                                <span className={item.done ? 'text-slate-800' : ''}>{item.label}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-5 space-y-3 border-t border-slate-200 pt-5">
                        <div className="h-16 rounded-xl bg-slate-100/80 animate-pulse" />
                        <div className="h-24 rounded-xl bg-slate-100/80 animate-pulse" />
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {loading ? (
                <div className="h-full min-h-[220px] rounded-2xl border border-slate-200 bg-slate-100/80 animate-pulse" />
              ) : (
                <ResumeImportSection
                  profile={profile}
                  accountEmail={userEmail ?? undefined}
                  applyProfile={handleSubmit}
                  onDraftToForm={(data, errors) => {
                    setImportDraft(data);
                    setImportErrors(errors);
                    setError(formatProfileValidationSummary(errors));
                  }}
                />
              )}
            </div>

            {!loading && (
              <p className="text-xs text-slate-500">
                API keys, match scoring, EEO, and address are in{' '}
                <Link to="/preferences" className="font-medium text-blue-600 hover:text-blue-800">
                  My Preferences
                </Link>
                .
              </p>
            )}

            {saveOk && (
              <div
                className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-900"
                role="status"
              >
                <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
                Profile saved successfully.
              </div>
            )}

            {error && (
              <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-900">
                <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" />
                <span>{error}</span>
              </div>
            )}
          </section>

          {/* Row 2 - editable profile sections */}
          <section aria-label="Profile details">
            <div className="mb-3 border-b border-slate-200 pb-2.5">
              <h2 className="text-base font-bold text-slate-900">Profile details</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Edit each section and save independently. All fields are used for AI matching.
              </p>
            </div>

            {loading ? (
              <ProfileFormSkeleton />
            ) : (
              <ProfileForm
                profile={profile}
                onSubmit={handleSubmit}
                importDraft={importDraft}
                importErrors={importErrors}
                onImportDraftApplied={() => {
                  setImportDraft(null);
                  setImportErrors({});
                }}
              />
            )}
          </section>
      </div>
    </PageScrollArea>
  );
}

export default ProfilesManagementPage;
