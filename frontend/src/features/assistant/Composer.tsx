import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowUp, Link2, Loader2, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { extractHttpUrlsFromText } from '@/utils/extractHttpUrls';
import type { PromptBlock } from './promptBlocks';

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
  /** Task pinned to this message (shown as a chip, removable). */
  block?: PromptBlock | null;
  onClearBlock?: () => void;
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
  urlActionLabel: urlActionLabelProp,
  block,
  onClearBlock,
  className,
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const urlActionLabel = block ? undefined : urlActionLabelProp;
  const urlCount = urlActionLabel ? extractHttpUrlsFromText(value).length : 0;
  const length = value.trim().length;
  const tooShort = !!block && length < block.minChars;
  const canSend = length > 0 && !tooShort && !busy && !disabled;
  const maxHeight = size === 'lg' ? 280 : 200;

  useLayoutEffect(() => {
    if (block) ref.current?.focus();
  }, [block]);

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
      return;
    }
    if (e.key === 'Backspace' && block && !value && onClearBlock) {
      e.preventDefault();
      onClearBlock();
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
      {block ? (
        <div className={cn('flex items-center gap-2 px-4', size === 'lg' ? 'pt-4' : 'pt-3')}>
          <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-brand-soft py-1 pr-1 pl-2.5 text-xs font-medium text-brand">
            <block.icon className="size-3.5 shrink-0" />
            <span className="truncate">{block.label}</span>
            {onClearBlock ? (
              <button
                type="button"
                onClick={onClearBlock}
                className="inline-flex size-4 items-center justify-center rounded-full hover:bg-brand/15"
                aria-label={`Remove ${block.label}`}
              >
                <X className="size-3" />
              </button>
            ) : null}
          </span>
        </div>
      ) : null}
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={block?.placeholder ?? placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        rows={1}
        aria-label={block?.placeholder ?? placeholder}
        className={cn(
          'scrollbar-thin w-full resize-none bg-transparent px-5 text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60',
          size === 'lg' ? 'text-base' : 'text-sm',
          block ? 'min-h-24 pt-2' : size === 'lg' ? 'min-h-16 pt-5' : 'min-h-12 pt-3.5',
        )}
      />
      <div className="flex items-center gap-2 px-3 pt-1 pb-3">
        <div className="flex min-w-0 flex-1 items-center gap-1">{tools}</div>
        {block && length > 0 && tooShort ? (
          <span className="text-xs text-muted-foreground">Paste the full posting to continue</span>
        ) : null}
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
