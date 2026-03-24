import { useState, useEffect } from 'react';
import { ArrowLeft } from 'lucide-react';
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

export function ProfilesManagementPage({ onBack }: Props) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const fetchProfile = async () => {
      try {
        setLoading(true);
        setError('');
        const res = await apiClient.get<UserProfile>('/profile');
        setProfile(res.data ?? null);
      } catch (err: any) {
        if (err.response?.status === 404) {
          setProfile(null);
        } else {
          setError(err.response?.data?.detail ?? 'Failed to load profile');
        }
      } finally {
        setLoading(false);
      }
    };
    void fetchProfile();
  }, []);

  const handleSubmit = async (data: ProfileFormData) => {
    try {
      setSubmitting(true);
      setError('');
      const res = await apiClient.put<UserProfile>('/profile', toPayload(data));
      setProfile(res.data);
    } catch (err: any) {
      let msg = 'Failed to save profile';
      if (err.code === 'ERR_NETWORK' || !err.response) {
        msg = 'Network error. Is the server running?';
      } else {
        const detail = err.response?.data?.detail;
        if (typeof detail === 'string') msg = detail;
        else if (Array.isArray(detail) && detail.length > 0) {
          msg = detail.map((d: { msg?: string }) => d.msg || JSON.stringify(d)).join('; ');
        }
      }
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-blue-50/30 text-slate-900">
      <div className="mx-auto max-w-5xl px-4 py-8">
        <button
          onClick={onBack}
          className="mb-6 flex items-center gap-2 text-sm font-medium text-slate-600 transition hover:text-slate-900"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to dashboard
        </button>

        <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
          <h1 className="mb-2 text-2xl font-bold text-slate-900">My profile</h1>
          <p className="mb-8 text-sm text-slate-600">
            Fill in your professional details. This profile will be used to analyze job match results.
          </p>
          {error && <p className="mb-4 text-sm font-medium text-red-600">{error}</p>}
          {loading ? (
            <p className="text-slate-500">Loading profile...</p>
          ) : (
            <ProfileForm
              profile={profile}
              onSubmit={handleSubmit}
              onCancel={onBack}
              submitting={submitting}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export default ProfilesManagementPage;
