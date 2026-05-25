import { useState, useEffect, useMemo, useRef, type ComponentType, type ReactNode } from 'react';
import {
  Plus,
  Trash2,
  User,
  Mail,
  Phone,
  Linkedin,
  Github,
  FileText,
  Code2,
  Briefcase,
  GraduationCap,
  Award,
  ListTree,
  ChevronDown,
  CalendarDays,
  Search,
  ChevronLeft,
  ChevronRight,
  Check,
  Pencil,
  CheckCircle,
  X,
} from 'lucide-react';
import { COUNTRY_CODES } from '../../constants/countryCodes';
import type { ProfileFormData } from '../../types/profile';
import type { UserProfile } from '../../types/profile';
import { JOB_TYPES, isValidJobArrangement } from '../../types/profile';
import {
  profileToForm,
  emptyTechSkill,
  emptyWorkExp,
  emptyEducation,
  emptyCert,
} from '../../utils/profileFormData';

export { profileToForm } from '../../utils/profileFormData';

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

type SectionId = 'contact' | 'summary' | 'skills' | 'work' | 'education' | 'certificates' | 'extra';

function defaultSectionEditing(allEditing: boolean): Record<SectionId, boolean> {
  return {
    contact: allEditing,
    summary: allEditing,
    skills: allEditing,
    work: allEditing,
    education: allEditing,
    certificates: allEditing,
    extra: allEditing,
  };
}

function collectErrors(form: ProfileFormData): Record<string, string> {
    const err: Record<string, string> = {};
    if (!form.name_first.trim()) err.name_first = 'First name is required';
    if (!form.name_last.trim()) err.name_last = 'Last name is required';
    if (!form.title.trim()) err.title = 'Title is required';
    if (!form.email.trim()) err.email = 'Email is required';
    else if (!validateEmail(form.email)) err.email = 'Invalid email format';
    if (!form.phone_number.trim()) err.phone_number = 'Phone number is required';
  else if (!validatePhone(form.phone_number)) err.phone_number = 'Use 7–25 digits/spaces/+-()';
    if (!form.linkedin_url.trim()) err.linkedin_url = 'LinkedIn URL is required';
  else if (!validateLinkedIn(form.linkedin_url)) err.linkedin_url = 'Use a profile URL (linkedin.com/in/…)';
  if (form.github_url.trim() && !validateGitHub(form.github_url)) err.github_url = 'Use a GitHub URL (github.com/…)';
    if (!form.profile_summary.trim()) err.profile_summary = 'Profile summary is required';
  else if (form.profile_summary.length > 5000) err.profile_summary = 'Max 5,000 characters';

  form.technical_skills.forEach((t, i) => {
    const c = t.category.trim();
    const sk = t.skills.trim();
    if (c && !sk) err[`skills_${i}_skills`] = 'Add skills or clear the category';
    if (!c && sk) err[`skills_${i}_category`] = 'Add a category or clear skills';
  });

  form.work_experience.forEach((w, i) => {
    const co = w.company_name.trim();
    const jt = w.job_title.trim();
    if (co && !jt) err[`work_${i}_job_title`] = 'Job title is required when company is set';
    if (!co && jt) err[`work_${i}_company_name`] = 'Company is required when job title is set';
    if (co && jt) {
      if (!w.location?.trim()) err[`work_${i}_location`] = 'Location is required for job matching';
      if (!isValidJobArrangement(w.job_type)) err[`work_${i}_job_type`] = 'Choose remote, hybrid, or onsite';
    }
    const ps = (w.period_start ?? '').trim();
    const pe = (w.period_end ?? '').trim();
    if (ps && pe && ps > pe) err[`work_${i}_period_end`] = 'End month must be after start';
  });

  form.education.forEach((ed, i) => {
    const u = ed.university_name.trim();
    const d = ed.degree.trim();
    if (u && !d) err[`edu_${i}_degree`] = 'Degree is required when university is set';
    if (!u && d) err[`edu_${i}_university`] = 'University is required when degree is set';
    const ps = (ed.period_start ?? '').trim();
    const pe = (ed.period_end ?? '').trim();
    if (ps && pe && ps > pe) err[`edu_${i}_period_end`] = 'End month must be after start';
  });

  form.extra.forEach((line, i) => {
    if (line.length > 500) err[`extra_${i}`] = 'Max 500 characters per line';
  });

  form.certificates.forEach((c, i) => {
    if ((c.name?.length ?? 0) > 200) err[`cert_${i}_name`] = 'Max 200 characters';
  });

  return err;
}

function stripSectionErrors(section: SectionId): (prev: Record<string, string>) => Record<string, string> {
  return (prev) => {
    const next = { ...prev };
    for (const k of Object.keys(next)) {
      let drop = false;
      if (
        section === 'contact' &&
        (k.startsWith('name_') ||
          ['title', 'email', 'phone_number', 'phone_country_code', 'linkedin_url', 'github_url'].includes(k))
      )
        drop = true;
      else if (section === 'summary' && k === 'profile_summary') drop = true;
      else if (section === 'skills' && k.startsWith('skills_')) drop = true;
      else if (section === 'work' && k.startsWith('work_')) drop = true;
      else if (section === 'education' && k.startsWith('edu_')) drop = true;
      else if (section === 'certificates' && k.startsWith('cert_')) drop = true;
      else if (section === 'extra' && k.startsWith('extra_')) drop = true;
      if (drop) delete next[k];
    }
    return next;
  };
}

function formatMonthLabel(ym: string): string {
  if (!ym || !/^\d{4}-\d{2}$/.test(ym)) return '—';
  const [y, m] = ym.split('-').map(Number);
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (m < 1 || m > 12) return ym;
  return `${names[m - 1]} ${y}`;
}

function fieldRing(errors: Record<string, string>, key: string): string {
  return errors[key] ? ' ring-2 ring-rose-200/90 border-rose-400/70' : '';
}

