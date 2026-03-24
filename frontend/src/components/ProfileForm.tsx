import { useState, FormEvent, useEffect } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { COUNTRY_CODES } from '../constants/countryCodes';
import type { ProfileFormData, TechnicalSkillBlock, WorkExperienceBlock, EducationBlock, CertificateBlock } from '../types/profile';
import type { UserProfile } from '../types/profile';
import { JOB_TYPES } from '../types/profile';

const emptyTechSkill = (): TechnicalSkillBlock => ({ category: '', skills: '' });
const emptyWorkExp = (): WorkExperienceBlock => ({
  company_name: '', job_title: '', period_start: '', period_end: '', location: '', job_type: '', description: '',
});
const emptyEducation = (): EducationBlock => ({
  university_name: '', degree: '', mark: '', period_start: '', period_end: '', location: '', description: '',
});
const emptyCert = (): CertificateBlock => ({ name: '' });

function profileToForm(p: UserProfile | null): ProfileFormData {
  if (!p) {
    return {
      name_first: '', name_middle: '', name_last: '',
      title: '', email: '', phone_country_code: '+1', phone_number: '',
      linkedin_url: '', github_url: '', profile_summary: '',
      technical_skills: [emptyTechSkill()],
      work_experience: [emptyWorkExp()],
      education: [emptyEducation()],
      certificates: [emptyCert()],
      extra: [''],
    };
  }
  const ts = (p.technical_skills?.length ? p.technical_skills : [emptyTechSkill()]) as TechnicalSkillBlock[];
  const we = (p.work_experience?.length ? p.work_experience : [emptyWorkExp()]) as WorkExperienceBlock[];
  const ed = (p.education?.length ? p.education : [emptyEducation()]) as EducationBlock[];
  const cert = (p.certificates?.length ? p.certificates : [emptyCert()]) as CertificateBlock[];
  const extra = p.extra?.length ? p.extra : [''];
  return {
    name_first: p.name_first ?? '', name_middle: p.name_middle ?? '', name_last: p.name_last ?? '',
    title: p.title ?? '', email: p.email ?? '', phone_country_code: p.phone_country_code ?? '+1', phone_number: p.phone_number ?? '',
    linkedin_url: p.linkedin_url ?? '', github_url: p.github_url ?? '', profile_summary: p.profile_summary ?? '',
    technical_skills: ts.map((x) => ({ category: (x as TechnicalSkillBlock).category ?? '', skills: (x as TechnicalSkillBlock).skills ?? '' })),
    work_experience: we.map((x) => ({
      company_name: (x as WorkExperienceBlock).company_name ?? '',
      job_title: (x as WorkExperienceBlock).job_title ?? '',
      period_start: (x as WorkExperienceBlock).period_start ?? '',
      period_end: (x as WorkExperienceBlock).period_end ?? '',
      location: (x as WorkExperienceBlock).location ?? '',
      job_type: (x as WorkExperienceBlock).job_type ?? '',
      description: (x as WorkExperienceBlock).description ?? '',
    })),
    education: ed.map((x) => ({
      university_name: (x as EducationBlock).university_name ?? '',
      degree: (x as EducationBlock).degree ?? '',
      mark: (x as EducationBlock).mark ?? '',
      period_start: (x as EducationBlock).period_start ?? '',
      period_end: (x as EducationBlock).period_end ?? '',
      location: (x as EducationBlock).location ?? '',
      description: (x as EducationBlock).description ?? '',
    })),
    certificates: cert.map((x) => ({ name: (x as CertificateBlock).name ?? '' })),
    extra,
  };
}

function validateEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
function validateLinkedIn(s: string): boolean {
  return s.trim().length > 0 && /linkedin\.com\/in\//i.test(s);
}
function validateGitHub(s: string): boolean {
  if (!s.trim()) return true;
  return /github\.com\//i.test(s);
}
function validatePhone(s: string): boolean {
  return /^[\d\s\-+()]{7,25}$/.test(s.trim());
}

