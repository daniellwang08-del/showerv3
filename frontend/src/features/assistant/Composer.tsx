import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowUp, Link2, Loader2, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { extractHttpUrlsFromText } from '@/utils/extractHttpUrls';

type ComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  busy?: boolean;
  disabled?: boolean;
  size?: 'md' | 'lg';
  autoFocus?: boolean;
  /** Extra controls rendered in the bottom-left toolbar (attach, mode, …). */
  tools?: ReactNode;
  /** Replaces the send button label when the draft contains job URLs. */
  urlActionLabel?: (count: number) => string;
  className?: string;
};

export function Composer({
  value,
  onChange,
  onSubmit,
  placeholder = 'Ask anything…',
  busy,
  disabled,
  size = 'md',
  autoFocus,
  tools,
  urlActionLabel,
  className,
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const urlCount = urlActionLabel ? extractHttpUrlsFromText(value).length : 0;
  const canSend = value.trim().length > 0 && !busy && !disabled;
  const maxHeight = size === 'lg' ? 280 : 200;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [value, maxHeight]);

  const submit = () => {
    if (canSend) onSubmit(value.trim());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      className={cn(
        'group/composer relative flex w-full flex-col rounded-3xl border bg-card shadow-sm transition-shadow',
        'focus-within:border-ring/60 focus-within:shadow-md focus-within:ring-4 focus-within:ring-ring/10',
        className,
      )}
    >
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        rows={1}
        aria-label={placeholder}
        className={cn(
          'scrollbar-thin w-full resize-none bg-transparent px-5 text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60',
          size === 'lg' ? 'min-h-16 pt-5 text-base' : 'min-h-12 pt-3.5 text-sm',
        )}
      />
      <div className="flex items-center gap-2 px-3 pt-1 pb-3">
        <div className="flex min-w-0 flex-1 items-center gap-1">{tools}</div>
        {urlCount > 0 && urlActionLabel ? (
          <span className="hidden items-center gap-1 rounded-full bg-brand-soft px-2.5 py-1 text-xs font-medium text-brand sm:inline-flex">
            <Link2 className="size-3.5" />
            {urlCount} job URL{urlCount === 1 ? '' : 's'} detected
          </span>
        ) : null}
        <Button
          type="button"
          size={urlCount > 0 && urlActionLabel ? 'default' : 'icon'}
          onClick={submit}
          disabled={!canSend}
          aria-label={urlCount > 0 && urlActionLabel ? urlActionLabel(urlCount) : 'Send'}
          className={cn('rounded-full', urlCount > 0 && urlActionLabel ? 'h-8 px-3.5' : 'size-8')}
        >
          {busy ? (
            value.trim() ? <Loader2 className="animate-spin" /> : <Square className="size-3 fill-current" />
          ) : urlCount > 0 && urlActionLabel ? (
            <>
              {urlActionLabel(urlCount)}
              <ArrowUp />
            </>
          ) : (
            <ArrowUp />
          )}
        </Button>
      </div>
    </div>
  );
}
