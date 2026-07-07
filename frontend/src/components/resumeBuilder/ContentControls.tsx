import { useState } from 'react';
import {
  Award,
  Briefcase,
  ChevronDown,
  ChevronUp,
  GraduationCap,
  ListChecks,
  Plus,
  Trash2,
  User,
  Wrench,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { ResumeContent } from '../../types/resumeDesign';
import { ControlCard } from './controls';
import { PlainField, RichTextField } from './RichTextField';
import {
  emptyContentCert,
  emptyContentEducation,
  emptyContentSkill,
  emptyContentWork,
} from '../../utils/resumeContent';

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

function Collapsible({ title, subtitle, tools, children }: { title: string; subtitle?: string; tools: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
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

export function ContentControls({
  content,
  onChange,
}: {
  content: ResumeContent;
  onChange: (next: ResumeContent) => void;
}) {
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
              <RichTextField label="Skills (comma separated)" value={s.skills} onChange={(v) => patch({ technical_skills: replaceAt(content.technical_skills, i, { ...s, skills: v }) })} rows={2} placeholder="Python, **Kafka**, SQL" />
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
          <Collapsible
            key={i}
            title={w.company_name || `Experience ${i + 1}`}
            subtitle={[w.job_title, w.period_start && `${w.period_start} – ${w.period_end || 'Present'}`].filter(Boolean).join('  ·  ')}
            tools={
              <RowTools
                index={i}
                count={content.work_experience.length}
                onMove={(dir) => patch({ work_experience: move(content.work_experience, i, dir) })}
                onRemove={() => patch({ work_experience: removeAt(content.work_experience, i) })}
                label="experience"
              />
            }
          >
            <div className="grid grid-cols-2 gap-2">
              <PlainField label="Company" value={w.company_name} onChange={(v) => updateWork(i, { ...w, company_name: v })} />
              <PlainField label="Role" value={w.job_title} onChange={(v) => updateWork(i, { ...w, job_title: v })} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <PlainField label="Start" value={w.period_start} onChange={(v) => updateWork(i, { ...w, period_start: v })} placeholder="Jan 2022" />
              <PlainField label="End" value={w.period_end} onChange={(v) => updateWork(i, { ...w, period_end: v })} placeholder="Present" />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <PlainField label="Location" value={w.location} onChange={(v) => updateWork(i, { ...w, location: v })} />
              <PlainField label="Arrangement" value={w.job_type} onChange={(v) => updateWork(i, { ...w, job_type: v })} placeholder="remote" />
              <PlainField label="Type" value={w.employment_type} onChange={(v) => updateWork(i, { ...w, employment_type: v })} placeholder="full-time" />
            </div>
            <PlainField label="Project title" value={w.project_title} onChange={(v) => updateWork(i, { ...w, project_title: v })} />
            <RichTextField label="Project intro" value={w.project_intro} onChange={(v) => updateWork(i, { ...w, project_intro: v })} rows={2} />
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium text-slate-600">Key contributions</span>
              </div>
              <div className="space-y-2">
                {(w.contributions.length ? w.contributions : ['']).map((c, ci) => (
                  <div key={ci} className="flex items-start gap-1.5">
                    <span className="mt-2 text-slate-300">•</span>
                    <div className="min-w-0 flex-1">
                      <RichTextField
                        value={c}
                        rows={2}
                        onChange={(v) => updateWork(i, { ...w, contributions: replaceAt(w.contributions.length ? w.contributions : [''], ci, v) })}
                      />
                    </div>
                    <div className="pt-1">
                      <RowTools
                        index={ci}
                        count={Math.max(w.contributions.length, 1)}
                        onMove={(dir) => updateWork(i, { ...w, contributions: move(w.contributions, ci, dir) })}
                        onRemove={() => updateWork(i, { ...w, contributions: removeAt(w.contributions, ci) })}
                        label="bullet"
                      />
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-2">
                <AddButton label="Add bullet" onClick={() => updateWork(i, { ...w, contributions: [...w.contributions, ''] })} />
              </div>
            </div>
            <RichTextField label="Used skills" value={w.used_skills} onChange={(v) => updateWork(i, { ...w, used_skills: v })} rows={2} placeholder="React, Node, **AWS**" />
          </Collapsible>
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
            subtitle={[e.degree, e.period_start && `${e.period_start} – ${e.period_end || ''}`].filter(Boolean).join('  ·  ')}
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
              <PlainField label="Start" value={e.period_start} onChange={(v) => updateEdu(i, { ...e, period_start: v })} />
              <PlainField label="End" value={e.period_end} onChange={(v) => updateEdu(i, { ...e, period_end: v })} />
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
  const certificates = (
    <ControlCard icon={Award} title="Certifications">
      <div className="space-y-2">
        {content.certificates.map((cert, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <div className="min-w-0 flex-1">
              <PlainField value={cert.name} onChange={(v) => patch({ certificates: replaceAt(content.certificates, i, { name: v }) })} placeholder="Certification name" />
            </div>
            <RowTools
              index={i}
              count={content.certificates.length}
              onMove={(dir) => patch({ certificates: move(content.certificates, i, dir) })}
              onRemove={() => patch({ certificates: removeAt(content.certificates, i) })}
              label="certificate"
            />
          </div>
        ))}
      </div>
      <AddButton label="Add certification" onClick={() => patch({ certificates: [...content.certificates, emptyContentCert()] })} />
    </ControlCard>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-xl border border-blue-100 bg-blue-50/70 px-3 py-2 text-[11px] leading-snug text-blue-700">
        <ListChecks size={14} className="mt-0.5 shrink-0" />
        <span>
          Edits here apply to <strong>this resume design</strong> and update the preview instantly. Select text and use
          <strong> B / I / U</strong> to format. Your master profile stays untouched.
        </span>
      </div>
      {header}
      {summary}
      {skills}
      {experience}
      {education}
      {certificates}
    </div>
  );
}
