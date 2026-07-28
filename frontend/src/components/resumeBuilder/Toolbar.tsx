import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Cloud, Eye, Loader2, Palette, RotateCcw, X } from 'lucide-react';

export function Toolbar({
  dirty,
  saving,
  previewing,
  ready,
  savingTheme = false,
  onReset,
  onPreview,
  onSaveTheme,
}: {
  dirty: boolean;
  saving: boolean;
  previewing: boolean;
  ready: boolean;
  savingTheme?: boolean;
  onReset: () => void;
  onPreview: () => void;
  onSaveTheme?: (name: string) => Promise<boolean>;
}) {
  const [themeEditorOpen, setThemeEditorOpen] = useState(false);
  const [themeName, setThemeName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (themeEditorOpen) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [themeEditorOpen]);

  const status: { tone: string; icon: ReactNode; label: string; short: string } = saving
    ? {
        tone: 'bg-blue-50 text-blue-700',
        icon: <Loader2 size={13} className="animate-spin" />,
        label: 'Saving…',
        short: 'Saving',
      }
    : dirty
      ? {
          tone: 'bg-amber-50 text-amber-800',
          icon: <Cloud size={13} />,
          label: 'Unsaved changes',
          short: 'Unsaved',
        }
      : ready
        ? {
            tone: 'bg-emerald-50 text-emerald-700',
            icon: <Check size={13} />,
            label: 'All changes saved',
            short: 'Saved',
          }
        : {
            tone: 'bg-slate-100 text-slate-500',
            icon: <Cloud size={13} />,
            label: 'Saved',
            short: 'Saved',
          };

  const btnBase =
    'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-2.5 text-sm font-medium transition sm:px-3';

  const submitTheme = async () => {
    if (!onSaveTheme || savingTheme) return;
    const name = themeName.trim();
    if (!name) {
      inputRef.current?.focus();
      return;
    }
    const ok = await onSaveTheme(name);
    if (ok) {
      setThemeEditorOpen(false);
      setThemeName('');
    }
  };

  return (
    <div className="flex w-full min-w-0 flex-wrap items-center gap-1.5 sm:justify-end sm:gap-2">
      <span
        className={`inline-flex max-w-full items-center gap-1.5 truncate rounded-full px-2 py-1 text-xs font-medium sm:px-2.5 ${status.tone}`}
        title={status.label}
      >
        {status.icon}
        <span className="sm:hidden">{status.short}</span>
        <span className="hidden sm:inline">{status.label}</span>
      </span>

      {onSaveTheme &&
        (themeEditorOpen ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:flex-initial sm:max-w-md">
            <input
              ref={inputRef}
              value={themeName}
              onChange={(e) => setThemeName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void submitTheme();
                }
                if (e.key === 'Escape') {
                  setThemeEditorOpen(false);
                  setThemeName('');
                }
              }}
              placeholder="Theme name"
              disabled={savingTheme}
              className="h-9 min-w-0 flex-1 rounded-lg border border-violet-300 bg-white px-2.5 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-violet-200 sm:w-44"
            />
            <button
              type="button"
              onClick={() => void submitTheme()}
              disabled={savingTheme || !themeName.trim()}
              className={`${btnBase} border border-violet-600 bg-violet-600 font-semibold text-white hover:bg-violet-700 disabled:opacity-40`}
            >
              {savingTheme ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
              <span>Save</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setThemeEditorOpen(false);
                setThemeName('');
              }}
              disabled={savingTheme}
              className={`${btnBase} border border-slate-200 bg-white text-slate-600 hover:bg-slate-50`}
            >
              <X size={15} />
              <span className="hidden sm:inline">Close</span>
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setThemeName('My theme');
              setThemeEditorOpen(true);
            }}
            title="Save current style as a reusable theme"
            className={`${btnBase} border border-violet-200 bg-violet-50 font-semibold text-violet-700 hover:border-violet-300 hover:bg-violet-100`}
          >
            <Palette size={15} className="shrink-0" />
            <span>Save theme</span>
          </button>
        ))}

      <button
        type="button"
        onClick={onReset}
        disabled={!dirty || saving}
        title="Reset unsaved changes"
        className={`${btnBase} border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40`}
      >
        <RotateCcw size={15} className="shrink-0" />
        <span className="hidden sm:inline">Reset</span>
      </button>

      <button
        type="button"
        onClick={onPreview}
        title="Open fullscreen PDF preview"
        className={`${btnBase} border border-slate-200 bg-white text-slate-700 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700`}
      >
        {previewing ? (
          <Loader2 size={15} className="shrink-0 animate-spin" />
        ) : (
          <Eye size={15} className="shrink-0" />
        )}
        <span className="hidden md:inline">Fullscreen</span>
        <span className="md:hidden">View</span>
      </button>
    </div>
  );
}
