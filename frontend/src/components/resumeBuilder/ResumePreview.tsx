import { useMemo } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type {
  CertificatesStyle,
  EducationStyle,
  ExperienceStyle,
  ResumeDesign,
  SectionId,
  SkillsStyle,
  SummaryStyle,
} from '../../types/resumeDesign';
import {
  DEFAULT_CERTIFICATES_STYLE,
  DEFAULT_EDUCATION_STYLE,
  DEFAULT_EXPERIENCE_STYLE,
  DEFAULT_SKILLS_STYLE,
  DEFAULT_SUMMARY_STYLE,
  SECTION_LABELS,
  headerPadSides,
  marginSides,
} from '../../types/resumeDesign';
import type {
  CertificateBlock,
  EducationBlock,
  TechnicalSkillBlock,
  UserProfile,
  WorkExperienceBlock,
} from '../../types/profile';
import { renderRich } from '../../utils/richText';
import { deriveWorkContent } from '../../utils/workExperience';
import { formatFlexibleDate, formatFlexiblePeriod } from '../../utils/flexibleDate';

export const PT_TO_PX = 1.3333;

/** Maps a designed font family to the bundled web font actually rendered, so the live
 *  preview uses the exact same typeface as the generated .docx/PDF. Carlito is the
 *  metric-compatible, OFL-licensre ed stand-in for Calibri that LibreOffice renders. */
export const RESUME_FONT_RENDER: Record<string, string> = {
  Calibri: 'Carlito',
  Carlito: 'Carlito',
};

interface ResumePreviewProps {
  design: ResumeDesign;
  profile: UserProfile | null;
  /** When true, the vertical page margin is omitted so the paginator can add a
   *  real top/bottom margin to every page. Horizontal margins stay intact. */
  paged?: boolean;
}

/** Vertical page margins (top/bottom) in CSS px, shared with the paginator. */
export function resumeVerticalMarginsPx(design: ResumeDesign): { top: number; bottom: number } {
  const m = marginSides(design.layout);
  return { top: m.top * PT_TO_PX, bottom: m.bottom * PT_TO_PX };
}

/** Whether the header renders as a full-bleed band (no top margin on page 1). */
export function resumeHasHeaderBand(design: ResumeDesign): boolean {
  return design.layout.header_background !== 'none';
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function tint(hex: string, keep: number): string {
  const v = (hex || '#000000').replace('#', '');
  const full = v.length === 3 ? v.split('').map((ch) => ch + ch).join('') : v;
  const r = parseInt(full.slice(0, 2), 16) || 0;
  const g = parseInt(full.slice(2, 4), 16) || 0;
  const b = parseInt(full.slice(4, 6), 16) || 0;
  const mix = (x: number) => Math.round(255 * (1 - keep) + x * keep);
  const hx = (x: number) => x.toString(16).padStart(2, '0');
  return `#${hx(mix(r))}${hx(mix(g))}${hx(mix(b))}`;
}

function period(start?: string, end?: string): string {
  return formatFlexiblePeriod(start, end);
}

/**
 * Title + right-aligned date row that stays inside narrow columns (e.g. 2-col sidebar).
 *
 * Root cause of overflow: date used `flex: 0 0 auto` (intrinsic width, never shrinks) while
 * the title lacked `minWidth: 0`, so long periods like "Jan 2016 - Dec 2019" blew past the
 * 34% education column into the main column.
 */
function TitleDateRow({
  title,
  date,
  right,
}: {
  title: ReactNode;
  date: ReactNode | null;
  right: boolean;
}) {
  if (!right || !date) {
    return <div style={{ minWidth: 0, maxWidth: '100%' }}>{title}</div>;
  }
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 8,
        width: '100%',
        minWidth: 0,
        maxWidth: '100%',
      }}
    >
      <div style={{ flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{title}</div>
      <div
        style={{
          flex: '0 1 auto',
          minWidth: 0,
          maxWidth: '48%',
          textAlign: 'right',
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
        }}
      >
        {date}
      </div>
    </div>
  );
}

function fullName(p: UserProfile | null): string {
  if (!p) return 'Your Name';
  const parts = [p.name_first, p.name_middle, p.name_last].map((x) => (x || '').trim()).filter(Boolean);
  if (parts.length) return parts.join(' ');
  return p.name || 'Your Name';
}

type ContactKind = 'email' | 'phone' | 'linkedin' | 'github';

type ContactItem = { kind: ContactKind; text: string; href?: string };

function cleanUrl(u: string): string {
  return (u || '').trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
}

function ensureHttpUrl(u: string): string {
  const v = (u || '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  return `https://${v.replace(/^\/+/, '')}`;
}

function contactItems(p: UserProfile | null): ContactItem[] {
  if (!p) return [{ kind: 'email', text: 'you@email.com', href: 'mailto:you@email.com' }];
  const phone = [p.phone_country_code, p.phone_number].map((x) => (x || '').trim()).filter(Boolean).join(' ');
  const items: ContactItem[] = [];
  if ((p.email || '').trim()) {
    const email = p.email!.trim();
    items.push({ kind: 'email', text: email, href: `mailto:${email}` });
  }
  if (phone) {
    const tel = phone.replace(/[^\d+]/g, '');
    items.push({ kind: 'phone', text: phone, href: tel ? `tel:${tel}` : undefined });
  }
  if ((p.linkedin_url || '').trim()) {
    const raw = p.linkedin_url!.trim();
    items.push({ kind: 'linkedin', text: cleanUrl(raw), href: ensureHttpUrl(raw) });
  }
  if ((p.github_url || '').trim()) {
    const raw = p.github_url!.trim();
    items.push({ kind: 'github', text: cleanUrl(raw), href: ensureHttpUrl(raw) });
  }
  return items;
}

function ContactText({ item }: { item: ContactItem }) {
  if (!item.href) return <span>{item.text}</span>;
  return (
    <a
      href={item.href}
      target={item.href.startsWith('http') ? '_blank' : undefined}
      rel={item.href.startsWith('http') ? 'noopener noreferrer' : undefined}
      style={{ color: 'inherit', textDecoration: 'none' }}
    >
      {item.text}
    </a>
  );
}

const LINKEDIN_PATH =
  'M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zm1.78 13.02H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z';
const GITHUB_PATH =
  'M12 .3a12 12 0 0 0-3.8 23.4c.6.1.82-.26.82-.58l-.01-2.04c-3.34.72-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.08-.74.09-.73.09-.73 1.2.09 1.83 1.24 1.83 1.24 1.07 1.83 2.81 1.3 3.5 1 .1-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.3-1.55 3.3-1.23 3.3-1.23.66 1.66.25 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.8 5.63-5.48 5.92.43.37.81 1.1.81 2.22l-.01 3.29c0 .32.22.69.82.57A12 12 0 0 0 12 .3z';

/** Contact glyphs monochrome in the supplied color. Brand = solid fill for every
 *  kind (email / phone / LinkedIn / GitHub); outline = line versions. */
function ContactIcon({
  kind,
  size,
  color,
  variant,
}: {
  kind: ContactKind;
  size: number;
  color: string;
  variant: 'brand' | 'outline';
}) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    style: { flex: '0 0 auto', display: 'block' } as CSSProperties,
    'aria-hidden': true as const,
  };
  const strokeProps = {
    fill: 'none',
    stroke: color,
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  const phonePath =
    'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92Z';
  switch (kind) {
    case 'email':
      return variant === 'outline' ? (
        <svg {...common} {...strokeProps}>
          <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" />
          <path d="m3 6 9 6.5L21 6" />
        </svg>
      ) : (
        <svg {...common} fill={color}>
          <path d="M1.5 8.67v8.58a3 3 0 0 0 3 3h15a3 3 0 0 0 3-3V8.67l-8.928 5.493a3 3 0 0 1-3.144 0L1.5 8.67z" />
          <path d="M22.5 6.908V6.75a3 3 0 0 0-3-3h-15a3 3 0 0 0-3 3v.158l9.714 5.978a1.5 1.5 0 0 0 1.572 0L22.5 6.908z" />
        </svg>
      );
    case 'phone':
      return variant === 'outline' ? (
        <svg {...common} {...strokeProps}>
          <path d={phonePath} />
        </svg>
      ) : (
        <svg {...common} fill={color}>
          <path d={phonePath} />
        </svg>
      );
    case 'linkedin':
      return variant === 'outline' ? (
        <svg {...common} fill="none" stroke={color} strokeWidth={1.4} strokeLinejoin="round">
          <path d={LINKEDIN_PATH} />
        </svg>
      ) : (
        <svg {...common} fill={color}>
          <path d={LINKEDIN_PATH} />
        </svg>
      );
    case 'github':
      return variant === 'outline' ? (
        <svg {...common} fill="none" stroke={color} strokeWidth={1.4} strokeLinejoin="round">
          <path d={GITHUB_PATH} />
        </svg>
      ) : (
        <svg {...common} fill={color}>
          <path d={GITHUB_PATH} />
        </svg>
      );
    default:
      return null;
  }
}

