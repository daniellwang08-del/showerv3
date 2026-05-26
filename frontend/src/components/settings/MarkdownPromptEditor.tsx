import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Eye, PencilLine } from 'lucide-react';

type Tab = 'write' | 'preview';

type Props = {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  disabled?: boolean;
  placeholder?: string;
  rows?: number;
};

const markdownComponents = {
  h1: ({ children }: { children?: ReactNode }) => (
    <h1 className="mb-3 text-lg font-bold text-slate-900">{children}</h1>
  ),
  h2: ({ children }: { children?: ReactNode }) => (
    <h2 className="mb-2 mt-4 border-b border-slate-200 pb-1 text-base font-bold text-slate-900">{children}</h2>
  ),
  h3: ({ children }: { children?: ReactNode }) => (
    <h3 className="mb-2 mt-3 text-sm font-bold text-slate-900">{children}</h3>
  ),
  p: ({ children }: { children?: ReactNode }) => (
    <p className="mb-3 text-sm leading-relaxed text-slate-700">{children}</p>
  ),
  ul: ({ children }: { children?: ReactNode }) => (
    <ul className="mb-3 list-disc space-y-1.5 pl-5 text-sm text-slate-700">{children}</ul>
  ),
  ol: ({ children }: { children?: ReactNode }) => (
    <ol className="mb-3 list-decimal space-y-1.5 pl-5 text-sm text-slate-700">{children}</ol>
  ),
  li: ({ children }: { children?: ReactNode }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }: { children?: ReactNode }) => (
    <strong className="font-semibold text-slate-900">{children}</strong>
  ),
  em: ({ children }: { children?: ReactNode }) => <em className="italic text-slate-700">{children}</em>,
  code: ({ children }: { children?: ReactNode }) => (
    <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.85em] text-slate-800">{children}</code>
  ),
  hr: () => <hr className="my-4 border-slate-200" />,
};

export function MarkdownPromptEditor({
  id,
  value,
  onChange,
  maxLength,
  disabled = false,
  placeholder = 'Write markdown instructions…',
  rows = 16,
}: Props) {
  const [tab, setTab] = useState<Tab>('write');
  const safeValue = value ?? '';
  const trimmedLength = safeValue.trim().length;

  const preview = useMemo(
    () => (
      <div className="min-h-[22rem] px-4 py-3">
        {trimmedLength > 0 ? (
          <ReactMarkdown components={markdownComponents}>{safeValue}</ReactMarkdown>
        ) : (
          <p className="text-sm italic text-slate-400">Nothing to preview yet.</p>
        )}
      </div>
    ),
    [safeValue, trimmedLength],
  );

  return (
    <div className="overflow-hidden rounded-xl border border-slate-300 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-2">
        <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5">
          <button
            type="button"
            disabled={disabled}
            onClick={() => setTab('write')}
            className={[
              'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold transition',
              tab === 'write'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
              disabled ? 'cursor-not-allowed opacity-50' : '',
            ].join(' ')}
          >
            <PencilLine className="h-3.5 w-3.5" />
            Write
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => setTab('preview')}
            className={[
              'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold transition',
              tab === 'preview'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
              disabled ? 'cursor-not-allowed opacity-50' : '',
            ].join(' ')}
          >
            <Eye className="h-3.5 w-3.5" />
            Preview
          </button>
        </div>
        <span className="text-xs tabular-nums text-slate-500">
          {trimmedLength.toLocaleString()} / {maxLength.toLocaleString()}
        </span>
      </div>

      {tab === 'write' ? (
        <textarea
          id={id}
          value={safeValue}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          maxLength={maxLength}
          placeholder={placeholder}
          spellCheck={false}
          className="page-scroll-y-auto block w-full resize-y border-0 bg-white px-4 py-3 font-mono text-xs leading-relaxed text-slate-800 outline-none focus:ring-2 focus:ring-inset focus:ring-blue-200"
        />
      ) : (
        <div className="page-scroll-y-auto min-h-[22rem] overflow-y-auto">{preview}</div>
      )}
    </div>
  );
}

export function MarkdownPromptPreview({
  value,
  className = '',
}: {
  value: string;
  className?: string;
}) {
  const safeValue = value ?? '';
  if (!safeValue.trim()) {
    return <p className="text-sm italic text-slate-400">No instructions available.</p>;
  }
  return (
    <div
      className={`rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 ${className}`.trim()}
    >
      <ReactMarkdown components={markdownComponents}>{safeValue}</ReactMarkdown>
    </div>
  );
}
