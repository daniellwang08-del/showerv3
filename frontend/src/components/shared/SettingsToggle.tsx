/**
 * Compact enable/disable switch for System Settings and similar admin UIs.
 * Explicit light/dark colors so the track and thumb stay visible in dark mode.
 */
export function SettingsToggle({
  checked,
  onChange,
  disabled = false,
  'aria-label': ariaLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50 disabled:cursor-not-allowed disabled:opacity-50 ${
        checked
          ? 'border-sky-500/40 bg-sky-600 dark:border-sky-400/40 dark:bg-sky-500'
          : 'border-slate-300 bg-slate-300 dark:border-slate-500 dark:bg-slate-600'
      }`}
    >
      <span
        aria-hidden
        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-md ring-0 transition-transform duration-200 ${
          checked ? 'translate-x-[1.625rem]' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}