function buildPayload(form: ProfileFormData): ProfileFormData {
  return {
      ...form,
      technical_skills: form.technical_skills.filter((t) => t.category.trim() && t.skills.trim()),
      work_experience: form.work_experience.filter((w) => w.company_name.trim() && w.job_title.trim()),
    education: form.education.filter((ed) => ed.university_name.trim() && ed.degree.trim()),
      certificates: form.certificates.filter((c) => c.name.trim()),
      extra: form.extra.filter((x) => x.trim()),
    };
}

function errorInSection(errorKey: string, section: SectionId): boolean {
  if (section === 'contact')
    return (
      errorKey.startsWith('name_') ||
      ['title', 'email', 'phone_number', 'phone_country_code', 'linkedin_url', 'github_url'].includes(errorKey)
    );
  if (section === 'summary') return errorKey === 'profile_summary';
  if (section === 'skills') return errorKey.startsWith('skills_');
  if (section === 'work') return errorKey.startsWith('work_');
  if (section === 'education') return errorKey.startsWith('edu_');
  if (section === 'certificates') return errorKey.startsWith('cert_');
  if (section === 'extra') return errorKey.startsWith('extra_');
  return false;
}

function mergeSection(base: ProfileFormData, draft: ProfileFormData, section: SectionId): ProfileFormData {
  switch (section) {
    case 'contact':
      return {
        ...base,
        name_first: draft.name_first,
        name_middle: draft.name_middle,
        name_last: draft.name_last,
        title: draft.title,
        email: draft.email,
        phone_country_code: draft.phone_country_code,
        phone_number: draft.phone_number,
        linkedin_url: draft.linkedin_url,
        github_url: draft.github_url,
      };
    case 'summary':
      return { ...base, profile_summary: draft.profile_summary };
    case 'skills':
      return { ...base, technical_skills: draft.technical_skills };
    case 'work':
      return { ...base, work_experience: draft.work_experience };
    case 'education':
      return { ...base, education: draft.education };
    case 'certificates':
      return { ...base, certificates: draft.certificates };
    case 'extra':
      return { ...base, extra: draft.extra };
    default:
      return base;
  }
}

type SectionProps = {
  icon: ComponentType<{ className?: string }>;
  title: string;
  hint?: string;
  sectionId: SectionId;
  layoutClassName?: string;
  isEditing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void | Promise<void>;
  saving: boolean;
  viewContent: ReactNode;
  children: ReactNode;
};

function ProfileSection({
  icon: Icon,
  title,
  hint,
  layoutClassName,
  isEditing,
  onEdit,
  onCancel,
  onSave,
  saving,
  viewContent,
  children,
}: SectionProps) {
  const btnBase =
    'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-bold transition focus:outline-none focus:ring-2 focus:ring-blue-300';
  return (
    <section className={`rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:p-6 ${layoutClassName ?? ''}`}>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500/15 to-indigo-500/10 text-blue-600 ring-1 ring-blue-200/70 shadow-sm">
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-bold text-slate-900">{title}</h3>
            {hint ? <p className="mt-1 text-sm leading-relaxed text-slate-600">{hint}</p> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          {isEditing ? (
            <>
              <button
                type="button"
                onClick={onSave}
                disabled={saving}
                className={`${btnBase} border-blue-200/90 bg-blue-600 text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-70`}
              >
                <CheckCircle className="h-3.5 w-3.5" />
                {saving ? 'Saving...' : 'Save section'}
              </button>
              <button
                type="button"
                onClick={onCancel}
                className={`${btnBase} border-slate-200/90 bg-white/90 text-slate-800 hover:bg-slate-50`}
              >
                <X className="h-3.5 w-3.5" />
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onEdit}
              className={`${btnBase} border-blue-200/90 bg-white/90 text-blue-800 hover:bg-blue-50`}
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </button>
          )}
        </div>
      </div>
      {isEditing ? (
        children
      ) : (
        <div className="rounded-xl border border-blue-100/70 bg-white/55 px-4 py-4 text-sm leading-relaxed text-slate-800 shadow-sm">{viewContent}</div>
      )}
    </section>
  );
}

const labelCls = 'mb-1.5 block text-xs font-bold uppercase tracking-wide text-slate-500';
const inputCls =
  'blue-outline-input w-full rounded-xl px-4 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 outline-none transition';
const fieldErrorCls = 'mt-1.5 flex items-center gap-1 text-xs font-medium text-rose-600';
const selectCls =
  'blue-outline-input w-full appearance-none rounded-xl px-4 py-2.5 pr-10 text-sm font-medium text-slate-900 outline-none transition';
const monthCls =
  'blue-outline-input w-full rounded-xl px-4 py-2.5 pl-10 text-sm font-medium text-slate-900 outline-none transition';

