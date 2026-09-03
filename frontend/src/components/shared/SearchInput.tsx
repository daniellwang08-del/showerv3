import { useRef, useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { input, inputSolid, mutedText } from '../../ui/tokens';

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  debounceMs?: number;
  /** Leading icon; defaults to a magnifying glass. */
  icon?: LucideIcon;
  /** Extra classes for the wrapping element (e.g. width). */
  className?: string;
  /**
   * Visual treatment:
   * - `default`: light, low-emphasis input (used inside dense panels).
   * - `solid`: taller, higher-contrast input for prominent toolbars/filters.
   */
  variant?: 'default' | 'solid';
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search...',
  debounceMs = 300,
  icon: Icon = Search,
  className = '',
  variant = 'default',
}: SearchInputProps) {
  const [local, setLocal] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    setLocal(value);
  }, [value]);

  const handleChange = (v: string) => {
    setLocal(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onChange(v), debounceMs);
  };

  const solid = variant === 'solid';

  return (
    <div className={`relative ${className}`}>
      <Icon
        size={16}
        className={`pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 transition-colors ${mutedText}`}
      />
      <input
        type="text"
        value={local}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={placeholder}
        className={solid ? inputSolid : `${input} pl-9 pr-8`}
      />
      {local && (
        <button
          type="button"
          onClick={() => handleChange('')}
          aria-label="Clear"
          className={`absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1 hover:bg-slate-100 dark:hover:bg-white/10 ${mutedText}`}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
