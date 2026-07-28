import type { ReactNode } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Loader2 } from 'lucide-react';

export type MenuSelectOption = {
  value: string;
  label: string;
  /** Optional secondary line under the label. */
  description?: string;
  /** Optional leading icon (e.g. provider brand glyph). */
  icon?: ReactNode;
};

type MenuSelectProps = {
  value: string;
  options: MenuSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  loading?: boolean;
  placeholder?: string;
  /** Accessible name for the control. */
  'aria-label'?: string;
  className?: string;
  /** Minimum menu width in px (defaults to trigger width, at least 240). */
  minMenuWidth?: number;
  /** When true, option labels wrap instead of truncating (useful for long model ids). */
  wrapLabels?: boolean;
  /**
   * Optional identity line drawn above the selected value in the closed trigger
   * (e.g. job binding name: "Job analysis (Phase A)").
   */
  leadingLabel?: string;
};

const MENU_Z = 200;

/**
 * Custom select that paints its own menu (portal). Avoids native <option>
 * dark-mode contrast bugs on Windows/Chromium where options inherit muted
 * ancestor text colors and become unreadable.
 */
export function MenuSelect({
  value,
  options,
  onChange,
  disabled = false,
  loading = false,
  placeholder = 'Select…',
  'aria-label': ariaLabel,
  className = '',
  minMenuWidth = 260,
  wrapLabels = false,
  leadingLabel,
}: MenuSelectProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  const selected = options.find((o) => o.value === value);
  const display = selected?.label || placeholder;

  const updateMenuPos = () => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = Math.max(rect.width, minMenuWidth);
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const openUp = spaceBelow < 200 && spaceAbove > spaceBelow;
    const maxHeight = Math.min(360, Math.max(160, openUp ? spaceAbove : spaceBelow));
    const top = openUp ? Math.max(8, rect.top - maxHeight - 4) : rect.bottom + 4;
    setMenuPos({ top, left, width, maxHeight });
  };

  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    updateMenuPos();
  }, [open, minMenuWidth]);

  useEffect(() => {
    if (!open) return;
    const onReposition = () => updateMenuPos();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onPointer = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onPointer);
    return () => {
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onPointer);
    };
  }, [open]);

  const menu =
    open && menuPos
      ? createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-label={ariaLabel}
            className="fixed overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-500/50 dark:bg-[#0b1220]"
            style={{
              zIndex: MENU_Z,
              top: menuPos.top,
              left: menuPos.left,
              width: menuPos.width,
              maxHeight: menuPos.maxHeight,
            }}
          >
            <div className="max-h-[inherit] overflow-y-auto py-1.5">
              {options.length === 0 ? (
                <div className="px-3 py-2.5 text-xs text-slate-600 dark:text-[#94a3b8]">
                  No options available
                </div>
              ) : (
                options.map((opt) => {
                  const active = opt.value === value;
                  return (
                    <button
                      key={opt.value || '__empty__'}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => {
                        onChange(opt.value);
                        setOpen(false);
                      }}
                      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                        active
                          ? 'bg-sky-50 dark:bg-sky-500/25'
                          : 'hover:bg-slate-50 dark:hover:bg-white/10'
                      }`}
                    >
                      {opt.icon ? <span className="shrink-0">{opt.icon}</span> : null}
                      <span className="min-w-0 flex-1">
                        <span
                          className={`block font-mono text-[13px] leading-snug ${
                            wrapLabels ? 'break-all whitespace-normal' : 'truncate'
                          } ${
                            active
                              ? 'font-semibold text-sky-900 dark:text-white'
                              : 'font-medium text-slate-900 dark:text-white'
                          }`}
                        >
                          {opt.label}
                        </span>
                        {opt.description ? (
                          <span
                            className={`mt-0.5 block text-[11px] text-slate-600 dark:text-[#94a3b8] ${
                              wrapLabels ? 'whitespace-normal' : 'truncate'
                            }`}
                          >
                            {opt.description}
                          </span>
                        ) : null}
                      </span>
                      {active ? (
                        <Check size={15} className="shrink-0 text-sky-600 dark:text-sky-300" />
                      ) : (
                        <span className="w-[15px] shrink-0" />
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>,
          document.body,
        )
      : null;

  const triggerTitle = leadingLabel ? `${leadingLabel}: ${display}` : display;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled || loading}
        aria-label={ariaLabel || leadingLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex w-full items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 text-left text-sm text-slate-900 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-200 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-500/40 dark:bg-[#0b1220] dark:text-white dark:focus:border-sky-400 dark:focus:ring-sky-900/40 ${
          leadingLabel ? 'min-h-[3.25rem] py-1.5' : 'h-9'
        } ${className}`.trim()}
      >
        {loading ? (
          <Loader2 size={14} className="shrink-0 animate-spin text-slate-500 dark:text-[#94a3b8]" />
        ) : selected?.icon ? (
          <span className="shrink-0">{selected.icon}</span>
        ) : null}
        <span className="min-w-0 flex-1" title={triggerTitle}>
          {leadingLabel ? (
            <span className="mb-0.5 block truncate text-xs font-semibold leading-tight text-slate-900 dark:text-white">
              {leadingLabel}
            </span>
          ) : null}
          <span
            className={`block font-mono text-[13px] font-medium leading-snug ${
              wrapLabels ? 'truncate sm:overflow-visible sm:whitespace-normal sm:break-all' : 'truncate'
            } ${
              leadingLabel
                ? 'text-slate-600 dark:text-[#cbd5e1]'
                : 'text-slate-900 dark:text-white'
            }`}
          >
            {display}
          </span>
        </span>
        <ChevronDown size={14} className="shrink-0 text-slate-500 dark:text-[#94a3b8]" />
      </button>
      {menu}
    </>
  );
}
