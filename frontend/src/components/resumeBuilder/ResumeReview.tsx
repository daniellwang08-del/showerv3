import { AlertTriangle, CheckCircle2, Info, Loader2, Minimize2, ScanSearch, ShieldCheck, XCircle } from 'lucide-react';
import type { ResumeDesign, SectionId } from '../../types/resumeDesign';
import {
  DEFAULT_EDUCATION_STYLE,
  DEFAULT_EXPERIENCE_STYLE,
  isExtraSectionId,
  marginSides,
  sectionTitle,
} from '../../types/resumeDesign';
import type { UserProfile, WorkExperienceBlock } from '../../types/profile';
import { deriveWorkContent } from '../../utils/workExperience';
import { formatResumeHeaderLocation } from '../../utils/resumeLocation';
import { ControlCard } from './controls';
import { filledExtraItems } from './ResumePreview';

export type CheckLevel = 'pass' | 'tip' | 'warn' | 'error';
export type CheckGroup = 'ats' | 'content' | 'layout';

export interface ReviewCheck {
  id: string;
  group: CheckGroup;
  level: CheckLevel;
  title: string;
  detail?: string;
}

const PENALTY: Record<CheckLevel, number> = { pass: 0, tip: 2, warn: 6, error: 14 };

const WEAK_OPENERS = /^(responsible for|worked on|helped( with)?|assisted( with)?|involved in|tasked with|duties included|participated in)\b/i;

/** Words ATS parsers look for in each core heading; a rename should keep one. */
const STANDARD_HEADINGS: Partial<Record<SectionId, RegExp>> = {
  experience: /experience|employment|work history|career/i,
  education: /education|academic|qualification/i,
  skills: /skill|competenc|expertise|technolog|tool/i,
  summary: /summary|profile|about|objective|overview/i,
  certificates: /certif|licen|credential/i,
};

