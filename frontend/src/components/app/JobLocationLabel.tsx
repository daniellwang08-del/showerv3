import { cn } from '@/lib/utils';
import { countryFlag, locationCountriesFor } from '@/utils/jobLocation';

export function JobLocationLabel({
  location,
  countries,
  className,
}: {
  location: string | null | undefined;
  countries?: string[] | null;
  className?: string;
}) {
  const text = (location ?? '').trim();
  if (!text) return <span className={cn('text-muted-foreground', className)}>-</span>;
  const codes = locationCountriesFor(text, countries);
  const flags = codes.map(countryFlag).filter(Boolean).join('');
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)} title={text}>
      {flags ? (
        <span className="shrink-0 text-[0.95rem] leading-none" aria-hidden>
          {flags}
        </span>
      ) : null}
      <span className="truncate">{text}</span>
    </span>
  );
}