/** Renders the Professional Summary section using a SummaryStyle. Shared by the live
 *  preview and the style gallery thumbnails so the picker is a true preview. */
export function SummaryBlock({
  design,
  style,
  text,
  marginTop = 0,
  tagBlock = false,
}: {
  design: ResumeDesign;
  style: SummaryStyle;
  text: string;
  marginTop?: number;
  tagBlock?: boolean;
}) {
  const { typography: t, colors: c } = design;
  const base = t.base_font_pt * PT_TO_PX;
  const st = style ?? DEFAULT_SUMMARY_STYLE;
  const upper = t.uppercase_headings;
  const titleText = SECTION_LABELS.summary;
  const padPx = st.pad_pt * PT_TO_PX;
  const onSolid = st.surface === 'solid' || st.surface === 'gradient';
  const hasBox = st.surface !== 'none' || st.border !== 'none';

  let background: string | undefined;
  if (st.surface === 'tint') background = tint(c.accent, 0.12);
  else if (st.surface === 'solid') background = c.accent;
  else if (st.surface === 'gradient') background = `linear-gradient(135deg, ${c.accent}, ${tint(c.accent, 0.5)})`;

  const borderColor = onSolid ? 'rgba(255,255,255,0.55)' : c.accent;
  const titleColor = onSolid ? '#ffffff' : c.heading;
  const accentColor = onSolid ? '#ffffff' : c.accent;
  const textColor = onSolid ? 'rgba(255,255,255,0.94)' : c.text;

  const container: CSSProperties = {
    marginTop,
    background,
    borderRadius: st.radius_pt || 0,
    padding: hasBox ? `${padPx}px ${padPx * 1.15}px` : 0,
    color: textColor,
    boxSizing: 'border-box',
  };
  switch (st.border) {
    case 'full':
      container.border = `1.5px solid ${borderColor}`;
      break;
    case 'left':
      container.borderLeft = `3px solid ${borderColor}`;
      break;
    case 'top':
      container.borderTop = `2px solid ${borderColor}`;
      break;
    case 'bottom':
      container.borderBottom = `2px solid ${borderColor}`;
      break;
    case 'x':
      container.borderTop = `1.5px solid ${borderColor}`;
      container.borderBottom = `1.5px solid ${borderColor}`;
      break;
    default:
      break;
  }

  const titleBase: CSSProperties = {
    fontSize: base * t.heading_scale,
    fontWeight: 700,
    color: titleColor,
    textTransform: upper ? 'uppercase' : 'none',
    letterSpacing: upper ? '0.04em' : 0,
    lineHeight: 1.2,
  };

  const bodyP = (
    <p
      style={{
        margin: 0,
        lineHeight: t.line_spacing,
        textAlign: st.align,
        fontStyle: st.italic ? 'italic' : 'normal',
        color: textColor,
      }}
    >
      {renderRich(text)}
    </p>
  );

  function stdTitle(center: boolean): ReactNode {
    const ta: CSSProperties['textAlign'] = center ? 'center' : 'left';
    if (st.title_accent === 'bar') {
      return (
        <div style={{ marginBottom: 5, textAlign: ta }}>
          <div style={{ width: 30, height: 3, background: accentColor, borderRadius: 2, margin: center ? '0 auto 5px' : '0 0 5px' }} />
          <span style={{ ...titleBase }}>{titleText}</span>
        </div>
      );
    }
    if (st.title_accent === 'box') {
      return (
        <div style={{ marginBottom: 5, textAlign: ta }}>
          <span style={{ ...titleBase, display: 'inline-block', background: accentColor, color: '#ffffff', padding: '2px 9px', borderRadius: 4 }}>
            {titleText}
          </span>
        </div>
      );
    }
    const underline = st.title_accent === 'underline' || (st.title_accent === 'none' && design.layout.accent_rule);
    return (
      <div
        style={{
          ...titleBase,
          marginBottom: 5,
          textAlign: ta,
          borderBottom: underline ? `1.5px solid ${accentColor}` : 'none',
          paddingBottom: underline ? 2 : 0,
        }}
      >
        {st.title_accent === 'dot' && <span style={{ color: accentColor }}>{'\u25CF '}</span>}
        {titleText}
      </div>
    );
  }

  function overlineTitle(center: boolean): ReactNode {
    return (
      <div style={{ textAlign: center ? 'center' : 'left', marginBottom: 6 }}>
        <span style={{ display: 'inline-block', borderTop: `2px solid ${accentColor}`, paddingTop: 5 }}>
          <span style={{ fontSize: base * 0.95, fontWeight: 700, color: titleColor, textTransform: 'uppercase', letterSpacing: '0.18em' }}>
            {titleText}
          </span>
        </span>
      </div>
    );
  }

  function badgeTitle(center: boolean): ReactNode {
    return (
      <div style={{ textAlign: center ? 'center' : 'left', marginBottom: 6 }}>
        <span
          style={{
            display: 'inline-block',
            background: onSolid ? 'rgba(255,255,255,0.2)' : c.accent,
            color: '#ffffff',
            padding: '3px 12px',
            borderRadius: 999,
            fontSize: base * 0.82,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
          }}
        >
          {titleText}
        </span>
      </div>
    );
  }

  let inner: ReactNode;
  if (st.title === 'hidden') {
    inner = bodyP;
  } else if (st.title === 'inline') {
    inner = (
      <p style={{ margin: 0, lineHeight: t.line_spacing, textAlign: st.align, fontStyle: st.italic ? 'italic' : 'normal', color: textColor }}>
        <span style={{ fontWeight: 700, color: titleColor, textTransform: upper ? 'uppercase' : 'none', letterSpacing: upper ? '0.04em' : 0 }}>
          {titleText}.{'  '}
        </span>
        {renderRich(text)}
      </p>
    );
  } else if (st.title === 'side') {
    inner = (
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <div style={{ flex: '0 0 28%' }}>{stdTitle(false)}</div>
        <div style={{ flex: '1 1 72%' }}>{bodyP}</div>
      </div>
    );
  } else if (st.title === 'overline') {
    inner = (
      <>
        {overlineTitle(st.align === 'center')}
        {bodyP}
      </>
    );
  } else if (st.title === 'badge') {
    inner = (
      <>
        {badgeTitle(st.align === 'center')}
        {bodyP}
      </>
    );
  } else if (st.title === 'centered') {
    inner = (
      <>
        {stdTitle(true)}
        {bodyP}
      </>
    );
  } else {
    inner = (
      <>
        {stdTitle(false)}
        {bodyP}
      </>
    );
  }

  return (
    <div {...(tagBlock ? { 'data-block': true } : {})} style={container}>
      {inner}
    </div>
  );
}

