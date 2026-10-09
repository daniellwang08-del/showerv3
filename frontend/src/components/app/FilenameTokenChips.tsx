import type { RefObject } from 'react';
import { Button } from '@/components/ui/button';

export const FILENAME_TOKENS: { token: string; label: string }[] = [
  { token: '{firstname}', label: 'First name' },
  { token: '{lastname}', label: 'Last name' },
  { token: '{fullname}', label: 'Full name' },
  { token: '{company}', label: 'Company' },
  { token: '{title}', label: 'Job title' },
  { token: '{kind}', label: 'resume / cover_letter' },
  { token: '{date}', label: 'Download date' },
];

/** Insert *token* at the input's caret (or the end), adding a ``_`` separator when needed. */
export function insertFilenameToken(value: string, token: string, input: HTMLInputElement | null): [string, number] {
  const start = input?.selectionStart ?? value.length;
  const end = input?.selectionEnd ?? value.length;
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before && !/[_.\-]$/.test(before) ? '_' : '';
  const next = `${before}${lead}${token}${after}`;
  return [next, before.length + lead.length + token.length];
}

/** Buttons that insert ``{token}`` fields into a file name input. */
export function FilenameTokenChips({
  value,
  onChange,
  inputRef,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Insert a field">
      {FILENAME_TOKENS.map(({ token, label }) => (
        <Button
          key={token}
          type="button"
          size="sm"
          variant="outline"
          className="h-7 px-2 font-mono text-xs"
          title={label}
          disabled={disabled}
          onClick={() => {
            const input = inputRef.current;
            const [next, caret] = insertFilenameToken(value, token, input);
            onChange(next);
            requestAnimationFrame(() => {
              input?.focus();
              input?.setSelectionRange(caret, caret);
            });
          }}
        >
          {token}
        </Button>
      ))}
    </div>
  );
}
