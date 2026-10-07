import { Settings2 } from 'lucide-react';
import type { ReactNode } from 'react';
import type {
  CertificatesStyle,
  EducationStyle,
  ExperienceStyle,
  ResumeDesign,
  SectionOptions,
  SkillsStyle,
} from '../../types/resumeDesign';
import {
  DEFAULT_CERTIFICATES_STYLE,
  DEFAULT_EDUCATION_STYLE,
  DEFAULT_EXPERIENCE_STYLE,
  DEFAULT_SKILLS_STYLE,
} from '../../types/resumeDesign';
import { ControlCard, Segmented, Toggle } from './controls';

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2.5 border-t pt-3 first:border-t-0 first:pt-0">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

type SkillsLayoutChoice = 'inline' | 'grid' | 'stacked' | 'chips';
type TechChoice = 'inline' | 'chips' | 'hidden';

/** The few per-section choices worth making. The overall look of every section comes
 *  from the resume style (theme), so nothing here needs to be set section by section. */
export function SectionDetails({
  design,
  onSkills,
  onExperience,
  onEducation,
  onCertificates,
  onSections,
}: {
  design: ResumeDesign;
  onSections: (patch: Partial<SectionOptions>) => void;
  onSkills: (style: SkillsStyle) => void;
  onExperience: (patch: Partial<ExperienceStyle>) => void;
  onEducation: (patch: Partial<EducationStyle>) => void;
  onCertificates: (patch: Partial<CertificatesStyle>) => void;
}) {
  const sk = design.sections.skills_style ?? DEFAULT_SKILLS_STYLE;
  const ex = design.sections.experience_style ?? DEFAULT_EXPERIENCE_STYLE;
  const ed = design.sections.education_style ?? DEFAULT_EDUCATION_STYLE;
  const ce = design.sections.certificates_style ?? DEFAULT_CERTIFICATES_STYLE;

  const skillsLayout: SkillsLayoutChoice =
    sk.layout === 'grid' || sk.layout === 'stacked' || sk.layout === 'chips' ? sk.layout : 'inline';
  const tech: TechChoice = !ex.show_used_skills || ex.used_skills_style === 'hidden'
    ? 'hidden'
    : ex.used_skills_style === 'chips' || ex.used_skills_style === 'pill'
      ? 'chips'
      : 'inline';
  const certLayout = ce.layout === 'chips' || ce.layout === 'inline' ? ce.layout : 'list';

  return (
    <ControlCard icon={Settings2} title="Section details">
      <Group title="Technical skills">
        <Segmented<SkillsLayoutChoice>
          label="Layout"
          value={skillsLayout}
          options={[
            { value: 'inline', label: 'Inline' },
            { value: 'grid', label: 'Columns' },
            { value: 'stacked', label: 'Stacked' },
            { value: 'chips', label: 'Chips' },
          ]}
          onChange={(v) => onSkills({ ...sk, layout: v })}
        />
        <Segmented<SkillsStyle['category']>
          label="Category labels"
          value={sk.category === 'bar' || sk.category === 'badge' ? 'bold' : sk.category}
          options={[
            { value: 'bold', label: 'Bold' },
            { value: 'caps', label: 'Caps' },
            { value: 'accent', label: 'Accent' },
          ]}
          onChange={(v) => onSkills({ ...sk, category: v })}
        />
      </Group>

      <Group title="Work experience">
        <Segmented<ExperienceStyle['date_position']>
          label="Dates"
          value={ex.date_position}
          options={[
            { value: 'right', label: 'Right' },
            { value: 'inline', label: 'Inline' },
            { value: 'below', label: 'Below' },
          ]}
          onChange={(v) => onExperience({ date_position: v })}
        />
        <Segmented<ExperienceStyle['marker']>
          label="Bullets"
          value={ex.marker}
          compact
          options={[
            { value: 'dot', label: '\u2022', title: 'Dot' },
            { value: 'dash', label: '\u2013', title: 'Dash' },
            { value: 'chevron', label: '\u203A', title: 'Chevron' },
            { value: 'square', label: '\u25AA', title: 'Square' },
            { value: 'numbered', label: '1.', title: 'Numbered' },
          ]}
          onChange={(v) => onExperience({ marker: v })}
        />
        <Segmented<TechChoice>
          label="Technologies line"
          value={tech}
          options={[
            { value: 'inline', label: 'Text' },
            { value: 'chips', label: 'Chips' },
            { value: 'hidden', label: 'Hide' },
          ]}
          onChange={(v) =>
            onExperience(
              v === 'hidden'
                ? { show_used_skills: false }
                : { show_used_skills: true, used_skills_style: v === 'chips' ? 'chips' : 'inline' },
            )
          }
        />
        <Toggle
          label="Key Contributions subtitle"
          checked={ex.show_contributions_label && ex.label_style !== 'hidden'}
          onChange={(v) => onExperience({ show_contributions_label: v, label_style: v && ex.label_style === 'hidden' ? 'bold' : ex.label_style })}
        />
        <Toggle label="Role dates" checked={design.sections.show_period} onChange={(v) => onSections({ show_period: v })} />
        <Toggle label="Role location" checked={design.sections.show_location} onChange={(v) => onSections({ show_location: v })} />
        <Toggle label="Project title" checked={ex.show_project_title} onChange={(v) => onExperience({ show_project_title: v })} />
        <Toggle label="Project intro" checked={ex.show_intro} onChange={(v) => onExperience({ show_intro: v })} />
        <Toggle label="Employment type" checked={ex.show_employment_type} onChange={(v) => onExperience({ show_employment_type: v })} />
        <Toggle label="Work arrangement" checked={ex.show_arrangement} onChange={(v) => onExperience({ show_arrangement: v })} />
      </Group>

      <Group title="Education">
        <Toggle label="Dates" checked={ed.show_period} onChange={(v) => onEducation({ show_period: v })} />
        <Toggle label="Grade / GPA" checked={ed.show_mark} onChange={(v) => onEducation({ show_mark: v })} />
        <Toggle label="Location" checked={ed.show_location} onChange={(v) => onEducation({ show_location: v })} />
        <Toggle label="Description" checked={ed.show_description} onChange={(v) => onEducation({ show_description: v })} />
      </Group>

      <Group title="Certifications">
        <Segmented<'list' | 'inline' | 'chips'>
          label="Layout"
          value={certLayout}
          options={[
            { value: 'list', label: 'List' },
            { value: 'inline', label: 'One line' },
            { value: 'chips', label: 'Chips' },
          ]}
          onChange={(v) => onCertificates({ layout: v })}
        />
      </Group>
    </ControlCard>
  );
}
