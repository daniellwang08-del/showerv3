import { useEffect, useState } from 'react';
import {
  Award,
  Briefcase,
  ChevronDown,
  ChevronUp,
  GraduationCap,
  ListChecks,
  Loader2,
  Plus,
  Save,
  Trash2,
  User,
  Wrench,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { ResumeContent } from '../../types/resumeDesign';
import { ControlCard } from './controls';
import { PlainField, RichTextField } from './RichTextField';
import { ContributionsField } from './ContributionsField';
import { FlexibleDatePicker } from '../shared/FlexibleDatePicker';
import { formatFlexiblePeriod } from '../../utils/flexibleDate';
import {
  emptyContentCert,
  emptyContentEducation,
  emptyContentSkill,
  emptyContentWork,
} from '../../utils/resumeContent';
import { selectIsDirty, useResumeBuilderStore } from '../../stores/resumeBuilderStore';
import { contributionsToEditorText, editorTextToContributions } from '../../utils/workExperience';

type Work = ResumeContent['work_experience'][number];
type Skill = ResumeContent['technical_skills'][number];
type Edu = ResumeContent['education'][number];

function replaceAt<T>(arr: T[], i: number, v: T): T[] {
  const next = arr.slice();
  next[i] = v;
  return next;
}
function removeAt<T>(arr: T[], i: number): T[] {
  return arr.filter((_, idx) => idx !== i);
}
function move<T>(arr: T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (j < 0 || j >= arr.length) return arr;
  const next = arr.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

function RowTools({
  index,
  count,
  onMove,
  onRemove,
  label,
}: {
  index: number;
  count: number;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  label: string;
}) {
  const ico = 'inline-flex h-6 w-6 items-center justify-center rounded text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30 disabled:hover:bg-transparent';
  return (
    <div className="flex items-center gap-0.5">
      <button type="button" className={ico} title="Move up" disabled={index === 0} onClick={() => onMove(-1)}>
        <ChevronUp size={14} />
      </button>
      <button type="button" className={ico} title="Move down" disabled={index === count - 1} onClick={() => onMove(1)}>
        <ChevronDown size={14} />
      </button>
      <button type="button" className={`${ico} hover:text-red-600`} title={`Remove ${label}`} onClick={onRemove}>
        <Trash2 size={13} />
      </button>
    </div>
  );
}

function AddButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-500 transition hover:border-blue-400 hover:text-blue-600"
    >
      <Plus size={13} /> {label}
    </button>
  );
}

function Collapsible({ title, subtitle, tools, children, defaultOpen = false }: { title: string; subtitle?: string; tools: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <button type="button" onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {open ? <ChevronUp size={14} className="text-slate-400" /> : <ChevronDown size={14} className="text-slate-400" />}
          <span className="min-w-0">
            <span className="block truncate text-xs font-semibold text-slate-800">{title || 'Untitled'}</span>
            {subtitle ? <span className="block truncate text-[11px] text-slate-400">{subtitle}</span> : null}
          </span>
        </button>
        {tools}
      </div>
      {open ? <div className="space-y-2.5 border-t border-slate-200 px-2.5 py-2.5">{children}</div> : null}
    </div>
  );
}

function workFingerprint(w: Work): string {
  return JSON.stringify({
    ...w,
    contributions: w.contributions ?? [],
  });
}