type FancySelectProps = {
  value: string;
  onChange: (next: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
  hasError?: boolean;
};

function FancySelect({ value, onChange, options, placeholder, hasError }: FancySelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);

  const selected = options.find((o) => o.value === value);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        className={`${selectCls} flex items-center justify-between gap-2 text-left${hasError ? ' ring-2 ring-rose-200/90 border-rose-400/70' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={selected ? 'text-slate-900' : 'text-slate-400'}>
          {selected?.label ?? placeholder ?? 'Select'}
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="glass-panel absolute left-0 right-0 z-30 mt-2 rounded-xl border border-blue-200/80 p-2 shadow-xl">
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search..."
              className="blue-outline-input w-full rounded-lg py-2 pl-8 pr-3 text-sm"
            />
          </div>
          <div className="max-h-56 overflow-auto rounded-lg border border-blue-100/80 bg-white/90 p-1">
            {filtered.length === 0 ? (
              <div className="px-2 py-3 text-center text-xs text-slate-500">No options found</div>
            ) : (
              filtered.map((o) => {
                const active = o.value === value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => {
                      onChange(o.value);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-sm transition ${
                      active ? 'bg-blue-100/90 font-semibold text-blue-900' : 'text-slate-700 hover:bg-blue-50/80'
                    }`}
                    role="option"
                    aria-selected={active}
                  >
                    <span>{o.label}</span>
                    {active ? <Check className="h-3.5 w-3.5 text-blue-700" /> : null}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

type MonthFieldProps = {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  hasError?: boolean;
  onPick?: () => void;
};

function MonthField({ value, onChange, placeholder, hasError, onPick }: MonthFieldProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const currentYear = useMemo(() => new Date().getFullYear(), []);
  const parse = (v: string): { year: number; month: number } | null => {
    if (!v || !/^\d{4}-\d{2}$/.test(v)) return null;
    const [y, m] = v.split('-').map(Number);
    if (!y || !m || m < 1 || m > 12) return null;
    return { year: y, month: m };
  };
  const selected = parse(value);
  const [viewYear, setViewYear] = useState<number>(selected?.year ?? currentYear);
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setViewYear(selected?.year ?? currentYear);
  }, [open, selected?.year, currentYear]);

  const label = selected ? `${monthNames[selected.month - 1]} ${selected.year}` : placeholder;

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        className={`${monthCls} flex items-center justify-between gap-2 text-left${hasError ? ' ring-2 ring-rose-200/90 border-rose-400/70' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="inline-flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-slate-400" />
          <span className={selected ? 'text-slate-900' : 'text-slate-400'}>{label}</span>
        </span>
        <ChevronDown className={`h-4 w-4 text-slate-400 transition ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="glass-panel absolute left-0 z-30 mt-2 w-[260px] rounded-xl border border-blue-200/80 p-3 shadow-xl">
          <div className="mb-3 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setViewYear((y) => y - 1)}
              className="rounded-lg border border-blue-200/80 bg-white/90 p-1.5 text-slate-600 hover:bg-blue-50"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-bold text-slate-800">{viewYear}</span>
            <button
              type="button"
              onClick={() => setViewYear((y) => y + 1)}
              className="rounded-lg border border-blue-200/80 bg-white/90 p-1.5 text-slate-600 hover:bg-blue-50"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-4 gap-1.5">
            {monthNames.map((m, idx) => {
              const monthNum = idx + 1;
              const isActive = selected?.year === viewYear && selected?.month === monthNum;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    onChange(`${viewYear}-${String(monthNum).padStart(2, '0')}`);
                    onPick?.();
                    setOpen(false);
                  }}
                  className={`rounded-lg px-2 py-1.5 text-xs font-semibold transition ${
                    isActive
                      ? 'bg-blue-600 text-white shadow-sm shadow-blue-400/40'
                      : 'bg-white/90 text-slate-700 hover:bg-blue-50'
                  }`}
                >
                  {m}
                </button>
              );
            })}
          </div>

          <div className="mt-3 flex items-center justify-between text-xs">
            <button
              type="button"
              onClick={() => {
                onChange('');
                onPick?.();
                setOpen(false);
              }}
              className="font-semibold text-slate-500 hover:text-slate-700"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => {
                const t = new Date();
                onChange(`${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`);
                onPick?.();
                setOpen(false);
              }}
              className="font-semibold text-blue-700 hover:text-blue-800"
            >
              This month
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

type Props = {
  profile: UserProfile | null;
  onSubmit: (data: ProfileFormData) => Promise<void>;
};

