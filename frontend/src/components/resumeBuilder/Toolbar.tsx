import type { ReactNode } from 'react';
import { Check, Cloud, Download, Eye, Loader2, RotateCcw } from 'lucide-react';

export function Toolbar({
  dirty,
  saving,
  previewing,
  downloading,
  ready,
  onReset,
  onPreview,
  onDownload,
}: {
  dirty: boolean;
  saving: boolean;
  previewing: boolean;
  downloading: boolean;
  ready: boolean;
  onReset: () => void;
  onPreview: () => void;
  onDownload: () => void;
}) {
  // Changes auto-save; the pill reflects live status instead of a manual button.
  const status: { tone: string; dot: string; icon: ReactNode; label: string } =
    saving || dirty
      ? {
          tone: 'bg-blue-50 text-blue-700',
          dot: 'bg-blue-500',
          icon: <Loader2 size={13} className="animate-spin" />,
          label: 'Saving…',
        }
      : ready
        ? {
            tone: 'bg-emerald-50 text-emerald-700',
            dot: 'bg-emerald-500',
            icon: <Check size={13} />,
            label: 'All changes saved',
          }
        : {
            tone: 'bg-slate-100 text-slate-500',
            dot: 'bg-slate-400',
            icon: <Cloud size={13} />,
            label: 'Saved',
          };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={`mr-1 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${status.tone}`}>
        {status.icon}
        {status.label}
      </span>

      <button
        type="button"
        onClick={onReset}
        disabled={!dirty || saving}
        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
      >
        <RotateCcw size={15} />
        Reset
      </button>

      <button
        type="button"
        onClick={onPreview}
        disabled={previewing}
        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-50"
      >
        {previewing ? <Loader2 size={15} className="animate-spin" /> : <Eye size={15} />}
        Accurate PDF
      </button>

      <button
        type="button"
        onClick={onDownload}
        disabled={downloading}
        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-50"
      >
        {downloading ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
        .docx
      </button>
    </div>
  );
}