/** Local draft editor for one role — Save commits to the resume design (avoids per-keystroke autosave). */
function WorkExperienceEditor({
  value,
  index,
  count,
  onSave,
  onMove,
  onRemove,
}: {
  value: Work;
  index: number;
  count: number;
  onSave: (next: Work) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [contribText, setContribText] = useState(() => contributionsToEditorText(value.contributions));

  useEffect(() => {
    setDraft(value);
    setContribText(contributionsToEditorText(value.contributions));
  }, [value]);

  const pending: Work = { ...draft, contributions: editorTextToContributions(contribText) };
  const dirty = workFingerprint(pending) !== workFingerprint(value);

  const patchDraft = (p: Partial<Work>) => setDraft((d) => ({ ...d, ...p }));

  const saveBlock = () => {
    onSave({ ...draft, contributions: editorTextToContributions(contribText) });
  };

  const discard = () => {
    setDraft(value);
    setContribText(contributionsToEditorText(value.contributions));
  };

  return (
    <Collapsible
      title={draft.company_name || value.company_name || `Experience ${index + 1}`}
      subtitle={[
        draft.job_title || value.job_title,
        (draft.period_start || value.period_start) &&
          formatFlexiblePeriod(draft.period_start || value.period_start, draft.period_end || value.period_end),
      ]
        .filter(Boolean)
        .join('  ·  ')}
      tools={
        <RowTools index={index} count={count} onMove={onMove} onRemove={onRemove} label="experience" />
      }
    >
      <div className="grid grid-cols-2 gap-2">
        <PlainField label="Company" value={draft.company_name} onChange={(v) => patchDraft({ company_name: v })} />
        <PlainField label="Role" value={draft.job_title} onChange={(v) => patchDraft({ job_title: v })} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <FlexibleDatePicker
          label="Start"
          value={draft.period_start}
          onChange={(v) => patchDraft({ period_start: v })}
          placeholder="Start date"
        />
        <FlexibleDatePicker
          label="End"
          value={draft.period_end}
          onChange={(v) => patchDraft({ period_end: v })}
          placeholder="Present"
          allowPresent
        />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <PlainField label="Location" value={draft.location} onChange={(v) => patchDraft({ location: v })} />
        <PlainField
          label="Arrangement"
          value={draft.job_type}
          onChange={(v) => patchDraft({ job_type: v })}
          placeholder="remote"
        />
        <PlainField
          label="Type"
          value={draft.employment_type}
          onChange={(v) => patchDraft({ employment_type: v })}
          placeholder="full-time"
        />
      </div>
      <PlainField label="Project title" value={draft.project_title} onChange={(v) => patchDraft({ project_title: v })} />
      <RichTextField
        label="Project intro"
        value={draft.project_intro}
        onChange={(v) => patchDraft({ project_intro: v })}
        rows={2}
      />
      <ContributionsField value={contribText} onChange={setContribText} rows={6} />
      <RichTextField
        label="Used skills"
        value={draft.used_skills}
        onChange={(v) => patchDraft({ used_skills: v })}
        rows={2}
        placeholder="React, Node, **AWS**"
      />

      <div
        className={`sticky bottom-1 flex flex-wrap items-center gap-2 rounded-lg border px-2.5 py-2 ${
          dirty ? 'border-amber-200 bg-amber-50/90' : 'border-slate-200 bg-white/90'
        }`}
      >
        <span className={`min-w-0 flex-1 text-[11px] font-medium ${dirty ? 'text-amber-800' : 'text-slate-500'}`}>
          {dirty
            ? 'Unsaved changes in this role — preview updates after Save'
            : 'Role saved to this resume'}
        </span>
        {dirty ? (
          <button
            type="button"
            onClick={discard}
            className="inline-flex h-8 items-center rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
          >
            Discard
          </button>
        ) : null}
        <button
          type="button"
          onClick={saveBlock}
          disabled={!dirty}
          className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold shadow-sm disabled:opacity-40 ${
            dirty
              ? 'border border-blue-600 bg-blue-600 text-white hover:bg-blue-700'
              : 'border border-slate-200 bg-slate-50 text-slate-500'
          }`}
        >
          <Save size={13} />
          Save role
        </button>
      </div>
    </Collapsible>
  );
}

export function ContentControls({
  content,
  onChange,
}: {
  content: ResumeContent;
  onChange: (next: ResumeContent) => void;
}) {
  const dirty = useResumeBuilderStore(selectIsDirty);
  const saving = useResumeBuilderStore((s) => s.saving);
  const save = useResumeBuilderStore((s) => s.save);
  const lastSavedAt = useResumeBuilderStore((s) => s.lastSavedAt);
  const patch = (p: Partial<ResumeContent>) => onChange({ ...content, ...p });

  // ---- Header ----
  const header = (
    <ControlCard icon={User} title="Header & contact">
      <div className="grid grid-cols-3 gap-2">
        <PlainField label="First" value={content.name_first} onChange={(v) => patch({ name_first: v })} />
        <PlainField label="Middle" value={content.name_middle} onChange={(v) => patch({ name_middle: v })} />
        <PlainField label="Last" value={content.name_last} onChange={(v) => patch({ name_last: v })} />
      </div>
      <PlainField label="Professional title" value={content.title} onChange={(v) => patch({ title: v })} />
      <div className="grid grid-cols-2 gap-2">
        <PlainField label="Email" value={content.email} onChange={(v) => patch({ email: v })} />
        <div className="grid grid-cols-[64px_1fr] gap-1.5">
          <PlainField label="Code" value={content.phone_country_code} onChange={(v) => patch({ phone_country_code: v })} placeholder="+1" />
          <PlainField label="Phone" value={content.phone_number} onChange={(v) => patch({ phone_number: v })} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <PlainField label="LinkedIn" value={content.linkedin_url} onChange={(v) => patch({ linkedin_url: v })} />
        <PlainField label="GitHub" value={content.github_url} onChange={(v) => patch({ github_url: v })} />
      </div>
    </ControlCard>
  );

  // ---- Summary ----
  const summary = (
    <ControlCard icon={User} title="Professional summary">
      <RichTextField value={content.profile_summary} onChange={(v) => patch({ profile_summary: v })} rows={5} placeholder="Write a punchy summary. Use **bold** for ATS keywords." />
    </ControlCard>
  );

  // ---- Skills ----
  const skills = (
    <ControlCard icon={Wrench} title="Technical skills">
      <div className="space-y-2">
        {content.technical_skills.map((s: Skill, i) => (
          <div key={i} className="rounded-xl border border-slate-200 bg-slate-50/60 p-2.5">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Category {i + 1}</span>
              <RowTools
                index={i}
                count={content.technical_skills.length}
                onMove={(dir) => patch({ technical_skills: move(content.technical_skills, i, dir) })}
                onRemove={() => patch({ technical_skills: removeAt(content.technical_skills, i) })}
                label="category"
              />
            </div>
            <div className="space-y-2">
              <PlainField label="Category" value={s.category} onChange={(v) => patch({ technical_skills: replaceAt(content.technical_skills, i, { ...s, category: v }) })} placeholder="e.g. Languages" />
              <PlainField label="Skills (comma separated)" value={s.skills} onChange={(v) => patch({ technical_skills: replaceAt(content.technical_skills, i, { ...s, skills: v }) })} placeholder="Python, Kafka, SQL" />
            </div>
          </div>
        ))}
      </div>
      <AddButton label="Add category" onClick={() => patch({ technical_skills: [...content.technical_skills, emptyContentSkill()] })} />
    </ControlCard>
  );

  // ---- Experience ----
  const updateWork = (i: number, w: Work) => patch({ work_experience: replaceAt(content.work_experience, i, w) });
  const experience = (
    <ControlCard icon={Briefcase} title="Work experience">
      <div className="space-y-2">
        {content.work_experience.map((w: Work, i) => (
          <WorkExperienceEditor
            key={i}
            value={w}
            index={i}
            count={content.work_experience.length}
            onSave={(next) => updateWork(i, next)}
            onMove={(dir) => patch({ work_experience: move(content.work_experience, i, dir) })}
            onRemove={() => patch({ work_experience: removeAt(content.work_experience, i) })}
          />
        ))}
      </div>
      <AddButton label="Add experience" onClick={() => patch({ work_experience: [...content.work_experience, emptyContentWork()] })} />
    </ControlCard>
  );

  // ---- Education ----
  const updateEdu = (i: number, e: Edu) => patch({ education: replaceAt(content.education, i, e) });
  const education = (
    <ControlCard icon={GraduationCap} title="Education">
      <div className="space-y-2">
        {content.education.map((e: Edu, i) => (
          <Collapsible
            key={i}
            title={e.university_name || `Education ${i + 1}`}
            subtitle={[e.degree, (e.period_start || e.period_end) && formatFlexiblePeriod(e.period_start, e.period_end)].filter(Boolean).join('  ·  ')}
            tools={
              <RowTools
                index={i}
                count={content.education.length}
                onMove={(dir) => patch({ education: move(content.education, i, dir) })}
                onRemove={() => patch({ education: removeAt(content.education, i) })}
                label="education"
              />
            }
          >
            <div className="grid grid-cols-2 gap-2">
              <PlainField label="University" value={e.university_name} onChange={(v) => updateEdu(i, { ...e, university_name: v })} />
              <PlainField label="Degree" value={e.degree} onChange={(v) => updateEdu(i, { ...e, degree: v })} />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <FlexibleDatePicker
                label="Start"
                value={e.period_start}
                onChange={(v) => updateEdu(i, { ...e, period_start: v })}
                placeholder="Start"
              />
              <FlexibleDatePicker
                label="End"
                value={e.period_end}
                onChange={(v) => updateEdu(i, { ...e, period_end: v })}
                placeholder="End"
              />
              <PlainField label="Grade" value={e.mark} onChange={(v) => updateEdu(i, { ...e, mark: v })} />
            </div>
            <PlainField label="Location" value={e.location} onChange={(v) => updateEdu(i, { ...e, location: v })} />
            <RichTextField label="Description" value={e.description} onChange={(v) => updateEdu(i, { ...e, description: v })} rows={2} />
          </Collapsible>
        ))}
      </div>
      <AddButton label="Add education" onClick={() => patch({ education: [...content.education, emptyContentEducation()] })} />
    </ControlCard>
  );

  // ---- Certificates ----
  const updateCert = (i: number, cert: (typeof content.certificates)[number]) =>
    patch({ certificates: replaceAt(content.certificates, i, cert) });
  const certificates = (
    <ControlCard icon={Award} title="Certifications">
      <div className="space-y-2">
        {content.certificates.map((cert, i) => (
          <div key={i} className="rounded-lg border border-slate-200 bg-slate-50/70 p-2.5">
            <div className="flex items-start gap-1.5">
              <div className="min-w-0 flex-1 space-y-2">
                <PlainField
                  label="Name"
                  value={cert.name}
                  onChange={(v) => updateCert(i, { ...cert, name: v })}
                  placeholder="Certification name"
                />
                <div className="grid grid-cols-2 gap-2">
                  <FlexibleDatePicker
                    label="Issue date (optional)"
                    value={cert.issued_at || ''}
                    onChange={(v) => updateCert(i, { ...cert, issued_at: v })}
                    placeholder="Issue date"
                  />
                  <PlainField
                    label="Credential link (optional)"
                    value={cert.url || ''}
                    onChange={(v) => updateCert(i, { ...cert, url: v })}
                    placeholder="https://…"
                  />
                </div>
              </div>
              <div className="pt-5">
                <RowTools
                  index={i}
                  count={content.certificates.length}
                  onMove={(dir) => patch({ certificates: move(content.certificates, i, dir) })}
                  onRemove={() => patch({ certificates: removeAt(content.certificates, i) })}
                  label="certificate"
                />
              </div>
            </div>
          </div>
        ))}
      </div>
      <AddButton label="Add certification" onClick={() => patch({ certificates: [...content.certificates, emptyContentCert()] })} />
    </ControlCard>
  );

  return (
    <div className="space-y-4 pb-20">
      <div className="flex items-start gap-2 rounded-xl border border-blue-100 bg-blue-50/70 px-3 py-2 text-[11px] leading-snug text-blue-700">
        <ListChecks size={14} className="mt-0.5 shrink-0" />
        <span>
          Edits here apply to <strong>this resume design</strong>. Work experience roles use a local draft — click{' '}
          <strong>Save role</strong> to update the preview and persist. Select text and use <strong>B / I / U</strong>{' '}
          to format. Your master profile stays untouched.
        </span>
      </div>
      {header}
      {summary}
      {skills}
      {experience}
      {education}
      {certificates}

      <div className="sticky bottom-2 z-10 rounded-xl border border-slate-200 bg-white/95 p-3 shadow-lg backdrop-blur-sm">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1 text-xs text-slate-600">
            {saving ? (
              <span className="font-medium text-blue-700">Saving content…</span>
            ) : dirty ? (
              <span className="font-medium text-amber-800">Unsaved content changes</span>
            ) : lastSavedAt ? (
              <span className="font-medium text-emerald-700">Content saved</span>
            ) : (
              <span>Save to keep this resume’s content</span>
            )}
          </div>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!dirty || saving}
            className={`inline-flex h-9 items-center gap-1.5 rounded-lg px-4 text-sm font-semibold shadow-sm disabled:opacity-40 ${
              dirty
                ? 'border border-blue-600 bg-blue-600 text-white hover:bg-blue-700'
                : 'border border-slate-200 bg-slate-50 text-slate-500'
            }`}
          >
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
            Save content
          </button>
        </div>
      </div>
    </div>
  );
}
