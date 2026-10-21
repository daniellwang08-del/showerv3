import { BookOpen, FolderGit2, HandHeart, Languages, LayoutList, Sparkles, Trash2, Trophy } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type {
  ExtraItem,
  ExtraSection,
  ExtraSectionKind,
  ExtraSectionLayout,
  ResumeDesign,
  SectionId,
} from '../../types/resumeDesign';
import { EXTRA_KIND_TITLES, emptyExtraItem, extraDisplayTitle } from '../../types/resumeDesign';
import { formatFlexiblePeriod } from '../../utils/flexibleDate';
import { FlexibleDatePicker } from '../shared/FlexibleDatePicker';
import { AddButton, Collapsible, RowTools } from './ContentControls';
import { ControlCard, Segmented } from './controls';
import { PlainField } from './RichTextField';

const MAX_ITEMS = 40;
const MAX_SECTIONS = 12;

interface KindMeta {
  icon: LucideIcon;
  hint: string;
  item: string;
  subtitle: string;
}

export const EXTRA_KINDS: Record<ExtraSectionKind, KindMeta> = {
  projects: { icon: FolderGit2, hint: 'Side projects, open source, case studies', item: 'Project', subtitle: 'Role or tech stack' },
  languages: { icon: Languages, hint: 'Spoken languages and proficiency', item: 'Language', subtitle: 'Proficiency' },
  awards: { icon: Trophy, hint: 'Honors, scholarships, competitions', item: 'Award', subtitle: 'Issuer' },
  volunteering: { icon: HandHeart, hint: 'Community and nonprofit work', item: 'Role', subtitle: 'Organization' },
  publications: { icon: BookOpen, hint: 'Papers, articles, talks', item: 'Title', subtitle: 'Publisher or venue' },
  interests: { icon: Sparkles, hint: 'Hobbies that add personality', item: 'Interest', subtitle: 'Detail' },
  custom: { icon: LayoutList, hint: 'Anything else, with your own heading', item: 'Title', subtitle: 'Subtitle' },
};

export const EXTRA_KIND_ORDER: ExtraSectionKind[] = [
  'projects',
  'languages',
  'awards',
  'volunteering',
  'publications',
  'interests',
  'custom',
];

const LAYOUTS: { value: ExtraSectionLayout; label: string; title: string }[] = [
  { value: 'entries', label: 'Entries', title: 'Title, dates, details and bullets' },
  { value: 'list', label: 'List', title: 'One bulleted line per item' },
  { value: 'inline', label: 'Inline', title: 'One line, items separated by dots' },
  { value: 'columns', label: 'Columns', title: 'Two-column grid' },
];

const LAYOUT_HINT: Record<ExtraSectionLayout, string> = {
  entries: 'Shows every field.',
  list: 'Shows title, subtitle, dates and link.',
  inline: 'Shows title and subtitle on one line.',
  columns: 'Shows title and subtitle in two columns.',
};

function replaceAt<T>(arr: T[], i: number, v: T): T[] {
  const next = arr.slice();
  next[i] = v;
  return next;
}

function moveAt<T>(arr: T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (j < 0 || j >= arr.length) return arr;
  const next = arr.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/** Same limits as `ExtraItem` on the backend, so autosave never fails validation. */
function clampItem(i: ExtraItem): ExtraItem {
  return {
    title: i.title.slice(0, 200),
    subtitle: i.subtitle.slice(0, 200),
    date_start: i.date_start.slice(0, 40),
    date_end: i.date_end.slice(0, 40),
    location: i.location.slice(0, 120),
    url: i.url.slice(0, 500),
    bullets: i.bullets.slice(0, 12).map((b) => b.slice(0, 600)),
  };
}

function ItemFields({
  item,
  layout,
  meta,
  onChange: emit,
}: {
  item: ExtraItem;
  layout: ExtraSectionLayout;
  meta: KindMeta;
  onChange: (next: ExtraItem) => void;
}) {
  const onChange = (next: ExtraItem) => emit(clampItem(next));
  const full = layout === 'entries';
  const dated = full || layout === 'list';
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <PlainField label={meta.item} value={item.title} onChange={(v) => onChange({ ...item, title: v })} />
        <PlainField label={meta.subtitle} value={item.subtitle} onChange={(v) => onChange({ ...item, subtitle: v })} />
      </div>
      {dated && (
        <div className="grid grid-cols-2 gap-2">
          <FlexibleDatePicker
            label="Start (optional)"
            value={item.date_start}
            onChange={(v) => onChange({ ...item, date_start: v })}
            placeholder="Start"
          />
          <FlexibleDatePicker
            label={item.date_start ? 'End (blank means present)' : 'Date (optional)'}
            value={item.date_end}
            onChange={(v) => onChange({ ...item, date_end: v })}
            placeholder={item.date_start ? 'Present' : 'Date'}
          />
        </div>
      )}
      {dated && (
        <div className={full ? 'grid grid-cols-2 gap-2' : undefined}>
          {full && <PlainField label="Location" value={item.location} onChange={(v) => onChange({ ...item, location: v })} />}
          <PlainField label="Link (optional)" value={item.url} onChange={(v) => onChange({ ...item, url: v })} placeholder="github.com/you/project" />
        </div>
      )}
      {full && (
        <label className="block">
          <div className="mb-1 text-xs font-medium text-foreground/80">Bullets, one per line</div>
          <textarea
            rows={3}
            value={item.bullets.join('\n')}
            onChange={(e) => onChange({ ...item, bullets: e.target.value.split('\n').slice(0, 12) })}
            placeholder="Cut build time 40% by caching dependencies"
            className="block w-full resize-y rounded-lg border border-input bg-background px-2.5 py-1.5 text-xs leading-relaxed text-foreground placeholder:text-muted-foreground/70 focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30"
          />
        </label>
      )}
    </>
  );
}

