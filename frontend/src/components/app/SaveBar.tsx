import { useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';

/**
 * Floating bar shown while a form has unsaved changes. Ctrl/⌘+S saves and the
 * browser warns before unloading the page.
 */
export function SaveBar({
  dirty,
  saving,
  onSave,
  onDiscard,
  message = 'You have unsaved changes',
  saveLabel = 'Save changes',
  disabled,
}: {
  dirty: boolean;
  saving?: boolean;
  onSave: () => void;
  onDiscard: () => void;
  message?: string;
  saveLabel?: string;
  disabled?: boolean;
}) {
  useEffect(() => {
    if (!dirty) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!saving && !disabled) onSave();
      }
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [dirty, saving, disabled, onSave]);

  if (!dirty) return null;
  return (
    <div className="pointer-events-none sticky bottom-4 z-20 mt-6 flex justify-center">
      <div
        role="region"
        aria-label="Unsaved changes"
        className="pointer-events-auto flex items-center gap-3 rounded-xl border bg-popover py-2 pr-2 pl-4 text-sm shadow-lg ring-1 ring-foreground/5 animate-in fade-in-0 slide-in-from-bottom-2"
      >
        <span className="text-muted-foreground">{message}</span>
        <Button variant="ghost" size="sm" onClick={onDiscard} disabled={saving}>
          Discard
        </Button>
        <Button size="sm" onClick={onSave} disabled={saving || disabled}>
          {saving ? <Loader2 className="animate-spin" /> : null}
          {saveLabel}
          <Kbd className="max-sm:hidden">⌘S</Kbd>
        </Button>
      </div>
    </div>
  );
}