export function ProfileForm({ profile, onSubmit }: Props) {
  const [form, setForm] = useState<ProfileFormData>(() => profileToForm(profile));
  const [savedForm, setSavedForm] = useState<ProfileFormData>(() => profileToForm(profile));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sectionEditing, setSectionEditing] = useState<Record<SectionId, boolean>>(() => defaultSectionEditing(!profile?.user_id));
  const [savingSection, setSavingSection] = useState<SectionId | null>(null);
  const formRef = useRef(form);
  formRef.current = form;

  useEffect(() => {
    const mapped = profileToForm(profile);
    setForm(mapped);
    setSavedForm(mapped);
    setSectionEditing(defaultSectionEditing(!profile?.user_id));
    setErrors({});
  }, [profile?.user_id, profile?.updated_at]);

  const blurField = (key: string) => {
    const f = formRef.current;
    const next = collectErrors(f);
    setErrors((prev) => {
      const msg = next[key];
      if (msg) return { ...prev, [key]: msg };
      const copy = { ...prev };
      delete copy[key];
      return copy;
    });
  };

  const update = <K extends keyof ProfileFormData>(key: K, value: ProfileFormData[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => {
      const n = { ...e };
      delete n[key as string];
      if (key === 'technical_skills') {
        for (const k of Object.keys(n)) if (k.startsWith('skills_')) delete n[k];
      }
      if (key === 'work_experience') {
        for (const k of Object.keys(n)) if (k.startsWith('work_')) delete n[k];
      }
      if (key === 'education') {
        for (const k of Object.keys(n)) if (k.startsWith('edu_')) delete n[k];
      }
      if (key === 'certificates') {
        for (const k of Object.keys(n)) if (k.startsWith('cert_')) delete n[k];
      }
      if (key === 'extra') {
        for (const k of Object.keys(n)) if (k.startsWith('extra_')) delete n[k];
      }
      return n;
    });
  };

  const saveSection = async (section: SectionId) => {
    const draft = formRef.current;
    const merged = mergeSection(savedForm, draft, section);
    const all = collectErrors(merged);
    const scoped = Object.fromEntries(Object.entries(all).filter(([k]) => errorInSection(k, section)));
    setErrors((prev) => ({ ...stripSectionErrors(section)(prev), ...scoped }));
    if (Object.keys(scoped).length > 0) return;
    setSavingSection(section);
    try {
      await onSubmit(buildPayload(merged));
      setSavedForm(merged);
      setForm(merged);
      setSectionEditing((s) => ({ ...s, [section]: false }));
    } finally {
      setSavingSection(null);
    }
  };

  const cancelSectionEdit = (section: SectionId) => {
    setForm((f) => mergeSection(f, savedForm, section));
    setErrors(stripSectionErrors(section));
    setSectionEditing((s) => ({ ...s, [section]: false }));
  };

  const addRowBtn =
    'group mt-2 inline-flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-blue-200/90 bg-gradient-to-b from-blue-50/40 to-white/60 px-4 py-3 text-sm font-semibold text-blue-700 shadow-sm transition hover:border-blue-400 hover:from-blue-50 hover:to-blue-50/80 hover:shadow-md active:scale-[0.99]';

  const removeIconBtn =
    'inline-flex shrink-0 items-center justify-center rounded-lg p-2.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 hover:shadow-sm';

  return (
    <div className="grid gap-5 pb-10 xl:grid-cols-2">
      <ProfileSection
        layoutClassName="h-full"
        icon={User}
        title="Name, title & contact"
        hint="Legal name as it should appear, your professional headline, and channels recruiters use."
        sectionId="contact"
        isEditing={sectionEditing.contact}
        onEdit={() => setSectionEditing((s) => ({ ...s, contact: true }))}
        onCancel={() => cancelSectionEdit('contact')}
        onSave={() => saveSection('contact')}
        saving={savingSection === 'contact'}
        viewContent={
          <div className="space-y-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Name</p>
              <p className="mt-1 text-base font-semibold text-slate-900">
                {[form.name_first, form.name_middle, form.name_last].filter((x) => x.trim()).join(' ') || (
                  <span className="font-normal text-slate-400">No name entered</span>
                )}
              </p>
            </div>
            <dl className="grid gap-x-6 gap-y-4 border-t border-slate-200/60 pt-4 sm:grid-cols-2">
              <div className="space-y-4">
                <div>
                  <dt className="text-xs font-bold uppercase tracking-wide text-slate-500">Title</dt>
                  <dd className="mt-1 font-medium text-slate-900">{form.title.trim() || '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs font-bold uppercase tracking-wide text-slate-500">LinkedIn</dt>
                  <dd className="mt-1 break-all text-blue-700">{form.linkedin_url.trim() || '—'}</dd>
                </div>
                {form.github_url.trim() ? (
                  <div>
                    <dt className="text-xs font-bold uppercase tracking-wide text-slate-500">GitHub</dt>
                    <dd className="mt-1 break-all text-slate-800">{form.github_url.trim()}</dd>
                  </div>
                ) : null}
              </div>
              <div className="space-y-4">
                <div>
                  <dt className="text-xs font-bold uppercase tracking-wide text-slate-500">Email</dt>
                  <dd className="mt-1 break-all font-medium text-slate-900">{form.email.trim() || '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs font-bold uppercase tracking-wide text-slate-500">Phone</dt>
                  <dd className="mt-1 font-medium text-slate-900">
                    {form.phone_country_code} {form.phone_number.trim() || '—'}
                  </dd>
                </div>
              </div>
            </dl>
          </div>
        }
      >
        <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
              <label className={labelCls} htmlFor="name_first">
                First name *
              </label>
              <input
                id="name_first"
                type="text"
                required
                value={form.name_first}
                onChange={(e) => update('name_first', e.target.value)}
                onBlur={() => blurField('name_first')}
                className={`${inputCls}${fieldRing(errors, 'name_first')}`}
                maxLength={100}
                aria-invalid={!!errors.name_first}
              />
              {errors.name_first ? <p className={fieldErrorCls}>{errors.name_first}</p> : null}
          </div>
          <div>
              <label className={labelCls} htmlFor="name_middle">
                Middle (optional)
              </label>
              <input
                id="name_middle"
                type="text"
                value={form.name_middle}
                onChange={(e) => update('name_middle', e.target.value)}
                onBlur={() => blurField('name_middle')}
                className={inputCls}
                maxLength={100}
              />
          </div>
          <div>
              <label className={labelCls} htmlFor="name_last">
                Last name *
              </label>
              <input
                id="name_last"
                type="text"
                required
                value={form.name_last}
                onChange={(e) => update('name_last', e.target.value)}
                onBlur={() => blurField('name_last')}
                className={`${inputCls}${fieldRing(errors, 'name_last')}`}
                maxLength={100}
                aria-invalid={!!errors.name_last}
              />
              {errors.name_last ? <p className={fieldErrorCls}>{errors.name_last}</p> : null}
          </div>
        </div>
          <div className="space-y-4 border-t border-slate-200/60 pt-6">
          <div>
            <label className={labelCls} htmlFor="title">
              Professional title *
            </label>
            <input
              id="title"
              type="text"
              required
              placeholder="e.g. Senior Software Engineer"
              value={form.title}
              onChange={(e) => update('title', e.target.value)}
              onBlur={() => blurField('title')}
              className={`${inputCls}${fieldRing(errors, 'title')}`}
              maxLength={200}
              aria-invalid={!!errors.title}
            />
            {errors.title ? <p className={fieldErrorCls}>{errors.title}</p> : null}
          </div>
          <div>
            <label className={`${labelCls} flex items-center gap-1.5`} htmlFor="email">
              <Mail className="h-3.5 w-3.5 text-slate-400" />
              Email *
            </label>
            <input
              id="email"
              type="email"
              required
              placeholder="you@example.com"
              value={form.email}
              onChange={(e) => update('email', e.target.value)}
              onBlur={() => blurField('email')}
              className={`${inputCls}${fieldRing(errors, 'email')}`}
              aria-invalid={!!errors.email}
            />
            {errors.email ? <p className={fieldErrorCls}>{errors.email}</p> : null}
          </div>
          <div className="flex flex-wrap gap-4">
            <div className="min-w-[120px] flex-1">
              <label className={`${labelCls} flex items-center gap-1.5`}>
                <Phone className="h-3.5 w-3.5 text-slate-400" />
                Country code *
              </label>
              <FancySelect
                value={form.phone_country_code}
                onChange={(next) => update('phone_country_code', next)}
                options={COUNTRY_CODES.map(({ code, country }) => ({
                  value: code,
                  label: `${code} ${country}`,
                }))}
                hasError={!!errors.phone_country_code}
              />
            </div>
            <div className="min-w-[180px] flex-[2]">
              <label className={labelCls} htmlFor="phone_number">
                Phone number *
              </label>
              <input
                id="phone_number"
                type="tel"
                required
                placeholder="123 456 7890"
                value={form.phone_number}
                onChange={(e) => update('phone_number', e.target.value)}
                onBlur={() => blurField('phone_number')}
                className={`${inputCls}${fieldRing(errors, 'phone_number')}`}
                aria-invalid={!!errors.phone_number}
              />
              {errors.phone_number ? <p className={fieldErrorCls}>{errors.phone_number}</p> : null}
            </div>
          </div>
          <div>
            <label className={`${labelCls} flex items-center gap-1.5`} htmlFor="linkedin_url">
              <Linkedin className="h-3.5 w-3.5 text-slate-400" />
              LinkedIn URL *
            </label>
            <input
              id="linkedin_url"
              type="url"
              required
              placeholder="https://linkedin.com/in/yourprofile"
              value={form.linkedin_url}
              onChange={(e) => update('linkedin_url', e.target.value)}
              onBlur={() => blurField('linkedin_url')}
              className={`${inputCls}${fieldRing(errors, 'linkedin_url')}`}
              aria-invalid={!!errors.linkedin_url}
            />
            {errors.linkedin_url ? <p className={fieldErrorCls}>{errors.linkedin_url}</p> : null}
          </div>
          <div>
            <label className={`${labelCls} flex items-center gap-1.5`} htmlFor="github_url">
              <Github className="h-3.5 w-3.5 text-slate-400" />
              GitHub (optional)
            </label>
            <input
              id="github_url"
              type="url"
              placeholder="https://github.com/username"
              value={form.github_url}
              onChange={(e) => update('github_url', e.target.value)}
              onBlur={() => blurField('github_url')}
              className={`${inputCls}${fieldRing(errors, 'github_url')}`}
              aria-invalid={!!errors.github_url}
            />
            {errors.github_url ? <p className={fieldErrorCls}>{errors.github_url}</p> : null}
          </div>
        </div>
        </div>
      </ProfileSection>

      <ProfileSection
        layoutClassName="h-full"
        icon={FileText}
        title="Profile summary"
        hint="Concise narrative the AI uses for role fit and narrative alignment."
        sectionId="summary"
        isEditing={sectionEditing.summary}
        onEdit={() => setSectionEditing((s) => ({ ...s, summary: true }))}
        onCancel={() => cancelSectionEdit('summary')}
        onSave={() => saveSection('summary')}
        saving={savingSection === 'summary'}
        viewContent={
          <div>
            {form.profile_summary.trim() ? (
              <p className="whitespace-pre-wrap text-slate-800">{form.profile_summary}</p>
            ) : (
              <p className="text-slate-400">No summary yet</p>
            )}
            <p className="mt-2 text-xs text-slate-500">{form.profile_summary.length} / 5000 characters</p>
          </div>
        }
      >
        <textarea
          rows={5}
          required
          value={form.profile_summary}
          onChange={(e) => update('profile_summary', e.target.value)}
          onBlur={() => blurField('profile_summary')}
          className={`${inputCls} resize-y min-h-[120px]${fieldRing(errors, 'profile_summary')}`}
          placeholder="What you do, domains you excel in, and impact you drive…"
          maxLength={5000}
          aria-invalid={!!errors.profile_summary}
        />
        {errors.profile_summary ? <p className={fieldErrorCls}>{errors.profile_summary}</p> : null}
        <p className="mt-1 text-xs text-slate-500">{form.profile_summary.length} / 5000</p>
      </ProfileSection>

      <ProfileSection
        layoutClassName="xl:col-span-2"
        icon={Code2}
        title="Technical skills"
        hint="Group tools by category for clearer skill match signals."
        sectionId="skills"
        isEditing={sectionEditing.skills}
        onEdit={() => setSectionEditing((s) => ({ ...s, skills: true }))}
        onCancel={() => cancelSectionEdit('skills')}
        onSave={() => saveSection('skills')}
        saving={savingSection === 'skills'}
        viewContent={
          <div className="space-y-2">
            {form.technical_skills.some((t) => t.category.trim() || t.skills.trim()) ? (
              form.technical_skills.map((t, i) =>
                t.category.trim() || t.skills.trim() ? (
                  <div key={i} className="rounded-lg border border-blue-100/80 bg-blue-50/40 px-3 py-2">
                    <span className="text-xs font-bold uppercase text-blue-800">{t.category.trim() || 'Category'}</span>
                    <p className="mt-1 text-sm text-slate-800">{t.skills.trim() || '—'}</p>
                  </div>
                ) : null,
              )
            ) : (
              <p className="text-slate-400">No skill groups yet</p>
            )}
          </div>
        }
      >
        {form.technical_skills.map((t, i) => (
          <div
            key={i}
            className="mb-3 flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-slate-50/80 p-4 last:mb-0"
            style={{ animationDelay: `${Math.min(i * 35, 200)}ms` }}
          >
            <div className="min-w-[140px] flex-1">
              <input
                type="text"
                placeholder="Category (e.g. Languages)"
                value={t.category}
                onChange={(e) => {
                  const next = [...form.technical_skills];
                  next[i] = { ...next[i], category: e.target.value };
                  update('technical_skills', next);
                }}
                onBlur={() => blurField(`skills_${i}_category`)}
                className={`${inputCls} w-full${fieldRing(errors, `skills_${i}_category`)}`}
                maxLength={100}
                aria-invalid={!!errors[`skills_${i}_category`]}
              />
              {errors[`skills_${i}_category`] ? <p className={fieldErrorCls}>{errors[`skills_${i}_category`]}</p> : null}
            </div>
            <div className="min-w-[180px] flex-[2]">
              <input
                type="text"
                placeholder="Skills (comma-separated)"
                value={t.skills}
                onChange={(e) => {
                  const next = [...form.technical_skills];
                  next[i] = { ...next[i], skills: e.target.value };
                  update('technical_skills', next);
                }}
                onBlur={() => blurField(`skills_${i}_skills`)}
                className={`${inputCls} w-full${fieldRing(errors, `skills_${i}_skills`)}`}
                maxLength={500}
                aria-invalid={!!errors[`skills_${i}_skills`]}
              />
              {errors[`skills_${i}_skills`] ? <p className={fieldErrorCls}>{errors[`skills_${i}_skills`]}</p> : null}
            </div>
            <button type="button" onClick={() => update('technical_skills', form.technical_skills.filter((_, j) => j !== i))} className={removeIconBtn} aria-label="Remove skill block">
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
        <button type="button" onClick={() => update('technical_skills', [...form.technical_skills, emptyTechSkill()])} className={addRowBtn}>
          <Plus className="h-4 w-4 transition group-hover:rotate-90" />
          Add skill block
        </button>
      </ProfileSection>

      <ProfileSection
        layoutClassName="xl:col-span-2"
        icon={Briefcase}
        title="Work experience"
        hint="Most recent roles first help the model understand your trajectory."
        sectionId="work"
        isEditing={sectionEditing.work}
        onEdit={() => setSectionEditing((s) => ({ ...s, work: true }))}
        onCancel={() => cancelSectionEdit('work')}
        onSave={() => saveSection('work')}
        saving={savingSection === 'work'}
        viewContent={
          <ul className="space-y-3">
            {form.work_experience.some((w) => w.company_name.trim() || w.job_title.trim()) ? (
              form.work_experience.map((w, i) =>
                w.company_name.trim() || w.job_title.trim() ? (
                  <li key={i} className="rounded-lg border border-slate-100 bg-white/70 px-3 py-2">
                    <p className="font-semibold text-slate-900">
                      {w.job_title.trim() || 'Role'} <span className="font-normal text-slate-500">at</span>{' '}
                      {w.company_name.trim() || '—'}
                    </p>
                    <p className="text-xs text-slate-600">
                      {formatMonthLabel(w.period_start ?? '')} – {formatMonthLabel(w.period_end ?? '')}
                      {w.location?.trim() ? ` · ${w.location.trim()}` : ''}
                      {w.job_type?.trim() ? ` · ${w.job_type}` : ''}
                    </p>
                    {w.description?.trim() ? <p className="mt-1 text-sm text-slate-700 line-clamp-3">{w.description}</p> : null}
                  </li>
                ) : null,
              )
            ) : (
              <li className="text-slate-400">No roles yet</li>
            )}
          </ul>
        }
      >
        {form.work_experience.map((w, i) => (
          <div
            key={i}
            className="mb-4 space-y-3 rounded-xl border border-slate-200 bg-slate-50/80 p-4 last:mb-0"
            style={{ animationDelay: `${Math.min(i * 40, 240)}ms` }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <input
                  type="text"
                  placeholder="Company name *"
                  value={w.company_name}
                  onChange={(e) => {
                    const next = [...form.work_experience];
                    next[i] = { ...next[i], company_name: e.target.value };
                    update('work_experience', next);
                  }}
                  onBlur={() => blurField(`work_${i}_company_name`)}
                  className={`${inputCls} w-full${fieldRing(errors, `work_${i}_company_name`)}`}
                  aria-invalid={!!errors[`work_${i}_company_name`]}
                />
                {errors[`work_${i}_company_name`] ? <p className={fieldErrorCls}>{errors[`work_${i}_company_name`]}</p> : null}
              </div>
              <div>
                <input
                  type="text"
                  placeholder="Job title *"
                  value={w.job_title}
                  onChange={(e) => {
                    const next = [...form.work_experience];
                    next[i] = { ...next[i], job_title: e.target.value };
                    update('work_experience', next);
                  }}
                  onBlur={() => blurField(`work_${i}_job_title`)}
                  className={`${inputCls} w-full${fieldRing(errors, `work_${i}_job_title`)}`}
                  aria-invalid={!!errors[`work_${i}_job_title`]}
                />
                {errors[`work_${i}_job_title`] ? <p className={fieldErrorCls}>{errors[`work_${i}_job_title`]}</p> : null}
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <MonthField
                  placeholder="Start month"
                  value={w.period_start ?? ''}
                  onChange={(nextValue) => {
                    const next = [...form.work_experience];
                    next[i] = { ...next[i], period_start: nextValue };
                    update('work_experience', next);
                  }}
                  hasError={!!errors[`work_${i}_period_end`]}
                  onPick={() => window.setTimeout(() => blurField(`work_${i}_period_end`), 0)}
                />
              </div>
              <div>
                <MonthField
                  placeholder="End month"
                  value={w.period_end ?? ''}
                  onChange={(nextValue) => {
                    const next = [...form.work_experience];
                    next[i] = { ...next[i], period_end: nextValue };
                    update('work_experience', next);
                  }}
                  hasError={!!errors[`work_${i}_period_end`]}
                  onPick={() => window.setTimeout(() => blurField(`work_${i}_period_end`), 0)}
                />
                {errors[`work_${i}_period_end`] ? <p className={fieldErrorCls}>{errors[`work_${i}_period_end`]}</p> : null}
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <input
                  type="text"
                  placeholder="Location *"
                  value={w.location}
                  onChange={(e) => {
                    const next = [...form.work_experience];
                    next[i] = { ...next[i], location: e.target.value };
                    update('work_experience', next);
                  }}
                  onBlur={() => blurField(`work_${i}_location`)}
                  className={`${inputCls} w-full${fieldRing(errors, `work_${i}_location`)}`}
                  aria-invalid={!!errors[`work_${i}_location`]}
                />
                {errors[`work_${i}_location`] ? <p className={fieldErrorCls}>{errors[`work_${i}_location`]}</p> : null}
            </div>
              <div>
                <FancySelect
                  value={w.job_type ?? ''}
                  onChange={(nextValue) => {
                    const next = [...form.work_experience];
                    next[i] = { ...next[i], job_type: nextValue };
                    update('work_experience', next);
                    window.setTimeout(() => blurField(`work_${i}_job_type`), 0);
                  }}
                  placeholder="Work arrangement *"
                  options={JOB_TYPES.map((jt) => ({ value: jt, label: jt }))}
                  hasError={!!errors[`work_${i}_job_type`]}
                />
                {errors[`work_${i}_job_type`] ? <p className={fieldErrorCls}>{errors[`work_${i}_job_type`]}</p> : null}
              </div>
            </div>
            <textarea
              rows={3}
              placeholder="Impact, scope, stack…"
              value={w.description}
              onChange={(e) => {
                const next = [...form.work_experience];
                next[i] = { ...next[i], description: e.target.value };
                update('work_experience', next);
              }}
              className={`${inputCls} resize-y`}
            />
            <button
              type="button"
              onClick={() => update('work_experience', form.work_experience.filter((_, j) => j !== i))}
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-rose-600 transition hover:text-rose-700"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Remove role
            </button>
          </div>
        ))}
        <button type="button" onClick={() => update('work_experience', [...form.work_experience, emptyWorkExp()])} className={addRowBtn}>
          <Plus className="h-4 w-4 transition group-hover:rotate-90" />
          Add work experience
        </button>
      </ProfileSection>

      <ProfileSection
        layoutClassName="xl:col-span-2"
        icon={GraduationCap}
        title="Education"
        hint="Degrees and programs you want the AI to weigh."
        sectionId="education"
        isEditing={sectionEditing.education}
        onEdit={() => setSectionEditing((s) => ({ ...s, education: true }))}
        onCancel={() => cancelSectionEdit('education')}
        onSave={() => saveSection('education')}
        saving={savingSection === 'education'}
        viewContent={
          <ul className="space-y-3">
            {form.education.some((ed) => ed.university_name.trim() || ed.degree.trim()) ? (
              form.education.map((ed, i) =>
                ed.university_name.trim() || ed.degree.trim() ? (
                  <li key={i} className="rounded-lg border border-slate-100 bg-white/70 px-3 py-2">
                    <p className="font-semibold text-slate-900">{ed.degree.trim() || 'Degree'} — {ed.university_name.trim() || '—'}</p>
                    <p className="text-xs text-slate-600">
                      {formatMonthLabel(ed.period_start ?? '')} – {formatMonthLabel(ed.period_end ?? '')}
                      {ed.mark?.trim() ? ` · ${ed.mark.trim()}` : ''}
                      {ed.location?.trim() ? ` · ${ed.location.trim()}` : ''}
                    </p>
                    {ed.description?.trim() ? <p className="mt-1 text-sm text-slate-700">{ed.description}</p> : null}
                  </li>
                ) : null,
              )
            ) : (
              <li className="text-slate-400">No education entries yet</li>
            )}
          </ul>
        }
      >
        {form.education.map((ed, i) => (
          <div
            key={i}
            className="mb-4 space-y-3 rounded-xl border border-slate-200 bg-slate-50/80 p-4 last:mb-0"
            style={{ animationDelay: `${Math.min(i * 40, 240)}ms` }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <input
                  type="text"
                  placeholder="University *"
                  value={ed.university_name}
                  onChange={(e) => {
                    const next = [...form.education];
                    next[i] = { ...next[i], university_name: e.target.value };
                    update('education', next);
                  }}
                  onBlur={() => blurField(`edu_${i}_university`)}
                  className={`${inputCls} w-full${fieldRing(errors, `edu_${i}_university`)}`}
                  aria-invalid={!!errors[`edu_${i}_university`]}
                />
                {errors[`edu_${i}_university`] ? <p className={fieldErrorCls}>{errors[`edu_${i}_university`]}</p> : null}
              </div>
              <div>
                <input
                  type="text"
                  placeholder="Degree *"
                  value={ed.degree}
                  onChange={(e) => {
                    const next = [...form.education];
                    next[i] = { ...next[i], degree: e.target.value };
                    update('education', next);
                  }}
                  onBlur={() => blurField(`edu_${i}_degree`)}
                  className={`${inputCls} w-full${fieldRing(errors, `edu_${i}_degree`)}`}
                  aria-invalid={!!errors[`edu_${i}_degree`]}
                />
                {errors[`edu_${i}_degree`] ? <p className={fieldErrorCls}>{errors[`edu_${i}_degree`]}</p> : null}
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <input
                type="text"
                placeholder="GPA / honors"
                value={ed.mark}
                onChange={(e) => {
                  const next = [...form.education];
                  next[i] = { ...next[i], mark: e.target.value };
                  update('education', next);
                }}
                className={inputCls}
              />
              <input
                type="text"
                placeholder="Location"
                value={ed.location}
                onChange={(e) => {
                  const next = [...form.education];
                  next[i] = { ...next[i], location: e.target.value };
                  update('education', next);
                }}
                className={inputCls}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <MonthField
                placeholder="Start month"
                value={ed.period_start ?? ''}
                onChange={(nextValue) => {
                  const next = [...form.education];
                  next[i] = { ...next[i], period_start: nextValue };
                  update('education', next);
                }}
                hasError={!!errors[`edu_${i}_period_end`]}
                onPick={() => window.setTimeout(() => blurField(`edu_${i}_period_end`), 0)}
              />
              <div>
                <MonthField
                  placeholder="End month"
                  value={ed.period_end ?? ''}
                  onChange={(nextValue) => {
                    const next = [...form.education];
                    next[i] = { ...next[i], period_end: nextValue };
                    update('education', next);
                  }}
                  hasError={!!errors[`edu_${i}_period_end`]}
                  onPick={() => window.setTimeout(() => blurField(`edu_${i}_period_end`), 0)}
                />
                {errors[`edu_${i}_period_end`] ? <p className={fieldErrorCls}>{errors[`edu_${i}_period_end`]}</p> : null}
            </div>
            </div>
            <textarea
              rows={2}
              placeholder="Coursework, activities…"
              value={ed.description}
              onChange={(e) => {
                const next = [...form.education];
                next[i] = { ...next[i], description: e.target.value };
                update('education', next);
              }}
              className={`${inputCls} resize-y`}
            />
            <button
              type="button"
              onClick={() => update('education', form.education.filter((_, j) => j !== i))}
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-rose-600 transition hover:text-rose-700"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Remove entry
            </button>
          </div>
        ))}
        <button type="button" onClick={() => update('education', [...form.education, emptyEducation()])} className={addRowBtn}>
          <Plus className="h-4 w-4 transition group-hover:rotate-90" />
          Add education
        </button>
      </ProfileSection>

      <ProfileSection
        layoutClassName="h-full"
        icon={Award}
        title="Certificates"
        hint="Licenses and certifications that differentiate you."
        sectionId="certificates"
        isEditing={sectionEditing.certificates}
        onEdit={() => setSectionEditing((s) => ({ ...s, certificates: true }))}
        onCancel={() => cancelSectionEdit('certificates')}
        onSave={() => saveSection('certificates')}
        saving={savingSection === 'certificates'}
        viewContent={
          <ul className="list-inside list-disc space-y-1 text-slate-800">
            {form.certificates.some((c) => c.name.trim()) ? (
              form.certificates.map((c, i) =>
                c.name.trim() ? (
                  <li key={i} className="text-sm font-medium">
                    {c.name.trim()}
                  </li>
                ) : null,
              )
            ) : (
              <li className="list-none text-slate-400">No certificates yet</li>
            )}
          </ul>
        }
      >
        {form.certificates.map((c, i) => (
          <div key={i} className="mb-2 flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50/80 p-3">
            <div className="min-w-0 flex-1">
              <input
                type="text"
                placeholder="Certificate name"
                value={c.name}
                onChange={(e) => {
                  const next = [...form.certificates];
                  next[i] = { name: e.target.value };
                  update('certificates', next);
                }}
                onBlur={() => blurField(`cert_${i}_name`)}
                className={`${inputCls} w-full${fieldRing(errors, `cert_${i}_name`)}`}
                maxLength={220}
                aria-invalid={!!errors[`cert_${i}_name`]}
              />
              {errors[`cert_${i}_name`] ? <p className={fieldErrorCls}>{errors[`cert_${i}_name`]}</p> : null}
            </div>
            <button type="button" onClick={() => update('certificates', form.certificates.filter((_, j) => j !== i))} className={removeIconBtn}>
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
        <button type="button" onClick={() => update('certificates', [...form.certificates, emptyCert()])} className={addRowBtn}>
          <Plus className="h-4 w-4 transition group-hover:rotate-90" />
          Add certificate
        </button>
      </ProfileSection>

      <ProfileSection
        layoutClassName="h-full"
        icon={ListTree}
        title="Extra"
        hint="Any other lines you want included in your candidate narrative."
        sectionId="extra"
        isEditing={sectionEditing.extra}
        onEdit={() => setSectionEditing((s) => ({ ...s, extra: true }))}
        onCancel={() => cancelSectionEdit('extra')}
        onSave={() => saveSection('extra')}
        saving={savingSection === 'extra'}
        viewContent={
          <ul className="space-y-1">
            {form.extra.some((line) => line.trim()) ? (
              form.extra.map((line, i) =>
                line.trim() ? (
                  <li key={i} className="rounded-md border border-slate-100 bg-white/60 px-2 py-1 text-sm text-slate-800">
                    {line.trim()}
                  </li>
                ) : null,
              )
            ) : (
              <li className="list-none text-slate-400">No extra lines yet</li>
            )}
          </ul>
        }
      >
        {form.extra.map((line, i) => (
          <div key={i} className="mb-2 flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50/80 p-3">
            <div className="min-w-0 flex-1">
              <input
                type="text"
                placeholder="Languages, volunteering, awards…"
                value={line}
                onChange={(e) => {
                  const next = [...form.extra];
                  next[i] = e.target.value;
                  update('extra', next);
                }}
                onBlur={() => blurField(`extra_${i}`)}
                className={`${inputCls} w-full${fieldRing(errors, `extra_${i}`)}`}
                maxLength={500}
                aria-invalid={!!errors[`extra_${i}`]}
              />
              {errors[`extra_${i}`] ? <p className={fieldErrorCls}>{errors[`extra_${i}`]}</p> : null}
            </div>
            <button type="button" onClick={() => update('extra', form.extra.filter((_, j) => j !== i))} className={removeIconBtn}>
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
        <button type="button" onClick={() => update('extra', [...form.extra, ''])} className={addRowBtn}>
          <Plus className="h-4 w-4 transition group-hover:rotate-90" />
          Add line
        </button>
      </ProfileSection>

      </div>
  );
}
