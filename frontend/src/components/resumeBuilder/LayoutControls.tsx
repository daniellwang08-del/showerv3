import { LayoutGrid } from 'lucide-react';
import type { LayoutConfig, ResumeDesign, SectionOptions } from '../../types/resumeDesign';
import { headerPadSides, marginSides } from '../../types/resumeDesign';
import { BoxSidesField, ControlCard, Segmented, Slider, Toggle } from './controls';

type Side = 'top' | 'right' | 'bottom' | 'left';
const MARGIN_FIELDS: Record<Side, 'margin_top_pt' | 'margin_right_pt' | 'margin_bottom_pt' | 'margin_left_pt'> = {
  top: 'margin_top_pt',
  right: 'margin_right_pt',
  bottom: 'margin_bottom_pt',
  left: 'margin_left_pt',
};
const HEADER_PAD_FIELDS: Record<
  Side,
  'header_pad_top_pt' | 'header_pad_right_pt' | 'header_pad_bottom_pt' | 'header_pad_left_pt'
> = {
  top: 'header_pad_top_pt',
  right: 'header_pad_right_pt',
  bottom: 'header_pad_bottom_pt',
  left: 'header_pad_left_pt',
};

export function LayoutControls({
  design,
  onLayout,
  onSections,
}: {
  design: ResumeDesign;
  onLayout: (patch: Partial<LayoutConfig>) => void;
  onSections: (patch: Partial<SectionOptions>) => void;
}) {
  const l = design.layout;
  const s = design.sections;
  return (
    <ControlCard icon={LayoutGrid} title="Layout">
      <Segmented
        label="Columns"
        value={l.columns}
        options={[
          { value: 1, label: 'Single' },
          { value: 2, label: 'Two-column' },
        ]}
        onChange={(v) => onLayout({ columns: v as 1 | 2 })}
      />
      <Segmented
        label="Header alignment"
        value={l.header_align}
        options={[
          { value: 'left', label: 'Left' },
          { value: 'center', label: 'Center' },
        ]}
        onChange={(v) => onLayout({ header_align: v as LayoutConfig['header_align'] })}
      />
      <Segmented
        label="Header background"
        value={l.header_background}
        options={[
          { value: 'none', label: 'None' },
          { value: 'soft', label: 'Soft' },
          { value: 'solid', label: 'Solid' },
          { value: 'image', label: 'Image' },
        ]}
        onChange={(v) => onLayout({ header_background: v as LayoutConfig['header_background'] })}
      />
      {l.header_background === 'none' ? (
        // Without a band there is no padding box to inset; only the spacing below
        // the header is meaningful, so expose that as a single control.
        <Slider
          label="Header spacing"
          value={l.header_padding_pt}
          min={0}
          max={48}
          step={2}
          suffix=" pt"
          onChange={(v) => onLayout({ header_padding_pt: v })}
        />
      ) : (
        <BoxSidesField
          label="Header padding"
          suffix=" (pt)"
          values={headerPadSides(l)}
          min={0}
          max={120}
          step={1}
          onChangeSide={(side, v) => onLayout({ [HEADER_PAD_FIELDS[side]]: v })}
          onChangeAll={(v) =>
            onLayout({ header_pad_top_pt: v, header_pad_right_pt: v, header_pad_bottom_pt: v, header_pad_left_pt: v })
          }
        />
      )}
      <Segmented
        label="Contact details"
        value={l.contact_layout}
        options={[
          { value: 'inline', label: 'Inline' },
          { value: 'stacked', label: 'Stacked' },
        ]}
        onChange={(v) => onLayout({ contact_layout: v as LayoutConfig['contact_layout'] })}
      />
      <Segmented
        label="Contact icons"
        value={l.contact_icons}
        options={[
          { value: 'brand', label: 'Brand' },
          { value: 'outline', label: 'Outline' },
          { value: 'none', label: 'Off' },
        ]}
        onChange={(v) => onLayout({ contact_icons: v as LayoutConfig['contact_icons'] })}
      />
      <BoxSidesField
        label="Page margin"
        suffix=" (pt)"
        values={marginSides(l)}
        min={9}
        max={160}
        step={1}
        onChangeSide={(side, v) => onLayout({ [MARGIN_FIELDS[side]]: v })}
        onChangeAll={(v) => onLayout({ margin_top_pt: v, margin_right_pt: v, margin_bottom_pt: v, margin_left_pt: v })}
      />
      <Slider label="Section spacing" value={l.section_gap_pt} min={2} max={28} step={1} suffix=" pt"
        onChange={(v) => onLayout({ section_gap_pt: v })} />
      <Toggle label="Accent rule under headings" checked={l.accent_rule}
        onChange={(v) => onLayout({ accent_rule: v })} />
      <div className="space-y-2 border-t border-slate-100 pt-2">
        <Toggle label="Show role dates" checked={s.show_period} onChange={(v) => onSections({ show_period: v })} />
        <Toggle label="Show role location" checked={s.show_location} onChange={(v) => onSections({ show_location: v })} />
      </div>
    </ControlCard>
  );
}
