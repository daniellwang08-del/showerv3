import { EMPLOYMENT_TYPES, JOB_TYPES, type EducationBlock, type ProfileFormData, type WorkExperienceBlock } from '@/types/profile';
import { formatFlexibleDate, formatFlexiblePeriod } from '@/utils/flexibleDate';
import { emptyEducation, emptyWorkExp } from '@/utils/profileFormData';
import { renderRich } from '@/utils/richText';
import {
  AddRowButton,
  DateField,
  EmptyValue,
  EntryHeader,
  LineListEditor,
  SelectField,
  TextField,
  moveItem,
} from './fields';
import { MAX_CONTRIBUTIONS, type EditorProps } from './profileSections';

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const JOB_TYPE_OPTIONS = JOB_TYPES.map((v) => ({ value: v, label: capitalize(v) }));
const EMPLOYMENT_OPTIONS = EMPLOYMENT_TYPES.map((v) => ({ value: v, label: capitalize(v) }));

/* ------------------------------------------------------------- Experience */

const BULLET_PREFIX = /^[-•*]\s+/;

function BulletList({ lines }: { lines: string[] }) {
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5 marker:text-muted-foreground">
      {lines.map((l, j) => (
        <li key={j}>{renderRich(l.trim().replace(BULLET_PREFIX, ''))}</li>
      ))}
    </ul>
  );
}