type Props = {
  profile: UserProfile | null;
  onSubmit: (data: ProfileFormData) => Promise<void>;
  onCancel: () => void;
  submitting: boolean;
};

export function ProfileForm({ profile, onSubmit, onCancel, submitting }: Props) {
  const [form, setForm] = useState<ProfileFormData>(() => profileToForm(profile));
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    setForm(profileToForm(profile));
  }, [profile?.user_id]);

  const update = <K extends keyof ProfileFormData>(key: K, value: ProfileFormData[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: '' }));
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const err: Record<string, string> = {};
    if (!form.name_first.trim()) err.name_first = 'First name is required';
    if (!form.name_last.trim()) err.name_last = 'Last name is required';
    if (!form.title.trim()) err.title = 'Title is required';
    if (!form.email.trim()) err.email = 'Email is required';
    else if (!validateEmail(form.email)) err.email = 'Invalid email format';
    if (!form.phone_number.trim()) err.phone_number = 'Phone number is required';
    else if (!validatePhone(form.phone_number)) err.phone_number = 'Invalid phone format';
    if (!form.linkedin_url.trim()) err.linkedin_url = 'LinkedIn URL is required';
    else if (!validateLinkedIn(form.linkedin_url)) err.linkedin_url = 'Invalid LinkedIn URL (expected linkedin.com/in/...)';
    if (form.github_url.trim() && !validateGitHub(form.github_url)) err.github_url = 'Invalid GitHub URL (expected github.com/...)';
    if (!form.profile_summary.trim()) err.profile_summary = 'Profile summary is required';
    setErrors(err);
    if (Object.keys(err).length) return;

    const payload: ProfileFormData = {
      ...form,
      technical_skills: form.technical_skills.filter((t) => t.category.trim() && t.skills.trim()),
      work_experience: form.work_experience.filter((w) => w.company_name.trim() && w.job_title.trim()),
      education: form.education.filter((e) => e.university_name.trim() && e.degree.trim()),
      certificates: form.certificates.filter((c) => c.name.trim()),
      extra: form.extra.filter((x) => x.trim()),
    };
    await onSubmit(payload);
  };

  const inputCls = "w-full rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-200";
  const labelCls = "mb-1.5 block text-sm font-semibold text-slate-800";
  const sectionCls = "rounded-xl border border-slate-200 bg-slate-50/50 p-6";

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      {/* Name */}
      <section className={sectionCls}>
        <h3 className="mb-4 text-base font-bold text-slate-900">Name</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className={labelCls} htmlFor="name_first">First name *</label>
            <input id="name_first" type="text" required value={form.name_first} onChange={(e) => update('name_first', e.target.value)} className={inputCls} maxLength={100} />
            {errors.name_first && <p className="mt-1 text-xs text-red-600">{errors.name_first}</p>}
          </div>
          <div>
            <label className={labelCls} htmlFor="name_middle">Middle (optional)</label>
            <input id="name_middle" type="text" value={form.name_middle} onChange={(e) => update('name_middle', e.target.value)} className={inputCls} maxLength={100} />
          </div>
          <div>
            <label className={labelCls} htmlFor="name_last">Last name *</label>
            <input id="name_last" type="text" required value={form.name_last} onChange={(e) => update('name_last', e.target.value)} className={inputCls} maxLength={100} />
            {errors.name_last && <p className="mt-1 text-xs text-red-600">{errors.name_last}</p>}
          </div>
        </div>
      </section>

      {/* Title & Contact */}
      <section className={sectionCls}>
        <h3 className="mb-4 text-base font-bold text-slate-900">Title & Contact</h3>
        <div className="space-y-4">
          <div>
            <label className={labelCls} htmlFor="title">Professional title *</label>
            <input id="title" type="text" required placeholder="e.g. Software Engineer" value={form.title} onChange={(e) => update('title', e.target.value)} className={inputCls} maxLength={200} />
            {errors.title && <p className="mt-1 text-xs text-red-600">{errors.title}</p>}
          </div>
          <div>
            <label className={labelCls} htmlFor="email">Email *</label>
            <input id="email" type="email" required placeholder="you@example.com" value={form.email} onChange={(e) => update('email', e.target.value)} className={inputCls} />
            {errors.email && <p className="mt-1 text-xs text-red-600">{errors.email}</p>}
          </div>
          <div className="flex flex-wrap gap-4">
            <div className="min-w-[120px] flex-1">
              <label className={labelCls}>Country code *</label>
              <select value={form.phone_country_code} onChange={(e) => update('phone_country_code', e.target.value)} className={inputCls}>
                {COUNTRY_CODES.map(({ code, country }) => (
                  <option key={code} value={code}>{code} {country}</option>
                ))}
              </select>
            </div>
            <div className="min-w-[180px] flex-[2]">
              <label className={labelCls} htmlFor="phone_number">Phone number *</label>
              <input id="phone_number" type="tel" required placeholder="123 456 7890" value={form.phone_number} onChange={(e) => update('phone_number', e.target.value)} className={inputCls} />
              {errors.phone_number && <p className="mt-1 text-xs text-red-600">{errors.phone_number}</p>}
            </div>
          </div>
          <div>
            <label className={labelCls} htmlFor="linkedin_url">LinkedIn URL *</label>
            <input id="linkedin_url" type="url" required placeholder="https://linkedin.com/in/yourprofile" value={form.linkedin_url} onChange={(e) => update('linkedin_url', e.target.value)} className={inputCls} />
            {errors.linkedin_url && <p className="mt-1 text-xs text-red-600">{errors.linkedin_url}</p>}
          </div>
          <div>
            <label className={labelCls} htmlFor="github_url">GitHub URL (optional)</label>
            <input id="github_url" type="url" placeholder="https://github.com/username" value={form.github_url} onChange={(e) => update('github_url', e.target.value)} className={inputCls} />
            {errors.github_url && <p className="mt-1 text-xs text-red-600">{errors.github_url}</p>}
          </div>
        </div>
      </section>

      {/* Profile summary */}
      <section className={sectionCls}>
        <h3 className="mb-4 text-base font-bold text-slate-900">Profile summary *</h3>
        <textarea rows={4} required value={form.profile_summary} onChange={(e) => update('profile_summary', e.target.value)} className={inputCls} placeholder="Brief professional summary..." maxLength={5000} />
        {errors.profile_summary && <p className="mt-1 text-xs text-red-600">{errors.profile_summary}</p>}
      </section>

      {/* Technical skills */}
      <section className={sectionCls}>
        <h3 className="mb-4 text-base font-bold text-slate-900">Technical skills</h3>
        {form.technical_skills.map((t, i) => (
          <div key={i} className="mb-4 flex flex-wrap gap-3 rounded-lg border border-slate-200 bg-white p-4">
            <input type="text" placeholder="Category (e.g. Languages)" value={t.category} onChange={(e) => {
              const next = [...form.technical_skills]; next[i] = { ...next[i], category: e.target.value }; update('technical_skills', next);
            }} className="flex-1 min-w-[140px] rounded border border-slate-300 px-3 py-2 text-sm" maxLength={100} />
            <input type="text" placeholder="Skills (e.g. Python, JavaScript)" value={t.skills} onChange={(e) => {
              const next = [...form.technical_skills]; next[i] = { ...next[i], skills: e.target.value }; update('technical_skills', next);
            }} className="flex-[2] min-w-[180px] rounded border border-slate-300 px-3 py-2 text-sm" maxLength={500} />
            <button type="button" onClick={() => update('technical_skills', form.technical_skills.filter((_, j) => j !== i))} className="rounded p-2 text-slate-500 hover:bg-rose-50 hover:text-rose-600">
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
        <button type="button" onClick={() => update('technical_skills', [...form.technical_skills, emptyTechSkill()])} className="flex items-center gap-2 rounded-lg border border-dashed border-slate-300 px-4 py-2 text-sm text-slate-600 hover:border-blue-400 hover:text-blue-600">
          <Plus className="h-4 w-4" /> Add skill block
        </button>
      </section>

      {/* Work experience */}
      <section className={sectionCls}>
        <h3 className="mb-4 text-base font-bold text-slate-900">Work experience</h3>
        {form.work_experience.map((w, i) => (
          <div key={i} className="mb-6 rounded-lg border border-slate-200 bg-white p-4 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <input type="text" placeholder="Company name *" value={w.company_name} onChange={(e) => {
                const next = [...form.work_experience]; next[i] = { ...next[i], company_name: e.target.value }; update('work_experience', next);
              }} className="rounded border border-slate-300 px-3 py-2 text-sm" />
              <input type="text" placeholder="Job title *" value={w.job_title} onChange={(e) => {
                const next = [...form.work_experience]; next[i] = { ...next[i], job_title: e.target.value }; update('work_experience', next);
              }} className="rounded border border-slate-300 px-3 py-2 text-sm" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <input type="month" placeholder="Start" value={w.period_start} onChange={(e) => {
                const next = [...form.work_experience]; next[i] = { ...next[i], period_start: e.target.value }; update('work_experience', next);
              }} className="rounded border border-slate-300 px-3 py-2 text-sm" />
              <input type="month" placeholder="End" value={w.period_end} onChange={(e) => {
                const next = [...form.work_experience]; next[i] = { ...next[i], period_end: e.target.value }; update('work_experience', next);
              }} className="rounded border border-slate-300 px-3 py-2 text-sm" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <input type="text" placeholder="Location" value={w.location} onChange={(e) => {
                const next = [...form.work_experience]; next[i] = { ...next[i], location: e.target.value }; update('work_experience', next);
              }} className="rounded border border-slate-300 px-3 py-2 text-sm" />
              <select value={w.job_type} onChange={(e) => {
                const next = [...form.work_experience]; next[i] = { ...next[i], job_type: e.target.value }; update('work_experience', next);
              }} className="rounded border border-slate-300 px-3 py-2 text-sm">
                <option value="">Job type</option>
                {JOB_TYPES.map((jt) => <option key={jt} value={jt}>{jt}</option>)}
              </select>
            </div>
            <textarea rows={3} placeholder="Description" value={w.description} onChange={(e) => {
              const next = [...form.work_experience]; next[i] = { ...next[i], description: e.target.value }; update('work_experience', next);
            }} className="w-full rounded border border-slate-300 px-3 py-2 text-sm" />
            <button type="button" onClick={() => update('work_experience', form.work_experience.filter((_, j) => j !== i))} className="flex items-center gap-1 text-sm text-rose-600 hover:underline">
              <Trash2 className="h-3 w-3" /> Remove
            </button>
          </div>
        ))}
        <button type="button" onClick={() => update('work_experience', [...form.work_experience, emptyWorkExp()])} className="flex items-center gap-2 rounded-lg border border-dashed border-slate-300 px-4 py-2 text-sm text-slate-600 hover:border-blue-400 hover:text-blue-600">
          <Plus className="h-4 w-4" /> Add work experience
        </button>
      </section>

      {/* Education */}
      <section className={sectionCls}>
        <h3 className="mb-4 text-base font-bold text-slate-900">Education</h3>
        {form.education.map((ed, i) => (
          <div key={i} className="mb-6 rounded-lg border border-slate-200 bg-white p-4 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <input type="text" placeholder="University name *" value={ed.university_name} onChange={(e) => {
                const next = [...form.education]; next[i] = { ...next[i], university_name: e.target.value }; update('education', next);
              }} className="rounded border border-slate-300 px-3 py-2 text-sm" />
              <input type="text" placeholder="Degree *" value={ed.degree} onChange={(e) => {
                const next = [...form.education]; next[i] = { ...next[i], degree: e.target.value }; update('education', next);
              }} className="rounded border border-slate-300 px-3 py-2 text-sm" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <input type="text" placeholder="Mark/GPA" value={ed.mark} onChange={(e) => {
                const next = [...form.education]; next[i] = { ...next[i], mark: e.target.value }; update('education', next);
              }} className="rounded border border-slate-300 px-3 py-2 text-sm" />
              <input type="text" placeholder="Location" value={ed.location} onChange={(e) => {
                const next = [...form.education]; next[i] = { ...next[i], location: e.target.value }; update('education', next);
              }} className="rounded border border-slate-300 px-3 py-2 text-sm" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <input type="month" placeholder="Start" value={ed.period_start} onChange={(e) => {
                const next = [...form.education]; next[i] = { ...next[i], period_start: e.target.value }; update('education', next);
              }} className="rounded border border-slate-300 px-3 py-2 text-sm" />
              <input type="month" placeholder="End" value={ed.period_end} onChange={(e) => {
                const next = [...form.education]; next[i] = { ...next[i], period_end: e.target.value }; update('education', next);
              }} className="rounded border border-slate-300 px-3 py-2 text-sm" />
            </div>
            <textarea rows={2} placeholder="Description" value={ed.description} onChange={(e) => {
              const next = [...form.education]; next[i] = { ...next[i], description: e.target.value }; update('education', next);
            }} className="w-full rounded border border-slate-300 px-3 py-2 text-sm" />
            <button type="button" onClick={() => update('education', form.education.filter((_, j) => j !== i))} className="flex items-center gap-1 text-sm text-rose-600 hover:underline">
              <Trash2 className="h-3 w-3" /> Remove
            </button>
          </div>
        ))}
        <button type="button" onClick={() => update('education', [...form.education, emptyEducation()])} className="flex items-center gap-2 rounded-lg border border-dashed border-slate-300 px-4 py-2 text-sm text-slate-600 hover:border-blue-400 hover:text-blue-600">
          <Plus className="h-4 w-4" /> Add education
        </button>
      </section>

      {/* Certificates */}
      <section className={sectionCls}>
        <h3 className="mb-4 text-base font-bold text-slate-900">Certificates</h3>
        {form.certificates.map((c, i) => (
          <div key={i} className="mb-3 flex gap-2">
            <input type="text" placeholder="Certificate name" value={c.name} onChange={(e) => {
              const next = [...form.certificates]; next[i] = { name: e.target.value }; update('certificates', next);
            }} className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm" />
            <button type="button" onClick={() => update('certificates', form.certificates.filter((_, j) => j !== i))} className="rounded p-2 text-slate-500 hover:bg-rose-50 hover:text-rose-600">
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
        <button type="button" onClick={() => update('certificates', [...form.certificates, emptyCert()])} className="flex items-center gap-2 rounded-lg border border-dashed border-slate-300 px-4 py-2 text-sm text-slate-600 hover:border-blue-400 hover:text-blue-600">
          <Plus className="h-4 w-4" /> Add certificate
        </button>
      </section>

      {/* Extra */}
      <section className={sectionCls}>
        <h3 className="mb-4 text-base font-bold text-slate-900">Extra</h3>
        {form.extra.map((line, i) => (
          <div key={i} className="mb-2 flex gap-2">
            <input type="text" placeholder="Additional info" value={line} onChange={(e) => {
              const next = [...form.extra]; next[i] = e.target.value; update('extra', next);
            }} className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm" />
            <button type="button" onClick={() => update('extra', form.extra.filter((_, j) => j !== i))} className="rounded p-2 text-slate-500 hover:bg-rose-50 hover:text-rose-600">
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
        <button type="button" onClick={() => update('extra', [...form.extra, ''])} className="flex items-center gap-2 rounded-lg border border-dashed border-slate-300 px-4 py-2 text-sm text-slate-600 hover:border-blue-400 hover:text-blue-600">
          <Plus className="h-4 w-4" /> Add line
        </button>
      </section>

      <div className="flex gap-3">
        <button type="submit" disabled={submitting} className="rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 px-6 py-2.5 font-semibold text-white shadow-md hover:from-blue-700 hover:to-indigo-700 disabled:opacity-60">
          {submitting ? 'Saving...' : 'Save profile'}
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg border border-slate-300 px-6 py-2.5 font-medium text-slate-700 hover:bg-slate-50">
          Cancel
        </button>
      </div>
    </form>
  );
}
