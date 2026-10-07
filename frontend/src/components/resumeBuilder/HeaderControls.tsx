import { PanelTop } from 'lucide-react';
import type { LayoutConfig, ResumeDesign } from '../../types/resumeDesign';
import { headerPadSides } from '../../types/resumeDesign';
import { BoxSidesField, ControlCard, Segmented, Slider } from './controls';

/** Name and contact block: alignment, band, contact display and spacing. */
export function HeaderControls({
  design,
  onLayout,
}: {
  design: ResumeDesign;
  onLayout: (patch: Partial<LayoutConfig>) => void;
}) {
  const l = design.layout;
  const band = l.header_background !== 'none';
  return (
    <ControlCard icon={PanelTop} title="Header">
      <Segmented<LayoutConfig['header_align']>
        label="Alignment"
        value={l.header_align}
        options={[
          { value: 'left', label: 'Left' },
          { value: 'center', label: 'Center' },
        ]}
        onChange={(v) => onLayout({ header_align: v })}
      />
      <Segmented<LayoutConfig['header_background']>
        label="Background"
        value={l.header_background}
        options={[
          { value: 'none', label: 'None' },
          { value: 'soft', label: 'Soft' },
          { value: 'solid', label: 'Solid' },
          { value: 'image', label: 'Image' },
        ]}
        onChange={(v) => onLayout({ header_background: v })}
      />
      <Segmented<LayoutConfig['contact_layout']>
        label="Contact details"
        value={l.contact_layout}
        options={[
          { value: 'inline', label: 'One line' },
          { value: 'stacked', label: 'Stacked' },
        ]}
        onChange={(v) => onLayout({ contact_layout: v })}
      />
      <Segmented<LayoutConfig['contact_icons']>
        label="Contact icons"
        value={l.contact_icons === 'outline' || l.contact_icons === 'none' ? l.contact_icons : 'brand'}
        options={[
          { value: 'brand', label: 'Color' },
          { value: 'outline', label: 'Outline' },
          { value: 'none', label: 'Off' },
        ]}
        onChange={(v) => onLayout({ contact_icons: v })}
      />
      {band ? (
        <BoxSidesField
          label="Band padding"
          suffix=" (pt)"
          values={headerPadSides(l)}
          min={0}
          max={72}
          step={1}
          onChangeSide={(side, v) => onLayout({ [`header_pad_${side}_pt`]: v } as Partial<LayoutConfig>)}
          onChangeAll={(v) =>
            onLayout({ header_padding_pt: v, header_pad_top_pt: v, header_pad_right_pt: v, header_pad_bottom_pt: v, header_pad_left_pt: v })
          }
        />
      ) : (
        <Slider
          label="Space below header"
          value={l.header_pad_bottom_pt ?? l.header_padding_pt}
          min={0}
          max={32}
          step={1}
          suffix=" pt"
          onChange={(v) =>
            onLayout({ header_padding_pt: v, header_pad_top_pt: v, header_pad_bottom_pt: v, header_pad_left_pt: null, header_pad_right_pt: null })
          }
        />
      )}
    </ControlCard>
  );
}
