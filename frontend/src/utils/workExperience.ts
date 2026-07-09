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
  const structuredContribs = (w.contributions || []).map((c) => (c || '').trim()).filter(Boolean);
  return {
    projectTitle: (w.project_title || '').trim() || parsedProject.projectTitle || '',
    intro: (w.project_intro || '').trim() || parsedProject.description || '',
    contributions: structuredContribs.length ? structuredContribs : parsed.bullets,
  };
}