function ExtraSectionCard({
  section,
  onUpdate,
  onRemove,
}: {
  section: ExtraSection;
  onUpdate: (patch: Partial<Omit<ExtraSection, 'id'>>) => void;
  onRemove: () => void;
}) {
  const meta = EXTRA_KINDS[section.kind];
  const setItems = (items: ExtraItem[]) => onUpdate({ items });
  return (
    <ControlCard
      icon={meta.icon}
      title={extraDisplayTitle(section)}
      description={meta.hint}
      actions={
        <button
          type="button"
          onClick={onRemove}
          title="Remove section"
          aria-label={`Remove ${extraDisplayTitle(section)} section`}
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-destructive"
        >
          <Trash2 size={14} />
        </button>
      }
    >
      <div className="grid grid-cols-1 gap-2 @[28rem]:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <PlainField
          label="Heading"
          value={section.title}
          placeholder={EXTRA_KIND_TITLES[section.kind]}
          onChange={(v) => onUpdate({ title: v.slice(0, 60) })}
        />
        <Segmented<ExtraSectionLayout> label="Layout" value={section.layout} options={LAYOUTS} onChange={(layout) => onUpdate({ layout })} />
      </div>
      <p className="-mt-1 text-[11px] text-muted-foreground">{LAYOUT_HINT[section.layout]}</p>
      <div className="space-y-2">
        {section.items.map((item, i) => (
          <Collapsible
            key={i}
            title={item.title || `${meta.item} ${i + 1}`}
            subtitle={[item.subtitle, formatFlexiblePeriod(item.date_start, item.date_end)].filter(Boolean).join('  \u00b7  ')}
            defaultOpen={i === section.items.length - 1 && !item.title}
            tools={
              <RowTools
                index={i}
                count={section.items.length}
                onMove={(dir) => setItems(moveAt(section.items, i, dir))}
                onRemove={() => setItems(section.items.filter((_, idx) => idx !== i))}
                label={meta.item.toLowerCase()}
              />
            }
          >
            <ItemFields item={item} layout={section.layout} meta={meta} onChange={(next) => setItems(replaceAt(section.items, i, next))} />
          </Collapsible>
        ))}
      </div>
      {section.items.length < MAX_ITEMS && (
        <AddButton label={`Add ${meta.item.toLowerCase()}`} onClick={() => setItems([...section.items, emptyExtraItem()])} />
      )}
    </ControlCard>
  );
}

/** Picker for a new section type; shared by the Sections and Content tabs. */
export function AddSectionPicker({
  count,
  onAdd,
}: {
  count: number;
  onAdd: (kind: ExtraSectionKind) => void;
}) {
  if (count >= MAX_SECTIONS) {
    return <p className="text-xs text-muted-foreground">You have reached the limit of {MAX_SECTIONS} extra sections.</p>;
  }
  return (
    <div className="grid grid-cols-2 gap-1.5 @[30rem]:grid-cols-3">
      {EXTRA_KIND_ORDER.map((kind) => {
        const Icon = EXTRA_KINDS[kind].icon;
        return (
          <button
            key={kind}
            type="button"
            onClick={() => onAdd(kind)}
            title={EXTRA_KINDS[kind].hint}
            className="flex min-w-0 items-center gap-2 rounded-lg border border-dashed border-input px-2.5 py-2 text-left text-xs font-medium text-foreground/80 transition hover:border-brand hover:bg-brand-soft hover:text-brand"
          >
            <Icon className="size-3.5 shrink-0" />
            <span className="truncate">{EXTRA_KIND_TITLES[kind]}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Content editor for the user's extra sections (projects, languages, awards...). */
export function ExtraSectionsEditor({
  design,
  onAdd,
  onUpdate,
  onRemove,
}: {
  design: ResumeDesign;
  onAdd: (kind: ExtraSectionKind) => void;
  onUpdate: (id: SectionId, patch: Partial<Omit<ExtraSection, 'id'>>) => void;
  onRemove: (id: SectionId) => void;
}) {
  const extras = design.extra_sections ?? [];
  return (
    <>
      {extras.map((section) => (
        <ExtraSectionCard
          key={section.id}
          section={section}
          onUpdate={(patch) => onUpdate(section.id, patch)}
          onRemove={() => onRemove(section.id)}
        />
      ))}
      <ControlCard icon={LayoutList} title="Add a section" description="Extra sections save automatically and print in the PDF and Word file.">
        <AddSectionPicker count={extras.length} onAdd={onAdd} />
      </ControlCard>
    </>
  );
}
