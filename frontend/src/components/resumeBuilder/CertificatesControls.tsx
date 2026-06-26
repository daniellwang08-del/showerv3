import { Award } from 'lucide-react';
import type { CertificatesStyle } from '../../types/resumeDesign';
import { ControlCard, Segmented, Toggle } from './controls';

export function CertificatesControls({
  style,
  onChange,
}: {
  style: CertificatesStyle;
  onChange: (patch: Partial<CertificatesStyle>) => void;
}) {
  const listLike = style.layout === 'list' || style.layout === 'grid';
  return (
    <ControlCard icon={Award} title="Certifications">
      <Segmented<CertificatesStyle['layout']>
        label="Layout"
        value={style.layout}
        onChange={(v) => onChange({ layout: v })}
        options={[
          { value: 'list', label: 'List' },
          { value: 'grid', label: 'Grid' },
          { value: 'chips', label: 'Chips' },
          { value: 'inline', label: 'Comma' },
          { value: 'pipe', label: 'Pipe' },
        ]}
      />
      {listLike ? (
        <Segmented<CertificatesStyle['marker']>
          label="Marker"
          value={style.marker}
          onChange={(v) => onChange({ marker: v })}
          options={[
            { value: 'dot', label: '\u2022' },
            { value: 'dash', label: '\u2013' },
            { value: 'check', label: '\u2713' },
            { value: 'arrow', label: '\u2192' },
            { value: 'square', label: '\u25AA' },
            { value: 'none', label: 'None' },
          ]}
        />
      ) : null}
      {listLike ? (
        <Segmented<CertificatesStyle['columns']>
          label="Columns"
          value={style.columns}
          onChange={(v) => onChange({ columns: v })}
          options={[
            { value: 1, label: '1' },
            { value: 2, label: '2' },
          ]}
        />
      ) : null}
      <Segmented<CertificatesStyle['surface']>
        label="Surface"
        value={style.surface}
        onChange={(v) => onChange({ surface: v })}
        options={[
          { value: 'none', label: 'None' },
          { value: 'tint', label: 'Tint' },
          { value: 'card', label: 'Card' },
        ]}
      />

      {style.layout === 'chips' ? (
        <div className="space-y-2 border-t border-slate-100 pt-3">
          <Toggle label="Accent chips" checked={style.accent_chips} onChange={(v) => onChange({ accent_chips: v })} />
        </div>
      ) : null}
    </ControlCard>
  );
}
