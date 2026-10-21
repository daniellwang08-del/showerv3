import { Heading } from 'lucide-react';
import type { FontOption, HeadingAlign, HeadingStyle, LayoutConfig, ResumeDesign, Typography } from '../../types/resumeDesign';
import { effectiveHeadingStyle } from '../../types/resumeDesign';
import { ControlCard, Segmented, Slider } from './controls';
import { sectionHeadingStyle } from './ResumePreview';

const STYLES: { id: HeadingStyle; label: string }[] = [
  { id: 'plain', label: 'Plain' },
  { id: 'underline', label: 'Underline' },
  { id: 'overline', label: 'Top rule' },
  { id: 'double', label: 'Double rule' },
  { id: 'left_bar', label: 'Side bar' },
  { id: 'tint', label: 'Tinted band' },
  { id: 'solid', label: 'Solid band' },
  { id: 'boxed', label: 'Boxed' },
];

const SELECT =
  'h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-xs text-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30';

/** Heading look: a visual style picker, then case, alignment, font, size and tracking. */
export function HeadingControls({
  design,
  fonts,
  onTypography,
  onLayout,
}: {
  design: ResumeDesign;
  fonts: FontOption[];
  onTypography: (patch: Partial<Typography>) => void;
  onLayout: (patch: Partial<LayoutConfig>) => void;
}) {
  const t = design.typography;
  const l = design.layout;
  const current = effectiveHeadingStyle(l);
  const tracking = t.heading_tracking_em ?? (t.uppercase_headings ? 0.04 : 0);

  return (
    <ControlCard icon={Heading} title="Section headings" description="Applies to every section heading." wide>
      <div role="radiogroup" aria-label="Heading style" className="grid grid-cols-2 gap-1.5 @[30rem]:grid-cols-4">
        {STYLES.map((s) => {
          const active = current === s.id;
          const sample = sectionHeadingStyle(
            { ...design, layout: { ...l, heading_style: s.id, heading_align: 'left' } },
            false,
          );
          return (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={s.label}
              // accent_rule mirrors the choice for older readers of the design.
              onClick={() => onLayout({ heading_style: s.id, accent_rule: s.id !== 'plain' })}
              className={`flex min-w-0 flex-col gap-1.5 rounded-lg border p-2 text-left transition outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                active ? 'border-brand ring-1 ring-brand/40' : 'hover:border-foreground/20'
              }`}
            >
              <span className="block rounded bg-white px-1.5 py-2" aria-hidden="true">
                <span style={{ ...sample, display: 'block', fontSize: 10.5, lineHeight: 1.25 }}>Experience</span>
              </span>
              <span className={`truncate text-[11px] font-medium ${active ? 'text-brand' : 'text-muted-foreground'}`}>{s.label}</span>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-3 @[30rem]:grid-cols-2">
        <Segmented<'upper' | 'title'>
          label="Case"
          value={t.uppercase_headings ? 'upper' : 'title'}
          options={[
            { value: 'upper', label: 'UPPERCASE' },
            { value: 'title', label: 'Title Case' },
          ]}
          onChange={(v) => onTypography({ uppercase_headings: v === 'upper' })}
        />
        <Segmented<HeadingAlign>
          label="Alignment"
          value={l.heading_align ?? 'left'}
          options={[
            { value: 'left', label: 'Left' },
            { value: 'center', label: 'Centered' },
          ]}
          onChange={(v) => onLayout({ heading_align: v })}
        />
        <label className="block min-w-0">
          <div className="mb-1 text-xs font-medium text-foreground/80">Heading font</div>
          <select
            className={SELECT}
            value={t.heading_font_family ?? ''}
            onChange={(e) => onTypography({ heading_font_family: e.target.value || null })}
          >
            <option value="">Same as body ({t.font_family})</option>
            {(['serif', 'sans'] as const).map((cat) => (
              <optgroup key={cat} label={cat === 'serif' ? 'Serif' : 'Sans serif'}>
                {fonts
                  .filter((f) => f.category === cat)
                  .map((f) => (
                    <option key={f.id} value={f.family}>
                      {f.label}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
        <Slider
          label="Heading size"
          value={t.heading_scale}
          min={1}
          max={2.2}
          step={0.05}
          format={(v) => `${v.toFixed(2)}\u00d7 body`}
          onChange={(v) => onTypography({ heading_scale: v })}
        />
        <Slider
          label="Letter spacing"
          value={tracking}
          min={0}
          max={0.3}
          step={0.01}
          format={(v) => (v === 0 ? 'None' : `${v.toFixed(2)} em`)}
          onChange={(v) => onTypography({ heading_tracking_em: v })}
        />
      </div>
    </ControlCard>
  );
}
