import { useRef, type KeyboardEvent } from 'react';
import { Bold, Italic, Underline } from 'lucide-react';
import {
  ensureBulletLines,
  lineIsBullet,
  lineIsEmptyBullet,
} from '../../utils/workExperience';

type Marker = { open: string; close: string };

const MARKERS: Record<'bold' | 'italic' | 'underline', Marker> = {
  bold: { open: '**', close: '**' },
  italic: { open: '*', close: '*' },
  underline: { open: '__', close: '__' },
};

function toggleMarker(value: string, start: number, end: number, m: Marker) {
  const before = value.slice(0, start);
  const sel = value.slice(start, end);
  const after = value.slice(end);
  if (before.endsWith(m.open) && after.startsWith(m.close)) {
    const nb = before.slice(0, before.length - m.open.length);
    const na = after.slice(m.close.length);
    return { value: nb + sel + na, start: nb.length, end: nb.length + sel.length };
  }
  if (sel.startsWith(m.open) && sel.endsWith(m.close) && sel.length >= m.open.length + m.close.length) {
    const inner = sel.slice(m.open.length, sel.length - m.close.length);
    return { value: before + inner + after, start, end: start + inner.length };
  }
  const wrapped = m.open + sel + m.close;
  return { value: before + wrapped + after, start: start + m.open.length, end: start + m.open.length + sel.length };
}

function lineBounds(value: string, caret: number): { start: number; end: number; line: string } {
  const start = value.lastIndexOf('\n', Math.max(0, caret - 1)) + 1;
  const nextNl = value.indexOf('\n', caret);
  const end = nextNl === -1 ? value.length : nextNl;
  return { start, end, line: value.slice(start, end) };
}

function bulletPrefixLength(line: string): number {
  const m = line.match(/^(\s*(?:[-*▪‣◦∙·●•]|\d+[.)])\s*)/);
  return m ? m[1].length : 0;
}

/**
 * Key contributions editor, every line is a bullet (like Teal / Kickresume list inputs).
 * Enter always starts a new `- ` bullet; plain non-bullet lines are not used.
 */