/** Résumé imports often store bullet lists as "- item" lines in free-text fields. */
function ProseOrBullets({ text }: { text?: string | null }) {
  const lines = (text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  if (lines.every((l) => BULLET_PREFIX.test(l))) return <BulletList lines={lines} />;
  return <p className="leading-relaxed whitespace-pre-line">{text}</p>;
}

export function ExperienceView({ form }: { form: ProfileFormData }) {
  const rows = form.work_experience.filter((w) => w.company_name.trim() && w.job_title.trim());
  if (!rows.length) return <EmptyValue>No work experience yet.</EmptyValue>;
  return (
    <ol className="flex flex-col divide-y">
      {rows.map((w, i) => {
        const contributions = (w.contributions ?? []).filter((c) => c.trim());
        const hasStructured = !!(w.project_title?.trim() || w.project_intro?.trim() || contributions.length);
        const meta = [w.location, w.job_type && capitalize(w.job_type), w.employment_type && capitalize(w.employment_type)]
          .map((s) => (s ?? '').trim())
          .filter((s, idx, all) => s && all.findIndex((o) => o.toLowerCase() === s.toLowerCase()) === idx);
        return (
          <li key={i} className="flex flex-col gap-2 py-4 text-sm first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
              <h3 className="font-medium">
                {w.job_title} <span className="text-muted-foreground">at</span> {w.company_name}
              </h3>
              <span className="text-muted-foreground tabular-nums">{formatFlexiblePeriod(w.period_start, w.period_end)}</span>
            </div>
            {meta.length ? <p className="text-muted-foreground">{meta.join(' · ')}</p> : null}
            {w.project_title?.trim() ? <p className="font-medium">{w.project_title}</p> : null}
            <ProseOrBullets text={w.project_intro} />
            {contributions.length ? <BulletList lines={contributions} /> : null}
            {!hasStructured ? <ProseOrBullets text={w.description} /> : null}
            {w.used_skills?.trim() ? (
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">Skills:</span> {w.used_skills}
              </p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export function ExperienceEdit({ form, update, err, touch }: EditorProps) {
  const rows = form.work_experience;
  const set = (i: number, patch: Partial<WorkExperienceBlock>) =>
    update({ work_experience: rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const remove = (i: number) => {
    const next = rows.filter((_, j) => j !== i);
    update({ work_experience: next.length ? next : [emptyWorkExp()] });
  };
  return (
    <div className="flex flex-col gap-4">
      {rows.map((w, i) => {
        const k = (f: string) => `work_${i}_${f}`;
        const id = (f: string) => `profile-work-${i}-${f}`;
        const title = [w.job_title.trim(), w.company_name.trim()].filter(Boolean).join(' · ') || `Role ${i + 1}`;
        return (
          <div key={i} className="flex flex-col gap-3 rounded-lg border p-3" data-testid={`work-entry-${i}`}>
            <EntryHeader
              title={title}
              index={i}
              count={rows.length}
              noun="role"
              onMove={(d) => update({ work_experience: moveItem(rows, i, d) })}
              onRemove={() => remove(i)}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                id={id('company')}
                label="Company"
                value={w.company_name}
                onChange={(v) => set(i, { company_name: v })}
                onBlur={() => touch(k('company_name'))}
                error={err(k('company_name'))}
              />
              <TextField
                id={id('title')}
                label="Job title"
                value={w.job_title}
                onChange={(v) => set(i, { job_title: v })}
                onBlur={() => touch(k('job_title'))}
                error={err(k('job_title'))}
              />
              <DateField
                id={id('start')}
                label="Start"
                value={w.period_start ?? ''}
                onChange={(v) => set(i, { period_start: v })}
                onBlur={() => touch(k('period_start'))}
                error={err(k('period_start'))}
              />
              <DateField
                id={id('end')}
                label="End"
                allowPresent
                value={w.period_end ?? ''}
                onChange={(v) => set(i, { period_end: v })}
                onBlur={() => touch(k('period_end'))}
                error={err(k('period_end'))}
              />
              <TextField
                id={id('location')}
                label="Location"
                placeholder="e.g. Austin, TX"
                value={w.location ?? ''}
                onChange={(v) => set(i, { location: v })}
              />
              <div className="grid grid-cols-2 gap-3">
                <SelectField
                  id={id('job-type')}
                  label="Arrangement"
                  value={w.job_type ?? ''}
                  onChange={(v) => set(i, { job_type: v })}
                  options={JOB_TYPE_OPTIONS}
                  error={err(k('job_type'))}
                />
                <SelectField
                  id={id('employment')}
                  label="Employment"
                  value={w.employment_type ?? ''}
                  onChange={(v) => set(i, { employment_type: v })}
                  options={EMPLOYMENT_OPTIONS}
                />
              </div>
            </div>
            <TextField
              id={id('project-title')}
              label="Project title"
              maxLength={300}
              value={w.project_title ?? ''}
              onChange={(v) => set(i, { project_title: v })}
              onBlur={() => touch(k('project_title'))}
              error={err(k('project_title'))}
            />
            <TextField
              id={id('project-intro')}
              label="Project intro"
              multiline
              rows={3}
              maxLength={2000}
              value={w.project_intro ?? ''}
              onChange={(v) => set(i, { project_intro: v })}
              onBlur={() => touch(k('project_intro'))}
              error={err(k('project_intro'))}
            />
            <LineListEditor
              id={id('contrib')}
              label="Contribution"
              lines={w.contributions ?? ['']}
              onChange={(contributions) => set(i, { contributions })}
              max={MAX_CONTRIBUTIONS}
              addLabel="Add contribution"
              placeholder="e.g. Cut p99 latency by **40%** by…"
              description="One bullet per line. Supports **bold**, *italic* and __underline__."
              error={err(k('contributions'))}
            />
            <TextField
              id={id('skills')}
              label="Skills used"
              placeholder="e.g. Python, Kafka, AWS"
              value={w.used_skills ?? ''}
              onChange={(v) => set(i, { used_skills: v })}
            />
          </div>
        );
      })}
      <AddRowButton onClick={() => update({ work_experience: [...rows, emptyWorkExp()] })}>Add role</AddRowButton>
    </div>
  );
}

/* -------------------------------------------------------------- Education */

function educationPeriod(e: EducationBlock): string {
  return [formatFlexibleDate(e.period_start), formatFlexibleDate(e.period_end)].filter(Boolean).join(' – ');
}

export function EducationView({ form }: { form: ProfileFormData }) {
  const rows = form.education.filter((e) => e.university_name.trim() && e.degree.trim());
  if (!rows.length) return <EmptyValue>No education yet.</EmptyValue>;
  return (
    <ol className="flex flex-col divide-y">
      {rows.map((e, i) => {
        const meta = [e.location, e.mark].map((s) => (s ?? '').trim()).filter(Boolean);
        return (
          <li key={i} className="flex flex-col gap-1 py-3 text-sm first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
              <h3 className="font-medium">
                {e.degree} <span className="text-muted-foreground">·</span> {e.university_name}
              </h3>
              <span className="text-muted-foreground tabular-nums">{educationPeriod(e)}</span>
            </div>
            {meta.length ? <p className="text-muted-foreground">{meta.join(' · ')}</p> : null}
            {e.description?.trim() ? <p className="leading-relaxed whitespace-pre-line">{e.description}</p> : null}
          </li>
        );
      })}
    </ol>
  );
}

export function EducationEdit({ form, update, err, touch }: EditorProps) {
  const rows = form.education;
  const set = (i: number, patch: Partial<EducationBlock>) =>
    update({ education: rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const remove = (i: number) => {
    const next = rows.filter((_, j) => j !== i);
    update({ education: next.length ? next : [emptyEducation()] });
  };
  return (
    <div className="flex flex-col gap-4">
      {rows.map((e, i) => {
        const k = (f: string) => `edu_${i}_${f}`;
        const id = (f: string) => `profile-edu-${i}-${f}`;
        const title = [e.degree.trim(), e.university_name.trim()].filter(Boolean).join(' · ') || `School ${i + 1}`;
        return (
          <div key={i} className="flex flex-col gap-3 rounded-lg border p-3">
            <EntryHeader
              title={title}
              index={i}
              count={rows.length}
              noun="school"
              onMove={(d) => update({ education: moveItem(rows, i, d) })}
              onRemove={() => remove(i)}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                id={id('university')}
                label="University"
                value={e.university_name}
                onChange={(v) => set(i, { university_name: v })}
                onBlur={() => touch(k('university'))}
                error={err(k('university'))}
              />
              <TextField
                id={id('degree')}
                label="Degree"
                value={e.degree}
                onChange={(v) => set(i, { degree: v })}
                onBlur={() => touch(k('degree'))}
                error={err(k('degree'))}
              />
              <DateField
                id={id('start')}
                label="Start"
                value={e.period_start ?? ''}
                onChange={(v) => set(i, { period_start: v })}
                onBlur={() => touch(k('period_start'))}
                error={err(k('period_start'))}
              />
              <DateField
                id={id('end')}
                label="End"
                value={e.period_end ?? ''}
                onChange={(v) => set(i, { period_end: v })}
                onBlur={() => touch(k('period_end'))}
                error={err(k('period_end'))}
              />
              <TextField
                id={id('location')}
                label="Location"
                value={e.location ?? ''}
                onChange={(v) => set(i, { location: v })}
              />
              <TextField
                id={id('mark')}
                label="Grade / GPA"
                placeholder="e.g. 3.8 GPA"
                value={e.mark ?? ''}
                onChange={(v) => set(i, { mark: v })}
              />
            </div>
            <TextField
              id={id('description')}
              label="Description"
              multiline
              rows={2}
              value={e.description ?? ''}
              onChange={(v) => set(i, { description: v })}
            />
          </div>
        );
      })}
      <AddRowButton onClick={() => update({ education: [...rows, emptyEducation()] })}>Add school</AddRowButton>
    </div>
  );
}
