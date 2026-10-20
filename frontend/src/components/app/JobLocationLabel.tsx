import { cn } from '@/lib/utils';
import { countryFlag, locationCountriesFor } from '@/utils/jobLocation';

/** Location text, with inferred countries appended ("US", "Remote, US"). */
export function jobLocationText(
  location: string | null | undefined,
  countries?: string[] | null,
  inferred?: boolean,
): string {
  const text = (location ?? '').trim();
  if (!inferred || !countries?.length) return text;
  const suffix = countries.join(', ');
  return text ? `${text}, ${suffix}` : suffix;
}

export function JobLocationLabel({
  location,
  countries,
  inferred,
  className,
}: {
  location: string | null | undefined;
  countries?: string[] | null;
  inferred?: boolean;
  className?: string;
}) {
  const text = jobLocationText(location, countries, inferred);
  if (!text) return <span className={cn('text-muted-foreground', className)}>-</span>;
  const codes = locationCountriesFor(text, countries);
  const flags = codes.map(countryFlag).filter(Boolean);
  const title = inferred ? `${text} (no location listed, read as ${countries?.join(', ')})` : text;
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)} title={title}>
      {flags.length ? (
        <span className="country-flag inline-flex shrink-0 gap-0.5 text-[0.95rem] leading-none" aria-hidden>
          {flags.map((flag, i) => (
            <span key={i}>{flag}</span>
          ))}
        </span>
      ) : null}
      <span className="truncate">{text}</span>
    </span>
  );
}