export function ContributionsField({
  label = 'Key contributions',
  value,
  onChange,
  rows = 6,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const commit = (next: string, caret: number) => {
    const normalized = ensureBulletLines(next);
    onChange(normalized);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      // If normalization changed length slightly, clamp caret
      const pos = Math.max(0, Math.min(caret, normalized.length));
      el.setSelectionRange(pos, pos);
    });
  };

  const apply = (kind: 'bold' | 'italic' | 'underline') => {
    const el = ref.current;
    if (!el) return;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const res = toggleMarker(value, start, end, MARKERS[kind]);
    commit(res.value, res.end);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const caret = el.selectionStart ?? 0;
    const selEnd = el.selectionEnd ?? caret;
    const { start, end, line } = lineBounds(value, caret === selEnd ? caret : Math.min(caret, selEnd));

    // Enter always creates a new bullet line (never a plain newline).
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (caret !== selEnd) {
        // Replace selection, then new bullet
        const before = value.slice(0, caret);
        const after = value.slice(selEnd);
        const next = `${before}\n- ${after.replace(/^\n/, '')}`;
        commit(next, before.length + 3);
        return;
      }

      if (lineIsEmptyBullet(line)) {
        // Empty bullet at end: stay on it (don't stack empties). Mid-list: remove it.
        const isLastLine = end === value.length;
        if (isLastLine) return;
        const next = `${value.slice(0, start)}${value.slice(end + (value[end] === '\n' ? 1 : 0))}`;
        commit(next || '- ', start);
        return;
      }

      const before = value.slice(0, end);
      const after = value.slice(end);
      const insert = '\n- ';
      commit(before + insert + after.replace(/^\n/, ''), before.length + insert.length);
      return;
    }

    // Backspace at start of bullet text → unwrap is disabled (always bullets).
    // Backspace on empty bullet → remove that bullet line (keep at least one `- `).
    if (e.key === 'Backspace' && caret === selEnd) {
      if (lineIsEmptyBullet(line) && caret <= start + bulletPrefixLength(line)) {
        e.preventDefault();
        const lines = value.split('\n');
        if (lines.length <= 1) {
          commit('- ', 2);
          return;
        }
        const lineIdx = value.slice(0, start).split('\n').length - 1;
        lines.splice(lineIdx, 1);
        const next = lines.join('\n') || '- ';
        const newCaret = Math.min(start, next.length);
        commit(next, newCaret);
        return;
      }

      // Prevent deleting the `- ` prefix itself, move caret or remove previous line instead
      if (lineIsBullet(line)) {
        const prefixLen = bulletPrefixLength(line);
        if (caret === start + prefixLen && prefixLen > 0) {
          e.preventDefault();
          if (start === 0) return; // keep first bullet prefix
          // Merge with previous line: remove newline + current prefix, append body to prev
          const body = line.slice(prefixLen);
          const prevEnd = start - 1; // the \n
          const prevBounds = lineBounds(value, prevEnd);
          const next = `${value.slice(0, prevBounds.end)}${body ? ` ${body}` : ''}${value.slice(end)}`;
          commit(ensureBulletLines(next), prevBounds.end);
          return;
        }
      }
    }

    // Block typing that would clear the leading "- " on the current line via selecting it
    if ((e.key === 'Backspace' || e.key === 'Delete') && caret !== selEnd) {
      const sel = value.slice(Math.min(caret, selEnd), Math.max(caret, selEnd));
      if (sel.includes('\n') || /^\s*[-*▪‣◦∙·●•]/.test(sel)) {
        // Allow, then normalize on change
      }
    }
  };

  const onChangeText = (next: string) => {
    const el = ref.current;
    const caret = el?.selectionStart ?? next.length;
    // Soft-normalize: if user somehow created a plain line, prefix `- `
    const normalized = ensureBulletLines(next);
    onChange(normalized);
    if (normalized !== next) {
      requestAnimationFrame(() => {
        const node = ref.current;
        if (!node) return;
        node.setSelectionRange(Math.min(caret + 2, normalized.length), Math.min(caret + 2, normalized.length));
      });
    }
  };

  const btn =
    'inline-flex h-6 w-6 items-center justify-center rounded text-slate-500 transition hover:bg-slate-100 hover:text-slate-800';

  const displayValue = value.trim() ? value : '- ';

  return (
    <div>
      {label ? <div className="mb-1 text-xs font-medium text-slate-600">{label}</div> : null}
      <div className="rounded-lg border border-slate-200 bg-white focus-within:border-blue-400">
        <div className="flex items-center gap-0.5 border-b border-slate-100 px-1.5 py-1">
          <button type="button" className={btn} title="Bold (**)" onMouseDown={(e) => e.preventDefault()} onClick={() => apply('bold')}>
            <Bold size={13} />
          </button>
          <button type="button" className={btn} title="Italic (*)" onMouseDown={(e) => e.preventDefault()} onClick={() => apply('italic')}>
            <Italic size={13} />
          </button>
          <button type="button" className={btn} title="Underline (__)" onMouseDown={(e) => e.preventDefault()} onClick={() => apply('underline')}>
            <Underline size={13} />
          </button>
          <span className="ml-auto text-[10px] text-slate-300">Enter = new bullet</span>
        </div>
        <textarea
          ref={ref}
          value={displayValue}
          rows={rows}
          placeholder={'- First contribution\n- Second contribution\n- Enter adds another bullet'}
          onChange={(e) => onChangeText(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => {
            if (!value.trim()) onChange('- ');
          }}
          className="block w-full resize-y break-words rounded-b-lg bg-transparent px-2.5 py-1.5 text-xs text-slate-800 placeholder:text-slate-300 focus:outline-none"
          style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}
        />
      </div>
    </div>
  );
}