function splitSkills(s?: string): string[] {
  return (s || '')
    .split(/[,;|\n]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Renders the Technical Skills section using a SkillsStyle. Each skill within a
 *  category is split into its own structured unit. Shared by the live preview and
 *  the style gallery thumbnails. */
export function SkillsBlock({
  design,
  style,
  skills,
}: {
  design: ResumeDesign;
  style: SkillsStyle;
  skills: { category?: string; skills?: string }[];
}) {
  const { typography: t, colors: c } = design;
  const base = t.base_font_pt * PT_TO_PX;
  const st = style ?? DEFAULT_SKILLS_STYLE;
  const padPx = st.pad_pt * PT_TO_PX;

  const catLabel = (text: string): ReactNode => {
    const upper = st.category === 'caps';
    const color = st.category === 'accent' ? c.accent : c.heading;
    const labelStyle: CSSProperties = {
      fontWeight: 700,
      color,
      textTransform: upper ? 'uppercase' : 'none',
      letterSpacing: upper ? '0.05em' : 0,
      fontSize: base * (upper ? 0.92 : 1),
    };
    if (st.category === 'badge') {
      return (
        <span
          style={{
            display: 'inline-block',
            background: c.accent,
            color: '#ffffff',
            padding: '1px 9px',
            borderRadius: 999,
            fontSize: base * 0.8,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
        >
          {text}
        </span>
      );
    }
    if (st.category === 'bar') {
      return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 3, height: base * 0.95, background: c.accent, borderRadius: 2, display: 'inline-block' }} />
          <span style={labelStyle}>{text}</span>
        </span>
      );
    }
    return <span style={labelStyle}>{text}</span>;
  };

  const chip = (skill: string, i: number): ReactNode => {
    const accent = st.accent_chips;
    return (
      <span
        key={i}
        style={{
          display: 'inline-block',
          fontSize: base * 0.9,
          lineHeight: 1.35,
          padding: '1px 8px',
          borderRadius: 6,
          background: accent ? tint(c.accent, 0.14) : '#f1f5f9',
          color: accent ? c.accent : c.text,
          border: `1px solid ${accent ? tint(c.accent, 0.45) : '#e2e8f0'}`,
        }}
      >
        {renderRich(skill)}
      </span>
    );
  };

  const bodyText: CSSProperties = { color: c.text, lineHeight: t.line_spacing };

  // Per-skill bullet lists (one term per line) were dropped; coerce to chips.
  const layout = st.layout === 'bullets' ? 'chips' : st.layout;

  const renderCategory = (item: { category?: string; skills?: string }, idx: number): ReactNode => {
    const cat = (item.category || '').trim();
    const list = splitSkills(item.skills);
    const labelGap = st.category === 'badge' ? ' ' : ': ';
    let content: ReactNode;

    switch (layout) {
      case 'pipe':
      case 'inline':
        content = (
          <p style={{ ...bodyText, margin: 0 }}>
            {cat && (
              <>
                {catLabel(cat)}
                <span style={{ color: c.text }}>{labelGap}</span>
              </>
            )}
            <span style={{ color: c.text }}>{renderRich(list.join(st.layout === 'pipe' ? '  |  ' : ', '))}</span>
          </p>
        );
        break;
      case 'stacked':
        content = (
          <div>
            {cat && <div style={{ marginBottom: 2 }}>{catLabel(cat)}</div>}
            <p style={{ ...bodyText, margin: 0 }}>{renderRich(list.join(', '))}</p>
          </div>
        );
        break;
      case 'chips':
        content = (
          <div>
            {cat && <div style={{ marginBottom: 3 }}>{catLabel(cat)}</div>}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{list.map((sk, i) => chip(sk, i))}</div>
          </div>
        );
        break;
      case 'grid':
      default:
        content = (
          <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
            <div style={{ flex: '0 0 32%' }}>{cat && catLabel(cat)}</div>
            <div style={{ flex: '1 1 68%' }}>
              {st.accent_chips ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{list.map((sk, i) => chip(sk, i))}</div>
              ) : (
                <span style={{ color: c.text }}>{renderRich(list.join(', '))}</span>
              )}
            </div>
          </div>
        );
        break;
    }

    const wrap: CSSProperties = { marginBottom: st.surface === 'none' ? 3 : 5 };
    if (st.surface === 'tint') {
      wrap.background = tint(c.accent, 0.08);
      wrap.borderRadius = st.radius_pt;
      wrap.padding = `${padPx * 0.6}px ${padPx}px`;
    } else if (st.surface === 'card') {
      wrap.background = '#ffffff';
      wrap.border = `1px solid ${tint(c.accent, 0.35)}`;
      wrap.borderRadius = st.radius_pt;
      wrap.padding = `${padPx * 0.6}px ${padPx}px`;
      wrap.boxShadow = '0 1px 2px rgba(0,0,0,0.06)';
    }
    if (st.divider && st.surface === 'none') {
      wrap.borderBottom = `1px solid ${tint(c.accent, 0.28)}`;
      wrap.paddingBottom = 3;
    }

    return (
      <div key={idx} data-block data-gap-role="skill" style={wrap}>
        {content}
      </div>
    );
  };

  return <>{skills.map(renderCategory)}</>;
}

const MARKER_GLYPH: Record<string, string> = {
  dot: '\u2022',
  dash: '\u2013',
  arrow: '\u2192',
  chevron: '\u203A',
  square: '\u25AA',
  diamond: '\u25C6',
};