function plain(text: string): string {
  return text.replace(/[*_~`]+/g, '').replace(/\s+/g, ' ').trim();
}

function words(text: string): number {
  const t = plain(text);
  return t ? t.split(' ').length : 0;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** Resume checks a recruiter or ATS would care about. Pure, so it is easy to test. */
export function reviewResume(design: ResumeDesign, profile: UserProfile | null, pageCount: number): ReviewCheck[] {
  const checks: ReviewCheck[] = [];
  const add = (c: ReviewCheck) => checks.push(c);
  const hidden = new Set(design.layout.hidden_sections);
  const shown = (id: SectionId) => !hidden.has(id) && design.layout.section_order.includes(id);

  // ATS and parsing
  const email = (profile?.email || '').trim();
  const phone = (profile?.phone_number || '').trim();
  const location = formatResumeHeaderLocation(profile?.address);
  const missing = [!email && 'email', !phone && 'phone', !location && 'location'].filter(Boolean) as string[];
  add(
    missing.length
      ? {
          id: 'contact',
          group: 'ats',
          level: missing.includes('email') ? 'error' : 'warn',
          title: `Add your ${missing.join(', ')}`,
          detail: 'Recruiters and ATS profiles are built from the contact line.',
        }
      : { id: 'contact', group: 'ats', level: 'pass', title: 'Contact details are complete' },
  );
  if (!(profile?.linkedin_url || '').trim()) {
    add({ id: 'linkedin', group: 'ats', level: 'tip', title: 'Add a LinkedIn URL', detail: 'Most recruiters check it before reaching out.' });
  }

  const offStandard = (Object.keys(STANDARD_HEADINGS) as SectionId[]).filter((id) => {
    const custom = design.sections.titles?.[id];
    return shown(id) && custom && !STANDARD_HEADINGS[id]!.test(custom);
  });
  add(
    offStandard.length
      ? {
          id: 'headings',
          group: 'ats',
          level: 'warn',
          title: `Unusual heading${offStandard.length > 1 ? 's' : ''}: ${offStandard.map((id) => `"${sectionTitle(design, id)}"`).join(', ')}`,
          detail: 'ATS parsers map sections by name. Keep a standard word such as Experience, Education or Skills.',
        }
      : { id: 'headings', group: 'ats', level: 'pass', title: 'Section headings are ATS friendly' },
  );

  const photo = design.layout.photo;
  if (photo?.enabled && photo.data_url) {
    add({
      id: 'photo',
      group: 'ats',
      level: 'tip',
      title: 'Photo is on',
      detail: 'ATS ignores it safely, but US, UK and Canadian recruiters usually prefer resumes without a photo.',
    });
  }

  if (design.typography.base_font_pt < 9.5) {
    add({ id: 'font-size', group: 'ats', level: 'warn', title: 'Body text is very small', detail: 'Use at least 9.5 pt so it stays readable when printed.' });
  }

  // Content quality
  const summary = (profile?.profile_summary || '').trim();
  const summaryWords = words(summary);
  if (shown('summary')) {
    if (!summaryWords) {
      add({ id: 'summary', group: 'content', level: 'error', title: 'Write a professional summary', detail: 'Two to four sentences on who you are and the value you bring.' });
    } else if (summaryWords < 25) {
      add({ id: 'summary', group: 'content', level: 'tip', title: 'Summary is short', detail: `${summaryWords} words. Aim for 30 to 90.` });
    } else if (summaryWords > 120) {
      add({ id: 'summary', group: 'content', level: 'warn', title: 'Summary is long', detail: `${summaryWords} words. Recruiters skim; aim for 30 to 90.` });
    } else {
      add({ id: 'summary', group: 'content', level: 'pass', title: 'Summary length is right' });
    }
  }

  const work = asArray<WorkExperienceBlock>(profile?.work_experience).filter((w) => w.company_name || w.job_title);
  if (!work.length) {
    add({ id: 'work', group: 'content', level: 'error', title: 'Add work experience', detail: 'Experience is the section recruiters read first.' });
  } else {
    const bullets = work.flatMap((w) => deriveWorkContent(w).contributions.map(plain).filter(Boolean));
    const thin = work.filter((w) => deriveWorkContent(w).contributions.filter((c) => plain(c)).length < 2);
    const noDates = work.filter((w) => !(w.period_start || '').trim());
    const weak = bullets.filter((b) => WEAK_OPENERS.test(b));
    const long = bullets.filter((b) => words(b) > 40);
    const measured = bullets.filter((b) => /\d/.test(b));

    add(
      thin.length
        ? {
            id: 'bullets',
            group: 'content',
            level: 'warn',
            title: `${thin.length} role${thin.length > 1 ? 's have' : ' has'} fewer than 2 bullets`,
            detail: thin.map((w) => w.job_title || w.company_name).join(', '),
          }
        : { id: 'bullets', group: 'content', level: 'pass', title: 'Every role has supporting bullets' },
    );
    if (noDates.length) {
      add({
        id: 'dates',
        group: 'content',
        level: 'warn',
        title: `${noDates.length} role${noDates.length > 1 ? 's are' : ' is'} missing a start date`,
        detail: 'Gaps in dates are a common reason recruiters pass.',
      });
    }
    if (weak.length) {
      add({
        id: 'verbs',
        group: 'content',
        level: 'tip',
        title: `${weak.length} bullet${weak.length > 1 ? 's start' : ' starts'} with a weak phrase`,
        detail: `Lead with an action verb (Led, Built, Cut, Grew) instead of "${weak[0].split(' ').slice(0, 3).join(' ')}".`,
      });
    } else if (bullets.length) {
      add({ id: 'verbs', group: 'content', level: 'pass', title: 'Bullets lead with action' });
    }
    if (long.length) {
      add({ id: 'long-bullets', group: 'content', level: 'tip', title: `${long.length} bullet${long.length > 1 ? 's are' : ' is'} over 40 words`, detail: 'Split or trim them; one or two lines reads best.' });
    }
    if (bullets.length >= 3) {
      const share = measured.length / bullets.length;
      add(
        share < 0.3
          ? {
              id: 'metrics',
              group: 'content',
              level: 'tip',
              title: `Only ${Math.round(share * 100)}% of bullets have numbers`,
              detail: 'Quantify impact: %, $, time saved, users, team size.',
            }
          : { id: 'metrics', group: 'content', level: 'pass', title: 'Impact is quantified' },
      );
    }
  }

  const skills = asArray<{ category?: string; skills?: string }>(profile?.technical_skills).filter((s) => s.category || s.skills);
  if (shown('skills') && !skills.length) {
    add({ id: 'skills', group: 'content', level: 'warn', title: 'Add skills', detail: 'ATS keyword matching leans heavily on the skills section.' });
  }

  for (const extra of design.extra_sections ?? []) {
    if (shown(extra.id) && !filledExtraItems(extra).length) {
      add({ id: `empty-${extra.id}`, group: 'content', level: 'tip', title: `"${sectionTitle(design, extra.id)}" is empty`, detail: 'Empty sections are not printed. Add items or remove it.' });
    }
  }

  // Layout
  if (pageCount > 2) {
    add({ id: 'pages', group: 'layout', level: 'warn', title: `${pageCount} pages`, detail: 'Most resumes should fit on one or two pages. Try Fit to 2 pages.' });
  } else {
    add({ id: 'pages', group: 'layout', level: 'pass', title: `${pageCount} ${pageCount === 1 ? 'page' : 'pages'}` });
  }
  const m = marginSides(design.layout);
  if (Math.min(m.top, m.right, m.bottom, m.left) < 30) {
    add({ id: 'margins', group: 'layout', level: 'tip', title: 'Margins are tight', detail: 'Keep at least 0.4 in (30 pt) so printers do not clip text.' });
  }
  const extrasShown = design.layout.section_order.filter((id) => isExtraSectionId(id) && !hidden.has(id)).length;
  if (extrasShown > 4) {
    add({ id: 'sections', group: 'layout', level: 'tip', title: 'Many extra sections', detail: 'Keep the ones that support the job you want.' });
  }

  return checks;
}

export function reviewScore(checks: ReviewCheck[]): number {
  return Math.max(0, Math.min(100, 100 - checks.reduce((sum, c) => sum + PENALTY[c.level], 0)));
}

/** One tightening step toward fewer pages, or null when nothing is left to tighten. */
export function tightenDesign(d: ResumeDesign): ResumeDesign | null {
  const t = d.typography;
  const l = d.layout;
  const ex = d.sections.experience_style ?? DEFAULT_EXPERIENCE_STYLE;
  const ed = d.sections.education_style ?? DEFAULT_EDUCATION_STYLE;
  const reset = { ...l, layout_metrics: null };
  if (l.section_gap_pt > 6 || ex.entry_gap_pt > 4) {
    return {
      ...d,
      layout: { ...reset, section_gap_pt: Math.max(6, l.section_gap_pt - 2) },
      sections: {
        ...d.sections,
        experience_style: { ...ex, entry_gap_pt: Math.max(4, ex.entry_gap_pt - 2) },
        education_style: { ...ed, entry_gap_pt: Math.max(3, ed.entry_gap_pt - 1) },
      },
    };
  }
  if (t.line_spacing > 1.06) {
    return { ...d, layout: reset, typography: { ...t, line_spacing: Math.max(1.05, Number((t.line_spacing - 0.03).toFixed(2))) } };
  }
  const m = marginSides(l);
  if (Math.max(m.top, m.right, m.bottom, m.left) > 36) {
    const shrink = (v: number) => Math.max(36, v - 6);
    return {
      ...d,
      layout: {
        ...reset,
        margin_pt: shrink(l.margin_pt),
        margin_top_pt: shrink(m.top),
        margin_right_pt: shrink(m.right),
        margin_bottom_pt: shrink(m.bottom),
        margin_left_pt: shrink(m.left),
      },
    };
  }
  if (t.base_font_pt > 9.5) {
    return { ...d, layout: reset, typography: { ...t, base_font_pt: Math.max(9.5, t.base_font_pt - 0.25) } };
  }
  return null;
}

const LEVEL_ICON = {
  pass: { icon: CheckCircle2, cls: 'text-status-ready' },
  tip: { icon: Info, cls: 'text-brand' },
  warn: { icon: AlertTriangle, cls: 'text-status-preparing' },
  error: { icon: XCircle, cls: 'text-destructive' },
} as const;

const GROUPS: { id: CheckGroup; title: string; icon: typeof ShieldCheck }[] = [
  { id: 'ats', title: 'ATS and parsing', icon: ShieldCheck },
  { id: 'content', title: 'Content', icon: ScanSearch },
  { id: 'layout', title: 'Length and layout', icon: Minimize2 },
];

const ORDER: Record<CheckLevel, number> = { error: 0, warn: 1, tip: 2, pass: 3 };

export type FitState = { target: 1 | 2; status: 'running' | 'done' | 'stuck' } | null;

export function ResumeReview({
  design,
  profile,
  pageCount,
  fit,
  onFit,
  onUndoFit,
}: {
  design: ResumeDesign;
  profile: UserProfile | null;
  pageCount: number;
  fit: FitState;
  onFit: (target: 1 | 2) => void;
  onUndoFit?: () => void;
}) {
  const checks = reviewResume(design, profile, pageCount);
  const score = reviewScore(checks);
  const tone = score >= 85 ? 'text-status-ready' : score >= 65 ? 'text-status-preparing' : 'text-destructive';
  const issues = checks.filter((c) => c.level === 'error' || c.level === 'warn').length;
  const running = fit?.status === 'running';

  return (
    <>
      <ControlCard icon={ScanSearch} title="Resume check" wide>
        <div className="flex min-w-0 flex-wrap items-center gap-4">
          <div className="relative grid size-20 shrink-0 place-items-center">
            <svg viewBox="0 0 36 36" className="absolute inset-0 -rotate-90" aria-hidden="true">
              <circle cx="18" cy="18" r="15.5" fill="none" strokeWidth="3" className="stroke-muted" />
              <circle
                cx="18"
                cy="18"
                r="15.5"
                fill="none"
                strokeWidth="3"
                strokeLinecap="round"
                strokeDasharray={`${(score / 100) * 97.4} 97.4`}
                className={`stroke-current ${tone}`}
              />
            </svg>
            <span className={`text-xl font-bold tabular-nums ${tone}`} aria-label={`Score ${score} out of 100`}>
              {score}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">
              {issues === 0 ? 'Ready to send' : `${issues} thing${issues > 1 ? 's' : ''} to fix`}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Checks update as you edit. Tips are optional polish.
            </p>
          </div>
          <div className="flex shrink-0 flex-col gap-1.5">
            {([1, 2] as const).map((target) => (
              <button
                key={target}
                type="button"
                disabled={running || pageCount <= target}
                onClick={() => onFit(target)}
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border px-3 text-xs font-semibold text-foreground transition hover:border-brand hover:text-brand disabled:pointer-events-none disabled:opacity-40"
              >
                {running && fit?.target === target ? <Loader2 className="size-3.5 animate-spin" /> : <Minimize2 className="size-3.5" />}
                Fit to {target} {target === 1 ? 'page' : 'pages'}
              </button>
            ))}
          </div>
        </div>
        {fit && fit.status !== 'running' && (
          <div className="flex min-w-0 items-start gap-2" role="status">
            <p className={`min-w-0 flex-1 text-xs ${fit.status === 'done' ? 'text-status-ready' : 'text-status-preparing'}`}>
              {fit.status === 'done'
                ? `Fits on ${fit.target} ${fit.target === 1 ? 'page' : 'pages'}. Spacing, margins and text size were tightened.`
                : `Reached the tightest readable layout and it is still ${pageCount} pages. Trim content or hide a section.`}
            </p>
            {onUndoFit && (
              <button type="button" onClick={onUndoFit} className="shrink-0 text-xs font-semibold text-brand hover:underline">
                Undo
              </button>
            )}
          </div>
        )}
      </ControlCard>

      {GROUPS.map((g) => {
        const list = checks.filter((c) => c.group === g.id).sort((a, b) => ORDER[a.level] - ORDER[b.level]);
        if (!list.length) return null;
        return (
          <ControlCard key={g.id} icon={g.icon} title={g.title}>
            <ul className="space-y-2">
              {list.map((c) => {
                const { icon: Icon, cls } = LEVEL_ICON[c.level];
                return (
                  <li key={c.id} className="flex min-w-0 items-start gap-2">
                    <Icon className={`mt-0.5 size-4 shrink-0 ${cls}`} aria-label={c.level} />
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-foreground">{c.title}</p>
                      {c.detail && <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{c.detail}</p>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </ControlCard>
        );
      })}
    </>
  );
}
