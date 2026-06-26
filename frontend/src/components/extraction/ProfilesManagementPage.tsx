import { useState, useEffect, useMemo } from 'react';
import { UserCircle2, AlertCircle, CheckCircle2, ListChecks, CircleMinus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { apiClient } from '../../api/client';
import { ProfileForm } from './ProfileForm';
import { ResumeImportSection } from './ResumeImportSection';
import type { UserProfile } from '../../types/profile';
import type { ProfileFormData } from '../../types/profile';
import { computeProfileCompletion } from '../../utils/profileCompletion';

type Props = {
  onBack: () => void;
  userEmail?: string | null;
};

function toPayload(data: ProfileFormData) {
  const emptyToNull = (s: string | undefined) => (s?.trim() ? s.trim() : null);
  return {
    name_first: data.name_first.trim(),
    name_middle: emptyToNull(data.name_middle),
    name_last: data.name_last.trim(),
    title: data.title.trim(),
    email: data.email.trim(),
    phone_country_code: data.phone_country_code,
    phone_number: data.phone_number.trim(),
    linkedin_url: data.linkedin_url.trim(),
    github_url: emptyToNull(data.github_url),
    profile_summary: data.profile_summary.trim(),
    technical_skills: data.technical_skills
      .filter((t) => t.category.trim() && t.skills.trim())
      .map((t) => ({ category: t.category.trim(), skills: t.skills.trim() })),
    work_experience: data.work_experience
      .filter((w) => w.company_name.trim() && w.job_title.trim())
      .map((w) => ({
      company_name: w.company_name.trim(),
      job_title: w.job_title.trim(),
      period_start: emptyToNull(w.period_start),
      period_end: emptyToNull(w.period_end),
      location: emptyToNull(w.location),
      job_type: emptyToNull(w.job_type) || null,
      employment_type: emptyToNull(w.employment_type) || null,
      project_title: emptyToNull(w.project_title),
      project_intro: emptyToNull(w.project_intro),
      contributions: (w.contributions ?? []).map((c) => c.trim()).filter(Boolean),
      used_skills: emptyToNull(w.used_skills),
      description: emptyToNull(w.description),
    })),
    education: data.education
      .filter((e) => e.university_name.trim() && e.degree.trim())
      .map((e) => ({
      university_name: e.university_name.trim(),
      degree: e.degree.trim(),
      mark: emptyToNull(e.mark),
      period_start: emptyToNull(e.period_start),
      period_end: emptyToNull(e.period_end),
      location: emptyToNull(e.location),
      description: emptyToNull(e.description),
    })),
    certificates: data.certificates
      .filter((c) => c.name.trim())
      .map((c) => ({ name: c.name.trim() })),
    extra: data.extra.filter((x) => x.trim()),
    eeo_preferences: {
      gender: emptyToNull(data.eeo_preferences.gender ?? undefined),
      race: emptyToNull(data.eeo_preferences.race ?? undefined),
      hispanic_latino: data.eeo_preferences.hispanic_latino ?? null,
      veteran_status: data.eeo_preferences.veteran_status ?? null,
      disability_status: data.eeo_preferences.disability_status ?? null,
      work_authorized: data.eeo_preferences.work_authorized ?? null,
      needs_sponsorship: data.eeo_preferences.needs_sponsorship ?? null,
    },
    address: {
      line1: emptyToNull(data.address.line1 ?? undefined),
      line2: emptyToNull(data.address.line2 ?? undefined),
      city: emptyToNull(data.address.city ?? undefined),
      state: emptyToNull(data.address.state ?? undefined),
      postal_code: emptyToNull(data.address.postal_code ?? undefined),
      country: emptyToNull(data.address.country ?? undefined),
    },
  };
}

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

export function ProfilesManagementPage({ userEmail }: Props) {
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

  const handleSubmit = async (data: ProfileFormData) => {
    try {
      setError('');
      setSaveOk(false);
      const res = await apiClient.put<UserProfile>('/profile', toPayload(data));
      setProfile(res.data);
      setSaveOk(true);
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

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="page-scroll-y min-h-0 flex-1 px-5 py-5">
        <div className="w-full space-y-8 pb-8">
          {/* Row 1 - overview + import */}
          <section className="space-y-4" aria-label="Profile overview">
            <div className="grid gap-4 xl:grid-cols-2">
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
                <div className="flex items-start gap-4">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white">
                    <UserCircle2 className="h-7 w-7" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h1 className="text-2xl font-bold tracking-tight text-slate-900 md:text-3xl">
                      Your profile
                    </h1>
                    <p className="mt-1.5 text-sm leading-relaxed text-slate-600 md:text-base">
                      Structured profile data powers match summaries, dimension scores, and gap analysis when you run job fit checks.
                    </p>

                    {!loading ? (
                      <div className="mt-5 border-t border-slate-200 pt-5">
                        <div className="flex flex-wrap items-end justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <ListChecks className="h-4 w-4 shrink-0 text-blue-600" aria-hidden />
                            <div>
                              <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Saved profile strength</p>
                              <p className="mt-0.5 text-sm text-slate-700">
                                <span className="font-semibold text-slate-900">
                                  {completion.requiredFilled} of {completion.requiredTotal} core areas
                                </span>{' '}
                                complete from your last save
                              </p>
                            </div>
                          </div>
                          <p
                            className="text-3xl font-bold tabular-nums leading-none text-blue-800"
                            aria-live="polite"
                            aria-atomic="true"
                          >
                            {completion.requiredPercent}%
                          </p>
                        </div>
                        <div
                          className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-slate-200"
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
                <ResumeImportSection profile={profile} accountEmail={userEmail ?? undefined} applyProfile={handleSubmit} />
              )}
            </div>

            {!loading && (
              <p className="text-xs text-slate-500">
                OpenAI key and company check cycle are in{' '}
                <Link to="/settings" className="font-medium text-blue-600 hover:text-blue-800">
                  Settings
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
            <div className="mb-4 border-b border-slate-200 pb-3">
              <h2 className="text-lg font-bold text-slate-900">Profile details</h2>
              <p className="mt-1 text-sm text-slate-600">
                Edit each section and save independently. All fields are used for AI matching.
              </p>
            </div>

            {loading ? (
              <ProfileFormSkeleton />
            ) : (
              <ProfileForm profile={profile} onSubmit={handleSubmit} />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

export default ProfilesManagementPage;