/** Normalized fields for one role, structured first with a legacy-description fallback. */
function deriveExperience(w: WorkExperienceBlock): {
  company: string;
  role: string;
  periodStr: string;
  location: string;
  employmentType: string;
  arrangement: string;
  projectTitle: string;
  intro: string;
  contributions: string[];
  usedSkills: string;
} {
  const { projectTitle, intro, contributions } = deriveWorkContent(w);
  return {
    company: (w.company_name || '').trim(),
    role: (w.job_title || '').trim(),
    periodStr: period(w.period_start, w.period_end),
    location: (w.location || '').trim(),
    employmentType: (w.employment_type || '').trim(),
    arrangement: (w.job_type || '').trim(),
    projectTitle,
    intro,
    contributions,
    usedSkills: (w.used_skills || '').trim(),
  };
}

/** Renders the Work Experience section using an ExperienceStyle + control-board
 *  toggles. Each contribution is split into its own bullet. Shared by the live
 *  preview and the style gallery thumbnails so the picker is a true preview. */
export function ExperienceBlock({
  design,
  style,
  work,
  showPeriod = true,
  showLocation = true,
}: {
  design: ResumeDesign;
  style: ExperienceStyle;
  work: WorkExperienceBlock[];
  showPeriod?: boolean;
  showLocation?: boolean;
}) {
  const { typography: t, colors: c } = design;
  const base = t.base_font_pt * PT_TO_PX;
  const st = style ?? DEFAULT_EXPERIENCE_STYLE;
  const padPx = st.pad_pt * PT_TO_PX;
  const gapPx = st.entry_gap_pt * PT_TO_PX;

  const bodyStyle: CSSProperties = {
    color: c.text,
    lineHeight: t.line_spacing,
    fontSize: base,
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
    maxWidth: '100%',
  };
  const mutedStyle: CSSProperties = {
    color: c.muted,
    fontSize: base * 0.92,
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
  };

  const companyColor = st.accent_target === 'company' ? c.accent : c.heading;
  const roleColor = st.accent_target === 'role' ? c.accent : c.text;
  const dateColor = st.accent_target === 'date' ? c.accent : c.muted;

  const pill = (text: string, key: string): ReactNode => (
    <span
      key={key}
      style={{
        display: 'inline-block',
        fontSize: base * 0.78,
        fontWeight: 600,
        lineHeight: 1.4,
        padding: '0px 7px',
        borderRadius: 999,
        background: tint(c.accent, 0.14),
        color: c.accent,
        border: `1px solid ${tint(c.accent, 0.4)}`,
        textTransform: 'capitalize',
      }}
    >
      {text}
    </span>
  );

  const skillChip = (skill: string, i: number, accent: boolean): ReactNode => (
    <span
      key={i}
      style={{
        display: 'inline-block',
        fontSize: base * 0.85,
        lineHeight: 1.35,
        padding: '0px 7px',
        borderRadius: accent ? 999 : 5,
        background: accent ? tint(c.accent, 0.14) : '#f1f5f9',
        color: accent ? c.accent : c.text,
        border: `1px solid ${accent ? tint(c.accent, 0.4) : '#e2e8f0'}`,
      }}
    >
      {renderRich(skill)}
    </span>
  );

  const badges = (e: ReturnType<typeof deriveExperience>): { text: string }[] => {
    const out: { text: string }[] = [];
    if (st.show_employment_type && e.employmentType) out.push({ text: e.employmentType });
    if (st.show_arrangement && e.arrangement) out.push({ text: e.arrangement });
    return out;
  };

  const renderEntry = (w: WorkExperienceBlock, idx: number): ReactNode => {
    const e = deriveExperience(w);
    const bgs = badges(e);
    const dateBits = [showPeriod ? e.periodStr : '', showLocation ? e.location : ''].filter(Boolean);
    const inlineBadgeText = st.badge_style === 'inline' ? bgs.map((b) => b.text) : [];
    const dateText = [...dateBits, ...inlineBadgeText].join('  |  ');
    const pillBadges = st.badge_style === 'pill' ? bgs : [];

    const companyEl = <span style={{ color: companyColor, fontWeight: 700 }}>{e.company}</span>;
    const roleEl = e.role ? (
      <span style={{ color: roleColor, fontWeight: st.accent_target === 'role' ? 600 : 400 }}>{e.role}</span>
    ) : null;
    const dateEl = dateText ? <span style={{ ...mutedStyle, color: dateColor }}>{dateText}</span> : null;

    // ---- Header ----
    let header: ReactNode;
    if (st.header_layout === 'two_column') {
      header = (
        <TitleDateRow
          right
          title={
            <>
              {companyEl}
              {roleEl ? <span style={{ color: c.text }}>{'  -  '}{roleEl}</span> : null}
            </>
          }
          date={dateEl}
        />
      );
    } else if (st.header_layout === 'stacked') {
      header = (
        <>
          <TitleDateRow
            right={st.date_position === 'right'}
            title={<div style={{ color: companyColor, fontWeight: 700 }}>{e.company}</div>}
            date={st.date_position === 'right' ? dateEl : null}
          />
          {roleEl ? <div style={{ marginTop: 0 }}>{roleEl}</div> : null}
          {st.date_position !== 'right' && dateEl ? <div style={{ marginTop: 1 }}>{dateEl}</div> : null}
        </>
      );
    } else {
      // inline header
      if (st.date_position === 'right') {
        header = (
          <TitleDateRow
            right
            title={
              <>
                {companyEl}
                {roleEl ? <span style={{ color: c.text }}>{'  -  '}{roleEl}</span> : null}
              </>
            }
            date={dateEl}
          />
        );
      } else if (st.date_position === 'inline') {
        header = (
          <div style={{ minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
            {companyEl}
            {roleEl ? <span style={{ color: c.text }}>{'  -  '}{roleEl}</span> : null}
            {dateEl ? <span style={{ ...mutedStyle, color: dateColor }}>{'  \u00b7  '}{dateText}</span> : null}
          </div>
        );
      } else {
        // below
        header = (
          <>
            <div style={{ minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
              {companyEl}
              {roleEl ? <span style={{ color: c.text }}>{'  -  '}{roleEl}</span> : null}
            </div>
            {dateEl ? <div style={{ marginTop: 1 }}>{dateEl}</div> : null}
          </>
        );
      }
    }

    // ---- Project title ----
    let projectEl: ReactNode = null;
    if (st.show_project_title && st.project_style !== 'hidden' && e.projectTitle) {
      if (st.project_style === 'label') {
        projectEl = (
          <p data-gap-role="exp-lead" style={{ ...bodyStyle, margin: '2px 0 0' }}>
            <span style={{ fontWeight: 700 }}>Project: </span>
            {renderRich(e.projectTitle)}
          </p>
        );
      } else if (st.project_style === 'bold') {
        projectEl = <p data-gap-role="exp-lead" style={{ ...bodyStyle, margin: '2px 0 0', fontWeight: 700 }}>{renderRich(e.projectTitle)}</p>;
      } else if (st.project_style === 'italic') {
        projectEl = <p data-gap-role="exp-lead" style={{ ...bodyStyle, margin: '2px 0 0', fontStyle: 'italic' }}>{renderRich(e.projectTitle)}</p>;
      } else {
        projectEl = <p data-gap-role="exp-lead" style={{ ...bodyStyle, margin: '2px 0 0', color: c.accent, fontWeight: 700 }}>{renderRich(e.projectTitle)}</p>;
      }
    }

    // ---- Intro ----
    let introEl: ReactNode = null;
    if (st.show_intro && st.intro_style !== 'hidden' && e.intro) {
      const introStyle: CSSProperties = { ...bodyStyle, margin: '2px 0 0' };
      if (st.intro_style === 'italic') introStyle.fontStyle = 'italic';
      if (st.intro_style === 'indented') introStyle.paddingLeft = 10;
      introEl = <p data-gap-role="exp-lead" style={introStyle}>{renderRich(e.intro)}</p>;
    }

    // ---- Pill badges row (when not inlined) ----
    const pillRow =
      pillBadges.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 3 }}>
          {pillBadges.map((b, bi) => pill(b.text, `badge-${bi}`))}
        </div>
      ) : null;

    // ---- Contributions label ----
    let labelEl: ReactNode = null;
    if (st.show_contributions_label && st.label_style !== 'hidden' && e.contributions.length > 0) {
      const upper = st.label_style === 'caps';
      labelEl = (
        <p
          data-block
          data-gap-role="exp-label"
          style={{
            ...bodyStyle,
            margin: '2px 0 0',
            fontWeight: st.label_style === 'bold' || st.label_style === 'accent' ? 700 : 400,
            color: st.label_style === 'accent' ? c.accent : c.text,
            textTransform: upper ? 'uppercase' : 'none',
            letterSpacing: upper ? '0.05em' : 0,
            fontSize: upper ? base * 0.92 : base,
          }}
        >
          Key Contributions:
        </p>
      );
    }

    // ---- Contributions ----
    const contributionEls = e.contributions.map((b, bi) => {
      const marker = st.marker === 'numbered' ? `${bi + 1}.` : MARKER_GLYPH[st.marker] ?? '';
      const textStyle: CSSProperties = {
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
        minWidth: 0,
        maxWidth: '100%',
      };
      // Uniform margin-top (not bottom) so consecutive body lines share the same gap,
      // matches the PDF fill engine's space_before rhythm and avoids uneven measure noise.
      const bodyLineGap = { margin: '2px 0 0', ...textStyle };
      if (!marker) {
        return (
          <p key={bi} data-block data-gap-role="exp-bull" style={{ ...bodyStyle, ...bodyLineGap }}>
            {renderRich(b)}
          </p>
        );
      }
      // Flex row keeps the marker tight to the text; minWidth:0 + overflowWrap keeps
      // long unbroken tokens inside the page margins (PDF-editor style wrapping).
      return (
        <div
          key={bi}
          data-block
          data-gap-role="exp-bull"
          style={{
            ...bodyStyle,
            ...bodyLineGap,
            display: 'flex',
            gap: 5,
            alignItems: 'baseline',
            maxWidth: '100%',
            minWidth: 0,
          }}
        >
          <span style={{ flex: '0 0 auto', color: st.accent_target === 'none' ? c.text : c.accent, fontWeight: 700 }}>
            {marker}
          </span>
          <span style={{ flex: '1 1 auto', ...textStyle }}>{renderRich(b)}</span>
        </div>
      );
    });

    // ---- Used skills ----
    // Must carry data-block: the paginator only keeps whole [data-block] units
    // across page edges. Without it, Technologies is hard-clipped mid-line
    // (top half on page N, bottom half on page N+1).
    let usedSkillsEl: ReactNode = null;
    if (st.show_used_skills && st.used_skills_style !== 'hidden' && e.usedSkills) {
      if (st.used_skills_style === 'inline') {
        usedSkillsEl = (
          <p data-block data-gap-role="exp-used" style={{ ...mutedStyle, margin: '3px 0 0' }}>
            <span style={{ fontWeight: 700, color: c.heading }}>Technologies: </span>
            {renderRich(e.usedSkills)}
          </p>
        );
      } else if (st.used_skills_style === 'label') {
        usedSkillsEl = (
          <p data-block data-gap-role="exp-used" style={{ ...bodyStyle, margin: '3px 0 0', fontSize: base * 0.9 }}>
            <span style={{ fontWeight: 700, color: c.accent }}>Tech &middot; </span>
            {renderRich(e.usedSkills)}
          </p>
        );
      } else {
        const accent = st.used_skills_style === 'pill';
        usedSkillsEl = (
          <div data-block data-gap-role="exp-used" style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 4 }}>
            {splitSkills(e.usedSkills).map((s, si) => skillChip(s, si, accent))}
          </div>
        );
      }
    }

    // ---- Surface wrapper ----
    const wrap: CSSProperties = { marginBottom: gapPx };
    if (st.surface === 'card') {
      wrap.border = `1px solid ${tint(c.accent, 0.22)}`;
      wrap.borderRadius = st.radius_pt * PT_TO_PX;
      wrap.padding = padPx || 12;
      wrap.background = '#ffffff';
      wrap.boxShadow = '0 1px 2px rgba(0,0,0,0.05)';
    } else if (st.surface === 'tint') {
      wrap.background = tint(c.accent, 0.07);
      wrap.borderRadius = st.radius_pt * PT_TO_PX;
      wrap.padding = padPx || 12;
    } else if (st.surface === 'left_bar') {
      wrap.borderLeft = `2.5px solid ${c.accent}`;
      wrap.paddingLeft = padPx || 12;
    } else if (st.surface === 'divider') {
      wrap.borderBottom = `1px solid ${tint(c.accent, 0.24)}`;
      wrap.paddingBottom = Math.max(gapPx - 4, 4);
    }

    return (
      <div key={idx} style={wrap}>
        <div data-block>
          <div data-gap-role="exp-head">{header}</div>
          {projectEl}
          {introEl}
          {pillRow}
        </div>
        {labelEl}
        {contributionEls}
        {usedSkillsEl}
      </div>
    );
  };

  if (work.length === 0) {
    return (
      <p style={{ ...mutedStyle, fontStyle: 'italic' }}>Add work experience in your profile to populate this section.</p>
    );
  }

  return <>{work.map(renderEntry)}</>;
}

