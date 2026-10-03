import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Cloud, Eye, Loader2, Palette, RotateCcw, X } from 'lucide-react';

export function Toolbar({
  dirty,
  saving,
  previewing = false,
  ready,
  savingTheme = false,
  compact = false,
  onReset,
  onPreview,
  onSaveTheme,
}: {
  dirty: boolean;
  saving: boolean;
  previewing?: boolean;
  ready: boolean;
  savingTheme?: boolean;
  /** Short labels until the xl breakpoint (dense headers). */
  compact?: boolean;
  onReset: () => void;
  onPreview?: () => void;
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
        tone: 'bg-brand-soft text-brand',
        icon: <Loader2 size={13} className="animate-spin" />,
        label: 'Saving…',
        short: 'Saving',
      }
    : dirty
      ? {
          tone: 'bg-status-preparing/10 text-status-preparing',
          icon: <Cloud size={13} />,
          label: 'Unsaved changes',
          short: 'Unsaved',
        }
      : ready
        ? {
            tone: 'bg-status-ready/10 text-status-ready',
            icon: <Check size={13} />,
            label: 'All changes saved',
            short: 'Saved',
          }
        : {
            tone: 'bg-muted text-muted-foreground',
            icon: <Cloud size={13} />,
            label: 'Saved',
            short: 'Saved',
          };

  const btnBase =
    'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-2.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-3';
  const btnOutline = `${btnBase} border bg-background text-foreground hover:bg-muted`;

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
    <div className={`flex min-w-0 flex-wrap items-center gap-1.5 sm:justify-end sm:gap-2 ${compact ? '' : 'w-full'}`}>
      <span
        className={`inline-flex max-w-full items-center gap-1.5 truncate rounded-full px-2 py-1 text-xs font-medium sm:px-2.5 ${status.tone}`}
        title={status.label}
      >
        {status.icon}
        <span className={compact ? 'xl:hidden' : 'sm:hidden'}>{status.short}</span>
        <span className={compact ? 'hidden xl:inline' : 'hidden sm:inline'}>{status.label}</span>
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
              className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-background px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/30 sm:w-44"
            />
            <button
              type="button"
              onClick={() => void submitTheme()}
              disabled={savingTheme || !themeName.trim()}
              className={`${btnBase} bg-brand font-semibold text-brand-foreground hover:bg-brand/90 disabled:opacity-40`}
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
              className={btnOutline}
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
            className={`${btnBase} border border-brand/30 bg-brand-soft font-semibold text-brand hover:border-brand/50`}
          >
            <Palette size={15} className="shrink-0" />
            <span className={compact ? 'hidden xl:inline' : undefined}>Save theme</span>
          </button>
        ))}

      <button
        type="button"
        onClick={onReset}
        disabled={!dirty || saving}
        title="Reset unsaved changes"
        className={`${btnOutline} disabled:opacity-40`}
      >
        <RotateCcw size={15} className="shrink-0" />
        <span className={compact ? 'hidden xl:inline' : 'hidden sm:inline'}>Reset</span>
      </button>

      {onPreview && (
      <button
        type="button"
        onClick={onPreview}
        title="Open fullscreen PDF preview"
        className={`${btnOutline} hover:border-brand/40 hover:text-brand`}
      >
        {previewing ? (
          <Loader2 size={15} className="shrink-0 animate-spin" />
        ) : (
          <Eye size={15} className="shrink-0" />
        )}
        <span className="hidden md:inline">Fullscreen</span>
        <span className="md:hidden">View</span>
      </button>
      )}
    </div>
  );
}
