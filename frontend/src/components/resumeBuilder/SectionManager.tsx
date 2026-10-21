import { useState } from 'react';
import { Check, ChevronDown, ChevronUp, Eye, EyeOff, ListOrdered, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import type { ExtraSectionKind, ResumeDesign, SectionId } from '../../types/resumeDesign';
import { SECTION_LABELS, isExtraSectionId, sectionTitle } from '../../types/resumeDesign';
import { ControlCard } from './controls';
import { AddSectionPicker } from './ExtraSectionsEditor';
import { filledExtraItems } from './ResumePreview';

const LOCKED: SectionId[] = ['summary', 'experience'];

const ICON_BTN =
  'inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30';

function TitleEditor({
  initial,
  placeholder,
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <form
      className="flex min-w-0 flex-1 items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        onCommit(value);
      }}
    >
      <input
        autoFocus
        value={value}
        maxLength={60}
        placeholder={placeholder}
        aria-label="Section heading"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
        onBlur={() => onCommit(value)}
        className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm text-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30"
      />
      <button type="submit" className={ICON_BTN} aria-label="Save heading" onMouseDown={(e) => e.preventDefault()}>
        <Check size={14} />
      </button>
    </form>
  );
}

/** Order, show/hide and rename every section; add or remove extra sections. */
export function SectionManager({
  design,
  onToggle,
  onMove,
  onRename,
  onAdd,
  onRemove,
}: {
  design: ResumeDesign;
  onToggle: (id: SectionId) => void;
  onMove: (id: SectionId, dir: -1 | 1) => void;
  onRename: (id: SectionId, title: string) => void;
  onAdd: (kind: ExtraSectionKind) => void;
  onRemove: (id: SectionId) => void;
}) {
  const order = design.layout.section_order;
  const hidden = new Set(design.layout.hidden_sections);
  const extras = design.extra_sections ?? [];
  const [editing, setEditing] = useState<SectionId | null>(null);
  const [adding, setAdding] = useState(false);

  return (
    <ControlCard
      icon={ListOrdered}
      title="Sections"
      description="Reorder, rename, hide, or add sections. Summary and experience are required."
    >
      <ul className="space-y-1.5">
        {order.map((id, idx) => {
          const isHidden = hidden.has(id);
          const extra = isExtraSectionId(id) ? extras.find((s) => s.id === id) : undefined;
          const locked = LOCKED.includes(id);
          const title = sectionTitle(design, id);
          const defaultTitle = isExtraSectionId(id) ? title : SECTION_LABELS[id];
          const renamed = !extra && Boolean(design.sections.titles?.[id]);
          const empty = extra ? filledExtraItems(extra).length === 0 : false;
          return (
            <li
              key={id}
              className={`flex min-w-0 items-center gap-1.5 rounded-lg border px-2 py-1.5 ${
                isHidden ? 'border-dashed bg-muted/60' : 'bg-card'
              }`}
            >
              <div className="flex shrink-0 flex-col">
                <button
                  type="button"
                  disabled={idx === 0}
                  onClick={() => onMove(id, -1)}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                  aria-label={`Move ${title} up`}
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  type="button"
                  disabled={idx === order.length - 1}
                  onClick={() => onMove(id, 1)}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                  aria-label={`Move ${title} down`}
                >
                  <ChevronDown size={14} />
                </button>
              </div>
              {editing === id ? (
                <TitleEditor
                  initial={extra ? extra.title : design.sections.titles?.[id] ?? title}
                  placeholder={defaultTitle}
                  onCommit={(v) => {
                    onRename(id, v);
                    setEditing(null);
                  }}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setEditing(id)}
                    title="Rename heading"
                    className={`group flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm font-medium ${
                      isHidden ? 'text-muted-foreground' : 'text-foreground'
                    }`}
                  >
                    <span className="truncate">{title}</span>
                    <Pencil size={12} className="shrink-0 opacity-0 transition group-hover:opacity-60" aria-hidden="true" />
                  </button>
                  {renamed && (
                    <button
                      type="button"
                      className={ICON_BTN}
                      title={`Reset to "${SECTION_LABELS[id as keyof typeof SECTION_LABELS]}"`}
                      aria-label={`Reset ${title} heading`}
                      onClick={() => onRename(id, '')}
                    >
                      <RotateCcw size={13} />
                    </button>
                  )}
                  {extra && empty && (
                    <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground" title="Empty sections are not printed">
                      Empty
                    </span>
                  )}
                </>
              )}
              {extra && (
                <button
                  type="button"
                  className={`${ICON_BTN} hover:text-destructive`}
                  title="Remove section"
                  aria-label={`Remove ${title} section`}
                  onClick={() => onRemove(id)}
                >
                  <Trash2 size={13} />
                </button>
              )}
              <button
                type="button"
                disabled={locked}
                onClick={() => onToggle(id)}
                title={locked ? 'Required section' : isHidden ? 'Show section' : 'Hide section'}
                aria-label={locked ? `${title} is required` : isHidden ? `Show ${title}` : `Hide ${title}`}
                className={`rounded-md p-1 transition ${
                  locked
                    ? 'cursor-not-allowed text-muted-foreground/50'
                    : isHidden
                      ? 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      : 'text-brand hover:bg-brand-soft'
                }`}
              >
                {isHidden ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </li>
          );
        })}
      </ul>
      {adding ? (
        <AddSectionPicker
          count={extras.length}
          onAdd={(kind) => {
            onAdd(kind);
            setAdding(false);
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-input px-3 py-1.5 text-xs font-semibold text-muted-foreground transition hover:border-brand hover:text-brand"
        >
          <Plus size={13} /> Add section
        </button>
      )}
    </ControlCard>
  );
}