const CERT_MARKER_GLYPH: Record<string, string> = {
  dot: '\u2022',
  dash: '\u2013',
  check: '\u2713',
  arrow: '\u2192',
  square: '\u25AA',
  none: '',
};

export function EducationBlock({
  design,
  style,
  education,
}: {
  design: ResumeDesign;
  style: EducationStyle;
  education: EducationBlock[];
}) {
  const { typography: t, colors: c } = design;
  const base = t.base_font_pt * PT_TO_PX;
  const st = style ?? DEFAULT_EDUCATION_STYLE;
  const padPx = st.pad_pt * PT_TO_PX;
  const gapPx = st.entry_gap_pt * PT_TO_PX;

  const bodyStyle: CSSProperties = {
    color: c.text,
    lineHeight: t.line_spacing,
    fontSize: base,
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
    maxWidth: '100%',
  };
  const mutedStyle: CSSProperties = {
    color: c.muted,
    fontSize: base * 0.92,
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
  };

  const uniColor = st.accent_target === 'university' ? c.accent : c.heading;
  const degreeColor = st.accent_target === 'degree' ? c.accent : c.text;

  const renderEntry = (e: EducationBlock, idx: number): ReactNode => {
    const uni = (e.university_name || '').trim();
    const degree = (e.degree || '').trim();
    const dateBits = [
      st.show_period ? period(e.period_start, e.period_end) : '',
      st.show_mark ? (e.mark || '').trim() : '',
      st.show_location ? (e.location || '').trim() : '',
    ].filter(Boolean);
    const dateText = dateBits.join('  |  ');

    const uniEl = uni ? <span style={{ color: uniColor, fontWeight: 700 }}>{uni}</span> : null;
    const degreeEl = degree ? (
      <span style={{ color: degreeColor, fontWeight: st.accent_target === 'degree' ? 600 : 400 }}>{degree}</span>
    ) : null;
    const dateEl = dateText ? <span style={{ ...mutedStyle }}>{dateText}</span> : null;

    let header: ReactNode;
    if (st.header_layout === 'stacked') {
      header = (
        <>
          <TitleDateRow right={st.date_position === 'right'} title={<div>{uniEl}</div>} date={st.date_position === 'right' ? dateEl : null} />
          {degreeEl ? <div style={{ marginTop: 0 }}>{degreeEl}</div> : null}
          {st.date_position !== 'right' && dateEl ? <div style={{ marginTop: 1 }}>{dateEl}</div> : null}
        </>
      );
    } else if (st.date_position === 'right') {
      header = (
        <TitleDateRow
          right
          title={
            <>
              {uniEl}
              {degreeEl ? <span style={{ color: c.text }}>{'  -  '}{degreeEl}</span> : null}
            </>
          }
          date={dateEl}
        />
      );
    } else if (st.date_position === 'inline') {
      header = (
        <div style={{ minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
          {uniEl}
          {degreeEl ? <span style={{ color: c.text }}>{'  -  '}{degreeEl}</span> : null}
          {dateEl ? <span style={{ ...mutedStyle }}>{'  \u00b7  '}{dateText}</span> : null}
        </div>
      );
    } else {
      header = (
        <>
          <div style={{ minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
            {uniEl}
            {degreeEl ? <span style={{ color: c.text }}>{'  -  '}{degreeEl}</span> : null}
          </div>
          {dateEl ? <div style={{ marginTop: 1 }}>{dateEl}</div> : null}
        </>
      );
    }

    const descEl =
      st.show_description && (e.description || '').trim() ? (
        <p style={{ ...bodyStyle, margin: '2px 0 0' }}>{renderRich((e.description || '').trim())}</p>
      ) : null;

    const wrap: CSSProperties = { marginBottom: gapPx, minWidth: 0, maxWidth: '100%' };
    if (st.surface === 'card') {
      wrap.border = `1px solid ${tint(c.accent, 0.22)}`;
      wrap.borderRadius = st.radius_pt * PT_TO_PX;
      wrap.padding = padPx || 12;
      wrap.background = '#ffffff';
      wrap.boxShadow = '0 1px 2px rgba(0,0,0,0.05)';
    } else if (st.surface === 'tint') {
      wrap.background = tint(c.accent, 0.07);
      wrap.borderRadius = st.radius_pt * PT_TO_PX;
      wrap.padding = padPx || 12;
    } else if (st.surface === 'left_bar') {
      wrap.borderLeft = `2.5px solid ${c.accent}`;
      wrap.paddingLeft = padPx || 12;
    } else if (st.surface === 'divider') {
      wrap.borderBottom = `1px solid ${tint(c.accent, 0.24)}`;
      wrap.paddingBottom = Math.max(gapPx - 4, 4);
    }

    return (
      <div key={idx} data-block data-gap-role="edu" style={wrap}>
        {header}
        {descEl}
      </div>
    );
  };

  if (education.length === 0) {
    return <p style={{ ...mutedStyle, fontStyle: 'italic' }}>Add education in your profile to populate this section.</p>;
  }

  return <>{education.map(renderEntry)}</>;
}

export function CertificatesBlock({
  design,
  style,
  certificates,
}: {
  design: ResumeDesign;
  style: CertificatesStyle;
  certificates: CertificateBlock[];
}) {
  const { typography: t, colors: c } = design;
  const base = t.base_font_pt * PT_TO_PX;
  const st = style ?? DEFAULT_CERTIFICATES_STYLE;
  const padPx = st.pad_pt * PT_TO_PX;

  const bodyStyle: CSSProperties = {
    color: c.text,
    lineHeight: t.line_spacing,
    fontSize: base,
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
    maxWidth: '100%',
  };
  const mutedStyle: CSSProperties = {
    color: c.muted,
    fontSize: base * 0.92,
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
  };
  const items = certificates.filter((e) => (e.name || '').trim());

  if (items.length === 0) {
    return <p style={{ ...mutedStyle, fontStyle: 'italic' }}>Add certifications in your profile to populate this section.</p>;
  }

  const ensureHttp = (u: string) => (/^https?:\/\//i.test(u) ? u : `https://${u.replace(/^\/+/, '')}`);

  const certNameNode = (cert: CertificateBlock, color: string): ReactNode => {
    const name = (cert.name || '').trim();
    const href = (cert.url || '').trim();
    if (!href) return name;
    return (
      <a href={ensureHttp(href)} target="_blank" rel="noopener noreferrer" style={{ color, textDecoration: 'none' }}>
        {name}
      </a>
    );
  };

  const certLabel = (cert: CertificateBlock, color: string = c.text): ReactNode => {
    const issued = formatFlexibleDate(cert.issued_at);
    return (
      <>
        {certNameNode(cert, color)}
        {issued ? <span style={{ color: c.muted }}> ({issued})</span> : null}
      </>
    );
  };

  const surface: CSSProperties = {};
  if (st.surface === 'card') {
    surface.border = `1px solid ${tint(c.accent, 0.22)}`;
    surface.borderRadius = st.radius_pt * PT_TO_PX;
    surface.padding = padPx || 12;
    surface.background = '#ffffff';
  } else if (st.surface === 'tint') {
    surface.background = tint(c.accent, 0.07);
    surface.borderRadius = st.radius_pt * PT_TO_PX;
    surface.padding = padPx || 12;
  }

  const chip = (cert: CertificateBlock, i: number): ReactNode => {
    const chipColor = st.accent_chips ? c.accent : c.text;
    return (
      <span
        key={i}
        style={{
          display: 'inline-block',
          fontSize: base * 0.9,
          lineHeight: 1.4,
          padding: '1px 9px',
          borderRadius: st.accent_chips ? 999 : 5,
          background: st.accent_chips ? tint(c.accent, 0.14) : '#f1f5f9',
          color: chipColor,
          border: `1px solid ${st.accent_chips ? tint(c.accent, 0.4) : '#e2e8f0'}`,
        }}
      >
        {certLabel(cert, chipColor)}
      </span>
    );
  };

  let content: ReactNode;
  if (st.layout === 'inline') {
    content = (
      <p style={{ ...bodyStyle, margin: 0 }}>
        {items.map((cert, i) => (
          <span key={i}>
            {i > 0 ? ', ' : ''}
            {certLabel(cert)}
          </span>
        ))}
      </p>
    );
  } else if (st.layout === 'pipe') {
    content = (
      <p style={{ ...bodyStyle, margin: 0 }}>
        {items.map((cert, i) => (
          <span key={i}>
            {i > 0 ? '  |  ' : ''}
            {certLabel(cert)}
          </span>
        ))}
      </p>
    );
  } else if (st.layout === 'chips') {
    content = (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{items.map((cert, i) => chip(cert, i))}</div>
    );
  } else if (st.layout === 'grid') {
    content = (
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${st.columns}, minmax(0, 1fr))`, columnGap: 16, rowGap: 2 }}>
        {items.map((cert, i) => {
          const marker = CERT_MARKER_GLYPH[st.marker] ?? '';
          if (!marker) {
            return (
              <p key={i} data-block data-gap-role="cert" style={{ ...bodyStyle, margin: '0 0 1px' }}>
                {certLabel(cert)}
              </p>
            );
          }
          return (
            <div key={i} data-block data-gap-role="cert" style={{ ...bodyStyle, margin: '0 0 1px', display: 'flex', gap: 5, alignItems: 'baseline' }}>
              <span style={{ flex: '0 0 auto', color: c.accent, fontWeight: 700 }}>{marker}</span>
              <span style={{ flex: '1 1 auto', minWidth: 0 }}>{certLabel(cert)}</span>
            </div>
          );
        })}
      </div>
    );
  } else {
    // list
    const rows = items.map((cert, i) => {
      const marker = CERT_MARKER_GLYPH[st.marker] ?? '';
      if (!marker) {
        return (
          <p key={i} data-block data-gap-role="cert" style={{ ...bodyStyle, margin: '0 0 1px' }}>
            {certLabel(cert)}
          </p>
        );
      }
      return (
        <div key={i} data-block data-gap-role="cert" style={{ ...bodyStyle, margin: '0 0 1px', display: 'flex', gap: 5, alignItems: 'baseline' }}>
          <span style={{ flex: '0 0 auto', color: c.accent, fontWeight: 700 }}>{marker}</span>
          <span style={{ flex: '1 1 auto', minWidth: 0 }}>{certLabel(cert)}</span>
        </div>
      );
    });
    content =
      st.columns === 2 ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', columnGap: 16, rowGap: 2 }}>{rows}</div>
      ) : (
        <>{rows}</>
      );
  }

  return Object.keys(surface).length > 0 ? <div data-block style={surface}>{content}</div> : <div data-block>{content}</div>;
}

export function ResumePreview({ design, profile, paged = false }: ResumePreviewProps) {
  const { typography: t, colors: c, layout: l, sections: opts } = design;
  const base = t.base_font_pt * PT_TO_PX;
  const mSides = marginSides(l);
  const hpSides = headerPadSides(l);
  const mTopPx = mSides.top * PT_TO_PX;
  const mRightPx = mSides.right * PT_TO_PX;
  const mBottomPx = mSides.bottom * PT_TO_PX;
  const mLeftPx = mSides.left * PT_TO_PX;

  const fontStack = useMemo(() => {
    const serif = ['Georgia', 'Cambria', 'Times New Roman', 'Garamond'];
    const fallback = serif.includes(t.font_family) ? 'serif' : 'sans-serif';
    // Render with the same font the .docx/PDF uses so wrapping + page breaks match.
    // Calibri designs render with the bundled, metric-identical Carlito (the original
    // family stays as a secondary fallback for the brief moment before the web font
    // loads, since it is metric-compatible).
    const primary = RESUME_FONT_RENDER[t.font_family] ?? t.font_family;
    const secondary = primary !== t.font_family ? `, "${t.font_family}"` : '';
    return `"${primary}"${secondary}, ${fallback}`;
  }, [t.font_family]);

  const skills = asArray<TechnicalSkillBlock>(profile?.technical_skills).filter((s) => (s.category || s.skills));
  const work = asArray<WorkExperienceBlock>(profile?.work_experience).filter((w) => (w.company_name || w.job_title));
  const education = asArray<EducationBlock>(profile?.education).filter((e) => (e.university_name || e.degree));
  const certificates = asArray<CertificateBlock>(profile?.certificates).filter((e) => e.name);

  const order = l.section_order.filter((s) => !l.hidden_sections.includes(s));
  const visible = order.filter((s) => {
    if (s === 'skills') return skills.length > 0;
    if (s === 'education') return education.length > 0;
    if (s === 'certificates') return certificates.length > 0;
    return true;
  });

  const headingStyle: CSSProperties = {
    fontSize: base * t.heading_scale,
    color: c.heading,
    fontWeight: 700,
    textTransform: t.uppercase_headings ? 'uppercase' : 'none',
    letterSpacing: t.uppercase_headings ? '0.04em' : 0,
    borderBottom: l.accent_rule ? `1.5px solid ${c.accent}` : 'none',
    paddingBottom: l.accent_rule ? 2 : 0,
    marginBottom: 5,
    marginTop: l.section_gap_pt * PT_TO_PX,
  };

  const bodyStyle: CSSProperties = { color: c.text, lineHeight: t.line_spacing };
  const mutedStyle: CSSProperties = { color: c.muted, fontSize: base * 0.92 };

  function Heading({ id }: { id: SectionId }) {
    return <div data-block data-gap-role="heading" style={headingStyle}>{SECTION_LABELS[id]}</div>;
  }

  function renderSection(id: SectionId) {
    switch (id) {
      case 'summary':
        return (
          <SummaryBlock
            key={id}
            design={design}
            style={opts.summary_style ?? DEFAULT_SUMMARY_STYLE}
            text={
              profile?.profile_summary?.trim() ||
              'Experienced professional with a track record of delivering measurable results across cross-functional teams.'
            }
            marginTop={l.section_gap_pt * PT_TO_PX}
            tagBlock
          />
        );
      case 'skills':
        return (
          <div key={id}>
            <Heading id={id} />
            <SkillsBlock design={design} style={opts.skills_style ?? DEFAULT_SKILLS_STYLE} skills={skills} />
          </div>
        );
      case 'experience':
        return (
          <div key={id}>
            <Heading id={id} />
            <ExperienceBlock
              design={design}
              style={opts.experience_style ?? DEFAULT_EXPERIENCE_STYLE}
              work={work}
              showPeriod={opts.show_period}
              showLocation={opts.show_location}
            />
          </div>
        );
      case 'education':
        return (
          <div key={id}>
            <Heading id={id} />
            <EducationBlock design={design} style={opts.education_style ?? DEFAULT_EDUCATION_STYLE} education={education} />
          </div>
        );
      case 'certificates':
        return (
          <div key={id}>
            <Heading id={id} />
            <CertificatesBlock design={design} style={opts.certificates_style ?? DEFAULT_CERTIFICATES_STYLE} certificates={certificates} />
          </div>
        );
      default:
        return null;
    }
  }

  const headerImage = l.header_background === 'image' ? l.header_image ?? null : null;
  const onDark = l.header_background === 'solid' || (!!headerImage && headerImage.text === 'light');
  const bandBg =
    l.header_background === 'solid'
      ? c.accent
      : l.header_background === 'soft'
        ? tint(c.accent, 0.14)
        : headerImage
          ? '#0f172a'
          : undefined;
  const nameColor = headerImage ? (headerImage.text === 'light' ? '#ffffff' : '#0f172a') : onDark ? '#ffffff' : c.heading;
  const titleColor = headerImage
    ? headerImage.text === 'light'
      ? '#f1f5f9'
      : '#334155'
    : onDark
      ? '#f1f5f9'
      : c.accent;
  const contactColor = headerImage
    ? headerImage.text === 'light'
      ? '#ffffff'
      : '#334155'
    : onDark
      ? '#ffffff'
      : c.muted;
  const contactStyle: CSSProperties = {
    color: contactColor,
    fontSize: base * 0.92,
    // Soft shadow keeps contacts readable over bright spots in photo headers.
    textShadow:
      headerImage && headerImage.text === 'light'
        ? '0 1px 2px rgba(0,0,0,0.55), 0 0 8px rgba(0,0,0,0.35)'
        : onDark
          ? '0 1px 2px rgba(0,0,0,0.45)'
          : undefined,
  };

  const header = (
    <div
      data-block
      data-header-band
      style={{
        textAlign: l.header_align,
        marginBottom: bandBg ? 0 : hpSides.bottom * PT_TO_PX,
        background: bandBg,
        // Stretch to fill, matches the .docx band picture (exact width × band height).
        // `cover` + center was cropping a differently-aspect baked image than the PDF
        // stretch, so the live preview and Accurate PDF showed different header scenes.
        backgroundImage: headerImage ? `url(${headerImage.data_url})` : undefined,
        backgroundSize: headerImage ? '100% 100%' : undefined,
        backgroundRepeat: headerImage ? 'no-repeat' : undefined,
        backgroundPosition: headerImage ? 'left top' : undefined,
        padding: bandBg
          ? `${hpSides.top * PT_TO_PX}px ${hpSides.right * PT_TO_PX}px ${hpSides.bottom * PT_TO_PX}px ${hpSides.left * PT_TO_PX}px`
          : 0,
      }}
    >
      <div style={{ fontSize: base * t.name_scale, color: nameColor, fontWeight: 700, lineHeight: 1.1 }}>
        {fullName(profile)}
      </div>
      {profile?.title && (
        <div style={{ fontSize: base * 1.1, color: titleColor, marginTop: 2, lineHeight: 1.2 }}>{profile.title}</div>
      )}
      {(() => {
        const items = contactItems(profile);
        // Match .docx icon height (cap-height ≈ 0.66em) so contacts don't look larger
        // in the live preview than in the Accurate PDF.
        const iconSize = base * 0.66;
        const justify = l.header_align === 'center' ? 'center' : 'flex-start';
        const iconStyle = l.contact_icons === 'none' || l.contact_icons === 'outline' ? l.contact_icons : 'brand';
        const showIcon = iconStyle !== 'none';
        const variant: 'brand' | 'outline' = iconStyle === 'outline' ? 'outline' : 'brand';
        const offX = (l.contact_icon_offset_x_pt ?? 0) * PT_TO_PX;
        const offY = (l.contact_icon_offset_y_pt ?? 0) * PT_TO_PX;
        const iconWrap: CSSProperties =
          offX || offY
            ? { display: 'block', transform: `translate(${offX}px, ${offY}px)`, flex: '0 0 auto' }
            : { display: 'block', flex: '0 0 auto' };
        if (l.contact_layout === 'stacked') {
          return (
            <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {items.map((it, i) => (
                <div key={i} style={{ ...contactStyle, display: 'flex', alignItems: 'center', gap: 6, justifyContent: justify }}>
                  {showIcon && (
                    <span style={iconWrap}>
                      <ContactIcon kind={it.kind} size={iconSize} color={contactColor} variant={variant} />
                    </span>
                  )}
                  <ContactText item={it} />
                </div>
              ))}
            </div>
          );
        }
        return (
          <div
            style={{
              ...contactStyle,
              marginTop: 4,
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: showIcon ? '3px 16px' : '3px 12px',
              justifyContent: justify,
              width: '100%',
              maxWidth: '100%',
              boxSizing: 'border-box',
            }}
          >
            {items.map((it, i) => (
              <span
                key={i}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  flex: '0 1 auto',
                  minWidth: 0,
                  maxWidth: '100%',
                }}
              >
                {showIcon && (
                  <span style={iconWrap}>
                    <ContactIcon kind={it.kind} size={iconSize} color={contactColor} variant={variant} />
                  </span>
                )}
                <ContactText item={it} />
                {!showIcon && i < items.length - 1 && <span style={{ opacity: 0.5 }}>&nbsp;|</span>}
              </span>
            ))}
          </div>
        );
      })()}
    </div>
  );

  const sidebarSet: SectionId[] = ['skills', 'education', 'certificates'];

  const body =
    l.columns === 2 ? (
      <div style={{ display: 'flex', gap: 18, minWidth: 0, maxWidth: '100%' }}>
        {/* minWidth:0 is required so flex children can shrink below content intrinsic width */}
        <div style={{ flex: '0 0 34%', minWidth: 0, maxWidth: '34%' }}>
          {visible.filter((s) => sidebarSet.includes(s)).map(renderSection)}
        </div>
        <div style={{ flex: '1 1 66%', minWidth: 0 }}>
          {visible.filter((s) => !sidebarSet.includes(s)).map(renderSection)}
        </div>
      </div>
    ) : (
      <div style={{ minWidth: 0, maxWidth: '100%' }}>{visible.map(renderSection)}</div>
    );

  if (bandBg) {
    return (
      <div
        style={{
          fontFamily: fontStack,
          fontSize: base,
          color: c.text,
          background: '#ffffff',
          width: '100%',
          boxSizing: 'border-box',
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
        }}
      >
        {header}
        <div style={{ padding: `${mTopPx * 0.6}px ${mRightPx}px ${paged ? 0 : mBottomPx}px ${mLeftPx}px` }}>{body}</div>
      </div>
    );
  }

  return (
    <div
      style={{
        fontFamily: fontStack,
        fontSize: base,
        color: c.text,
        background: '#ffffff',
        padding: paged ? `0 ${mRightPx}px 0 ${mLeftPx}px` : `${mTopPx}px ${mRightPx}px ${mBottomPx}px ${mLeftPx}px`,
        width: '100%',
        boxSizing: 'border-box',
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
      }}
    >
      {header}
      {body}
    </div>
  );
}
