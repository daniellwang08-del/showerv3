import type { ReactNode } from 'react';

/**
 * Inline résumé markup, shared 1:1 with the backend (`app/utils/resume_text_format.py`)
 * so the live preview and the rendered DOCX agree exactly:
 *
 *   **bold**   - also what the tailoring LLM emits for ATS keywords
 *   *italic*
 *   __underline__
 *
 * A delimiter only formats when a matching closer exists later, so a lone "*" (e.g.
 * "3 * 4") or a snake_case token renders literally. Markers may nest (**__x__**).
 */

export interface RichSegment {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

function singleStarAhead(text: string, start: number): boolean {
  let j = start;
  const n = text.length;
  while (j < n) {
    if (text[j] === '*') {
      const prevStar = j > 0 && text[j - 1] === '*';
      const nextStar = j + 1 < n && text[j + 1] === '*';
      if (!prevStar && !nextStar) return true;
      j += nextStar ? 2 : 1;
      continue;
    }
    j += 1;
  }
  return false;
}

export function parseInlineMarkup(text: string): RichSegment[] {
  if (!text) return [];
  const n = text.length;
  let i = 0;
  let bold = false;
  let italic = false;
  let underline = false;
  const out: RichSegment[] = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      out.push({ text: buf, bold, italic, underline });
      buf = '';
    }
  };
  while (i < n) {
    const two = text.slice(i, i + 2);
    if (two === '**') {
      if (bold || text.indexOf('**', i + 2) !== -1) {
        flush();
        bold = !bold;
        i += 2;
        continue;
      }
    } else if (two === '__') {
      if (underline || text.indexOf('__', i + 2) !== -1) {
        flush();
        underline = !underline;
        i += 2;
        continue;
      }
    }
    const ch = text[i];
    if (ch === '*' && two !== '**') {
      if (italic || singleStarAhead(text, i + 1)) {
        flush();
        italic = !italic;
        i += 1;
        continue;
      }
    }
    buf += ch;
    i += 1;
  }
  flush();
  return unboldWordFragments(out.filter((s) => s.text));
}

const LETTER_END = /\p{L}$/u;
const LETTER_START = /^\p{L}/u;

/** Bold that splits a word ("**Design**ed") is never intended: render the word plain. */
function unboldWordFragments(segs: RichSegment[]): RichSegment[] {
  const fixed = segs.map((s, idx) => {
    if (!s.bold) return s;
    const prev = segs[idx - 1];
    const next = segs[idx + 1];
    const joinsPrev = prev && !prev.bold && LETTER_END.test(prev.text) && LETTER_START.test(s.text);
    const joinsNext = next && !next.bold && LETTER_END.test(s.text) && LETTER_START.test(next.text);
    return joinsPrev || joinsNext ? { ...s, bold: false } : s;
  });
  const merged: RichSegment[] = [];
  for (const s of fixed) {
    const last = merged[merged.length - 1];
    if (last && last.bold === s.bold && last.italic === s.italic && last.underline === s.underline) {
      last.text += s.text;
    } else {
      merged.push({ ...s });
    }
  }
  return merged;
}

/** Render résumé text with inline markup into React nodes (bold/italic/underline). */
export function renderRich(text: string | null | undefined): ReactNode {
  const segs = parseInlineMarkup(text ?? '');
  if (segs.length === 0) return text ?? '';
  if (segs.length === 1 && !segs[0].bold && !segs[0].italic && !segs[0].underline) {
    return segs[0].text;
  }
  return segs.map((s, idx) => {
    let node: ReactNode = s.text;
    if (s.bold) node = <strong key={`b${idx}`}>{node}</strong>;
    if (s.italic) node = <em key={`i${idx}`}>{node}</em>;
    if (s.underline) node = <u key={`u${idx}`}>{node}</u>;
    return <span key={idx}>{node}</span>;
  });
}

/** Flatten inline markup to plain text (e.g. for measuring or aria labels). */
export function stripInlineMarkup(text: string | null | undefined): string {
  return parseInlineMarkup(text ?? '')
    .map((s) => s.text)
    .join('');
}
