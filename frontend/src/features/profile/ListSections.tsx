import { Badge } from '@/components/ui/badge';
import type { CertificateBlock, ProfileFormData, TechnicalSkillBlock } from '@/types/profile';
import { formatFlexibleDate } from '@/utils/flexibleDate';
import { emptyCert, emptyTechSkill } from '@/utils/profileFormData';
import { renderRich } from '@/utils/richText';
import { AddRowButton, DateField, EmptyValue, EntryHeader, LineListEditor, TextField } from './fields';
import type { EditorProps } from './profileSections';

/* ----------------------------------------------------------------- Skills */

export function SkillsView({ form }: { form: ProfileFormData }) {
  const rows = form.technical_skills.filter((t) => t.category.trim() && t.skills.trim());
  if (!rows.length) return <EmptyValue>No skill groups yet.</EmptyValue>;
  return (
    <dl className="flex flex-col gap-3 text-sm">
      {rows.map((t, i) => (
        <div key={i} className="grid gap-1.5 sm:grid-cols-[10rem_1fr] sm:gap-4">
          <dt className="font-medium">{t.category}</dt>
          <dd className="flex flex-wrap gap-1.5">
            {t.skills
              .split(/[,;\n]/)
              .map((s) => s.trim())
              .filter(Boolean)
              .map((s, j) => (
                <Badge key={j} variant="secondary">
                  {s}
                </Badge>
              ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function SkillsEdit({ form, update, err, touch }: EditorProps) {
  const rows = form.technical_skills;
  const set = (i: number, patch: Partial<TechnicalSkillBlock>) =>
    update({ technical_skills: rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const remove = (i: number) => {
    const next = rows.filter((_, j) => j !== i);
    update({ technical_skills: next.length ? next : [emptyTechSkill()] });
  };
  return (
    <div className="flex flex-col gap-4">
      {rows.map((t, i) => (
        <div key={i} className="flex flex-col gap-3 rounded-lg border p-3">
          <EntryHeader title={t.category.trim() || `Skill group ${i + 1}`} index={i} count={rows.length} noun="skill group" onRemove={() => remove(i)} />
          <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
            <TextField
              id={`profile-skills-${i}-category`}
              label="Category"
              placeholder="e.g. Languages"
              value={t.category}
              onChange={(v) => set(i, { category: v })}
              onBlur={() => touch(`skills_${i}_category`)}
              error={err(`skills_${i}_category`)}
            />
            <TextField
              id={`profile-skills-${i}-skills`}
              label="Skills"
              placeholder="e.g. Python, TypeScript, Go"
              value={t.skills}
              onChange={(v) => set(i, { skills: v })}
              onBlur={() => touch(`skills_${i}_skills`)}
              error={err(`skills_${i}_skills`)}
            />
          </div>
        </div>
      ))}
      <AddRowButton onClick={() => update({ technical_skills: [...rows, emptyTechSkill()] })}>Add skill group</AddRowButton>
    </div>
  );
}

/* --------------------------------------------------------- Certifications */

function certHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

export function CertificationsView({ form }: { form: ProfileFormData }) {
  const rows = form.certificates.filter((c) => c.name.trim());
  if (!rows.length) return <EmptyValue>No certifications yet.</EmptyValue>;
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {rows.map((c, i) => (
        <li key={i} className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium">{c.name}</span>
          {c.issued_at?.trim() ? (
            <span className="text-muted-foreground tabular-nums">{formatFlexibleDate(c.issued_at)}</span>
          ) : null}
          {c.url?.trim() ? (
            <a
              href={certHref(c.url.trim())}
              target="_blank"
              rel="noreferrer"
              className="text-brand underline-offset-4 hover:underline"
            >
              Credential
            </a>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function CertificationsEdit({ form, update, err, touch }: EditorProps) {
  const rows = form.certificates;
  const set = (i: number, patch: Partial<CertificateBlock>) =>
    update({ certificates: rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const remove = (i: number) => {
    const next = rows.filter((_, j) => j !== i);
    update({ certificates: next.length ? next : [emptyCert()] });
  };
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">Rows without a name are skipped when you save.</p>
      {rows.map((c, i) => (
        <div key={i} className="flex flex-col gap-3 rounded-lg border p-3">
          <EntryHeader title={c.name.trim() || `Certification ${i + 1}`} index={i} count={rows.length} noun="certification" onRemove={() => remove(i)} />
          <TextField
            id={`profile-cert-${i}-name`}
            label="Name"
            value={c.name}
            onChange={(v) => set(i, { name: v })}
            onBlur={() => touch(`cert_${i}_name`)}
            error={err(`cert_${i}_name`)}
            placeholder="e.g. AWS Solutions Architect – Professional"
          />
          <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
            <DateField
              id={`profile-cert-${i}-issued`}
              label="Issued"
              value={c.issued_at ?? ''}
              onChange={(v) => set(i, { issued_at: v })}
              onBlur={() => touch(`cert_${i}_issued_at`)}
              error={err(`cert_${i}_issued_at`)}
            />
            <TextField
              id={`profile-cert-${i}-url`}
              label="Credential URL"
              type="url"
              value={c.url ?? ''}
              onChange={(v) => set(i, { url: v })}
              onBlur={() => touch(`cert_${i}_url`)}
              error={err(`cert_${i}_url`)}
              placeholder="https://…"
            />
          </div>
        </div>
      ))}
      <AddRowButton onClick={() => update({ certificates: [...rows, emptyCert()] })}>Add certification</AddRowButton>
    </div>
  );
}

/* ------------------------------------------------------------- Additional */

export function AdditionalView({ form }: { form: ProfileFormData }) {
  const rows = form.extra.filter((x) => x.trim());
  if (!rows.length) return <EmptyValue>Nothing added yet.</EmptyValue>;
  return (
    <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm marker:text-muted-foreground">
      {rows.map((x, i) => (
        <li key={i}>{renderRich(x)}</li>
      ))}
    </ul>
  );
}

export function AdditionalEdit({ form, update, err }: EditorProps) {
  return (
    <LineListEditor
      id="profile-extra"
      label="Line"
      lines={form.extra}
      onChange={(extra) => update({ extra })}
      maxLength={500}
      addLabel="Add line"
      placeholder="e.g. Languages: English (native), Spanish · Awards: Hackathon winner 2023"
      description="Languages, awards, publications, volunteering, one item per line."
      errorFor={(i) => err(`extra_${i}`)}
    />
  );
}
