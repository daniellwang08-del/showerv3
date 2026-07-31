/** Shared Save button style for My Preferences: gray when idle, red when there are changes to save. */
export function prefsSaveBtnClass(active: boolean): string {
  const base =
    'inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition disabled:cursor-not-allowed';
  if (active) {
    return `${base} bg-red-600 text-white hover:bg-red-500 disabled:opacity-60`;
  }
  return `${base} bg-slate-200 text-slate-500 dark:bg-white/10 dark:text-slate-400`;
}
