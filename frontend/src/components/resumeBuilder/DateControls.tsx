import { CalendarDays } from 'lucide-react';
import type { ResumeDesign, SectionOptions } from '../../types/resumeDesign';
import { dateStyleOf } from '../../types/resumeDesign';
import type { DateFormat } from '../../utils/flexibleDate';
import { formatFlexiblePeriod } from '../../utils/flexibleDate';
import { ControlCard, Segmented } from './controls';

const FORMATS: { value: DateFormat; label: string }[] = [
  { value: 'mon_yyyy', label: 'Jan 2024' },
  { value: 'month_yyyy', label: 'January 2024' },
  { value: 'mm_yyyy', label: '01/2024' },
  { value: 'yyyy', label: '2024' },
];

const PRESENT_PRESETS = ['Present', 'Current', 'Now'];

/** How every date on the resume prints: experience, education, certifications and extras. */
export function DateControls({
  design,
  onSections,
}: {
  design: ResumeDesign;
  onSections: (patch: Partial<SectionOptions>) => void;
}) {
  const style = dateStyleOf(design);
  const example = formatFlexiblePeriod('2021-03', '', style);
  const custom = !PRESENT_PRESETS.includes(style.present);
  return (
    <ControlCard icon={CalendarDays} title="Dates" description={<>Example: <span className="font-medium text-foreground">{example}</span></>}>
      <Segmented<DateFormat> label="Format" value={style.format} options={FORMATS} onChange={(v) => onSections({ date_format: v })} />
      <div className="flex min-w-0 items-end gap-1.5">
        <div className="min-w-0 flex-1">
          <Segmented<string>
            label="Ongoing roles end with"
            value={custom ? '' : style.present}
            options={PRESENT_PRESETS.map((p) => ({ value: p, label: p }))}
            onChange={(v) => onSections({ present_label: v })}
          />
        </div>
        <input
          value={custom ? style.present : ''}
          maxLength={20}
          placeholder="Custom"
          aria-label="Custom ongoing label"
          onChange={(e) => onSections({ present_label: e.target.value })}
          className="h-[34px] w-24 shrink-0 rounded-lg border border-input bg-background px-2 text-xs text-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30"
        />
      </div>
    </ControlCard>
  );
}
