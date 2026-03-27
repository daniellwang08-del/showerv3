import { useState, useEffect } from 'react';
import { ArrowLeft, Sparkles, UserCircle2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { apiClient } from '../api/client';
import { ProfileForm } from './ProfileForm';
import type { UserProfile } from '../types/profile';
import type { ProfileFormData } from '../types/profile';

type Props = {
  onBack: () => void;
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
    technical_skills: data.technical_skills.map((t) => ({ category: t.category.trim(), skills: t.skills.trim() })),
    work_experience: data.work_experience.map((w) => ({
      company_name: w.company_name.trim(),
      job_title: w.job_title.trim(),
      period_start: emptyToNull(w.period_start),
      period_end: emptyToNull(w.period_end),
      location: emptyToNull(w.location),
      job_type: emptyToNull(w.job_type) || null,
      description: emptyToNull(w.description),
    })),
    education: data.education.map((e) => ({
      university_name: e.university_name.trim(),
      degree: e.degree.trim(),
      mark: emptyToNull(e.mark),
      period_start: emptyToNull(e.period_start),
      period_end: emptyToNull(e.period_end),
      location: emptyToNull(e.location),
      description: emptyToNull(e.description),
    })),
    certificates: data.certificates.map((c) => ({ name: c.name.trim() })),
    extra: data.extra.filter((x) => x.trim()),
  };
}

function ProfileHeroSkeleton() {
  return (
    <div className="animate-panel-fade-in space-y-4 px-4 pb-4 pt-2 md:px-5">
      <div className="glass-panel h-28 rounded-2xl animate-skeleton-pulse md:h-24" />
      <div className="glass-panel h-40 rounded-2xl animate-skeleton-pulse" />
      <div className="glass-panel h-48 rounded-2xl animate-skeleton-pulse" />
      <div className="glass-panel h-56 rounded-2xl animate-skeleton-pulse" />
    </div>
  );
}

export function ProfilesManagementPage({ onBack }: Props) {
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
    }
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <div className="profile-side-art hidden xl:block" aria-hidden>
        <div className="profile-widget profile-widget--identity">
          <div className="profile-widget__avatar" />
          <div className="profile-widget__line profile-widget__line--a" />
          <div className="profile-widget__line profile-widget__line--b" />
          <div className="profile-widget__line profile-widget__line--c" />
        </div>

        <div className="profile-widget profile-widget--skills">
          <span className="profile-tag">React</span>
          <span className="profile-tag">Python</span>
          <span className="profile-tag">System Design</span>
        </div>

        <div className="profile-widget profile-widget--checklist">
          <div className="profile-check profile-check--done">Contact details</div>
          <div className="profile-check profile-check--done">Experience</div>
          <div className="profile-check profile-check--active">Summary editing...</div>
        </div>

        <div className="profile-widget profile-widget--progress">
          <div className="profile-meter">
            <div className="profile-meter__fill profile-meter__fill--one" />
          </div>
          <div className="profile-meter">
            <div className="profile-meter__fill profile-meter__fill--two" />
          </div>
          <div className="profile-meter">
            <div className="profile-meter__fill profile-meter__fill--three" />
          </div>
        </div>
      </div>
      <div className="shrink-0 border-b border-blue-200/50 bg-white/45 px-4 py-3 backdrop-blur-md md:px-6">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={onBack}
            className="group inline-flex items-center gap-2 rounded-xl border border-blue-200/70 bg-white/80 px-3 py-2 text-sm font-semibold text-blue-800 shadow-sm transition hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-md"
          >
            <ArrowLeft className="h-4 w-4 transition group-hover:-translate-x-0.5" />
            Back to dashboard
          </button>
          <div className="flex items-center gap-2 text-xs font-medium text-slate-500 md:text-sm">
            <Sparkles className="h-4 w-4 text-amber-500" />
            <span>Used for AI job match scoring</span>
          </div>
        </div>
      </div>

      <div className="timeline-scroll relative z-10 flex min-h-0 flex-1 flex-col overflow-auto px-4 py-4 md:px-6 md:py-5">
        <div className="mx-auto w-full max-w-4xl animate-content-in space-y-4">
          <div className="glass-card relative overflow-hidden rounded-2xl p-6 md:p-8">
            <div className="pointer-events-none absolute -right-8 -top-12 h-40 w-40 rounded-full bg-gradient-to-br from-blue-400/25 to-indigo-400/10 blur-2xl" />
            <div className="pointer-events-none absolute -bottom-10 -left-10 h-36 w-36 rounded-full bg-sky-400/20 blur-2xl" />

            <div className="relative flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div className="flex items-start gap-4">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-600 to-indigo-600 text-white shadow-lg shadow-blue-500/30">
                  <UserCircle2 className="h-8 w-8" />
                </div>
                <div>
                  <h1 className="bg-gradient-to-r from-blue-800 via-indigo-700 to-sky-600 bg-clip-text text-2xl font-bold tracking-tight text-transparent md:text-3xl">
                    Your profile
                  </h1>
                  <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-slate-600 md:text-base">
                    Rich, structured data here powers match summaries, dimension scores, and gap analysis when you run job
                    fit checks.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {saveOk && (
            <div
              className="glass-panel flex animate-content-in items-center gap-3 rounded-xl border border-emerald-200/80 bg-emerald-50/90 px-4 py-3 text-sm font-medium text-emerald-900 shadow-sm"
              role="status"
            >
              <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
              Profile saved successfully.
            </div>
          )}

          {error && (
            <div className="glass-panel flex animate-content-in items-start gap-3 rounded-xl border border-rose-200/90 bg-rose-50/95 px-4 py-3 text-sm font-medium text-rose-900 shadow-sm">
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" />
              <span>{error}</span>
            </div>
          )}

          {loading ? (
            <div className="py-4">
              <p className="mb-4 text-center text-sm font-semibold text-slate-600">Loading your profile…</p>
              <ProfileHeroSkeleton />
            </div>
          ) : (
            <ProfileForm profile={profile} onSubmit={handleSubmit} />
          )}
        </div>
      </div>
    </div>
  );
}

export default ProfilesManagementPage;
