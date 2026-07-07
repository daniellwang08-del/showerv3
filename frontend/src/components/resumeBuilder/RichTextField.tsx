import { useRef } from 'react';
import { Bold, Italic, Underline } from 'lucide-react';
import { renderRich } from '../../utils/richText';

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
  // Already wrapped immediately outside the selection -> unwrap.
  if (before.endsWith(m.open) && after.startsWith(m.close)) {
    const nb = before.slice(0, before.length - m.open.length);
    const na = after.slice(m.close.length);
    return { value: nb + sel + na, start: nb.length, end: nb.length + sel.length };
  }
  // Selection itself is wrapped -> unwrap.
  if (sel.startsWith(m.open) && sel.endsWith(m.close) && sel.length >= m.open.length + m.close.length) {
    const inner = sel.slice(m.open.length, sel.length - m.close.length);
    return { value: before + inner + after, start, end: start + inner.length };
  }
  const wrapped = m.open + sel + m.close;
  return { value: before + wrapped + after, start: start + m.open.length, end: start + m.open.length + sel.length };
}

export function RichTextField({
  label,
  value,
  onChange,
  rows = 3,
  placeholder,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const apply = (kind: 'bold' | 'italic' | 'underline') => {
    const el = ref.current;
    if (!el) return;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const res = toggleMarker(value, start, end, MARKERS[kind]);
    onChange(res.value);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(res.start, res.end);
    });
  };

  const btn =
    'inline-flex h-6 w-6 items-center justify-center rounded text-slate-500 transition hover:bg-slate-100 hover:text-slate-800';

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
          <span className="ml-auto text-[10px] text-slate-300">select text, then format</span>
        </div>
        <textarea
          ref={ref}
          value={value}
          rows={rows}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="block w-full resize-y rounded-b-lg bg-transparent px-2.5 py-1.5 text-xs text-slate-800 placeholder:text-slate-300 focus:outline-none"
        />
      </div>
      {value.trim() ? (
        <div className="mt-1 rounded-md bg-slate-50 px-2 py-1 text-[11px] leading-snug text-slate-600">
          {renderRich(value)}
        </div>
      ) : null}
    </div>
  );
}

export function PlainField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      {label ? <div className="mb-1 text-xs font-medium text-slate-600">{label}</div> : null}
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="block w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-800 placeholder:text-slate-300 focus:border-blue-400 focus:outline-none"
      />
    </label>
  );
}
