/** Shared parsing for a role's free-form `description` blob.
 *
 *  Historically imported/AI-parsed profiles stored everything for a role inside a
 *  single `description` string (e.g. "Project: X\n\n<intro>\nKey Contributions:\n- a\n- b"
 *  or an inline "... - a - b" form) instead of the structured project_title /
 *  project_intro / contributions[] fields. These helpers split that blob back into
 *  structured pieces so the profile view, the profile editor, and the resume preview
 *  all render the exact same bullet structure. */

const INLINE_BULLET_RE = /[•▪‣◦∙·●]/;
const LINE_BULLET_RE = /^\s*(?:[-*▪‣◦∙·●]|\d+[.)])\s+(.*)$/;
const PROJECT_LINE_RE = /^\s*project\s*[:\-\u2013\u2014]\s*/i;

/** A line that starts a markdown-style bullet (`-`, `*`, `•`, or `1.`). */
export const EDITOR_BULLET_LINE_RE = /^\s*(?:[-*▪‣◦∙·●•]|\d+[.)])\s*(.*)$/;

export function splitProjectLead(lead: string): { projectTitle: string | null; description: string } {
  const segments = lead.split('\n').map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return { projectTitle: null, description: '' };
  const first = segments[0];
  const m = first.match(PROJECT_LINE_RE);
  const looksLikeTitle = !!m && (segments.length > 1 || first.length <= 80);
  if (looksLikeTitle && m) {
    return { projectTitle: first.slice(m[0].length).trim(), description: segments.slice(1).join(' ').trim() };
  }
  return { projectTitle: null, description: segments.join(' ').trim() };
}

export function splitDescription(text: string): { lead: string; bullets: string[] } {
  const s = (text || '').trim();
  if (!s) return { lead: '', bullets: [] };
  if (INLINE_BULLET_RE.test(s)) {
    const segs = s
      .split(INLINE_BULLET_RE)
      .map((seg) => seg.replace(/^[\s\-\u2013\u2014]+|[\s]+$/g, '').trim())
      .filter(Boolean);
    if (segs.length >= 2) return { lead: segs[0], bullets: segs.slice(1) };
    return { lead: s, bullets: [] };
  }
  const lines = s.split('\n').map((ln) => ln.trim()).filter(Boolean);
  const matches = lines.map((ln) => ln.match(LINE_BULLET_RE));
  if (matches.filter(Boolean).length >= 2) {
    const lead: string[] = [];
    const bullets: string[] = [];
    lines.forEach((ln, i) => {
      const m = matches[i];
      if (m) bullets.push(m[1].trim());
      else if (bullets.length === 0) lead.push(ln);
    });
    return { lead: lead.join(' ').trim(), bullets };
  }
  return { lead: s, bullets: [] };
}

export type DerivedWorkContent = {
  projectTitle: string;
  intro: string;
  contributions: string[];
};

/** Structured project title / intro / contribution bullets for a role. Prefers the
 *  explicit structured fields and falls back to parsing the legacy `description` blob.
 *  This is the single source of truth shared by the resume preview and the profile UI. */
export function deriveWorkContent(w: {
  project_title?: string;
  project_intro?: string;
  contributions?: string[] | null;
  description?: string;
}): DerivedWorkContent {
  const desc = (w.description || '').trim();
  const parsed = splitDescription(desc);
  const parsedProject = splitProjectLead(parsed.lead);
  const structuredContribs = resumeBulletsFromContributions(w.contributions);
  return {
    projectTitle: (w.project_title || '').trim() || parsedProject.projectTitle || '',
    intro: (w.project_intro || '').trim() || parsedProject.description || '',
    contributions: structuredContribs.length ? structuredContribs : parsed.bullets,
  };
}

export type ContributionsEditorLine =
  | { kind: 'bullet'; text: string; raw: string }
  | { kind: 'prose'; text: string; raw: string }
  | { kind: 'blank'; raw: string };

/** Parse one editor line. Only `-` / `*` / `•` / numbered prefixes count as bullets. */
export function parseContributionsEditorLine(raw: string): ContributionsEditorLine {
  if (raw === '') return { kind: 'blank', raw };
  const m = raw.match(EDITOR_BULLET_LINE_RE);
  if (m) {
    return { kind: 'bullet', text: (m[1] ?? '').trimEnd(), raw };
  }
  return { kind: 'prose', text: raw, raw };
}

export function parseContributionsEditorText(text: string): ContributionsEditorLine[] {
  return String(text ?? '').split('\n').map(parseContributionsEditorLine);
}

export function ensureBulletLines(text: string): string {
  const raw = String(text ?? '');
  if (!raw.trim()) return '- ';
  return raw
    .split('\n')
    .map((ln) => {
      if (!ln.trim()) return '- ';
      if (lineIsBullet(ln)) {
        const body = ln.replace(/^\s*(?:[-*▪‣◦∙·●•]|\d+[.)])\s*/, '');
        return `- ${body}`;
      }
      return `- ${ln.replace(/^\s+/, '')}`;
    })
    .join('\n');
}

/** Always show stored contributions as `- ` bullet lines in the editor. */
export function contributionsToEditorText(contributions: string[] | null | undefined): string {
  const list = contributions ?? [];
  if (!list.length) return '- ';
  return ensureBulletLines(
    list
      .map((c) => {
        const t = (c ?? '').trimEnd();
        if (!t.trim()) return '- ';
        if (lineIsBullet(t)) return t;
        return `- ${t}`;
      })
      .join('\n'),
  );
}

/**
 * Persist editor text → contribution lines (keeps `- ` markers for round-trip).
 * Empty editor becomes a single empty bullet placeholder that resume rendering skips.
 */
export function editorTextToContributions(text: string): string[] {
  return ensureBulletLines(text).split('\n');
}

/**
 * Bullets that belong on the résumé.
 * - If any line is dash-marked, only those lines are bullets (plain sentences are not).
 * - Legacy arrays with no markers: every non-empty line is a bullet.
 */
export function resumeBulletsFromContributions(contributions: string[] | null | undefined): string[] {
  const list = Array.isArray(contributions)
    ? contributions.map((c) => (typeof c === 'string' ? c : c == null ? '' : String(c)))
    : typeof contributions === 'string'
      ? [contributions]
      : [];
  const marked = list
    .map((ln) => parseContributionsEditorLine(ln))
    .filter((ln): ln is Extract<ContributionsEditorLine, { kind: 'bullet' }> => ln.kind === 'bullet')
    .map((ln) => ln.text.trim())
    .filter(Boolean);
  if (marked.length) return marked;
  const anyMarkedPrefix = list.some((ln) => EDITOR_BULLET_LINE_RE.test(ln));
  if (anyMarkedPrefix) return marked;
  return list.map((c) => (c || '').trim()).filter(Boolean);
}

/** True when the caret's line is a bullet (possibly empty after `- `). */
export function lineIsBullet(line: string): boolean {
  return EDITOR_BULLET_LINE_RE.test(line);
}

/** Empty bullet like `-` or `- ` (ready to exit list on Enter). */
export function lineIsEmptyBullet(line: string): boolean {
  const m = line.match(EDITOR_BULLET_LINE_RE);
  return Boolean(m && !(m[1] ?? '').trim());
}
