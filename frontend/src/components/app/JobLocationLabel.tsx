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

/** ISO code at the end of a standard label ("Kent, WA, US" -> "US", "London, UK" -> "GB"). */
export function displayLabelCountry(label: string): string | null {
  const parts = label.split(',');
  if (parts.length < 2) return null;
  const code = parts[parts.length - 1].trim().toUpperCase();
  if (code === 'UK') return 'GB';
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

function Flags({ codes }: { codes: string[] }) {
  const flags = codes.map(countryFlag).filter(Boolean);
  if (!flags.length) return null;
  return (
    <span className="country-flag inline-flex shrink-0 gap-0.5 text-[0.95rem] leading-none" aria-hidden>
      {flags.map((flag, i) => (
        <span key={i}>{flag}</span>
      ))}
    </span>
  );
}

export function JobLocationLabel({
  location,
  display,
  countries,
  inferred,
  className,
}: {
  location: string | null | undefined;
  /** Standard labels from the API ("Kent, WA, US", "All, US"). Preferred over ``location``. */
  display?: string[] | null;
  countries?: string[] | null;
  inferred?: boolean;
  className?: string;
}) {
  if (display?.length) {
    const [first, ...rest] = display;
    const code = displayLabelCountry(first);
    const raw = (location ?? '').trim();
    const lines = [...display];
    if (inferred) lines.push(`No location listed, read as ${countries?.join(', ') || first}`);
    else if (raw && !display.includes(raw)) lines.push(`Posted as: ${raw}`);
    return (
      <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)} title={lines.join('\n')}>
        <Flags codes={code ? [code] : []} />
        <span className="truncate">{first}</span>
        {rest.length ? (
          <span className="shrink-0 rounded bg-muted px-1 text-[0.7rem] font-medium leading-4 text-muted-foreground tabular-nums">
            +{rest.length}
          </span>
        ) : null}
      </span>
    );
  }

  const text = jobLocationText(location, countries, inferred);
  if (!text) return <span className={cn('text-muted-foreground', className)}>-</span>;
  const codes = locationCountriesFor(text, countries);
  const title = inferred ? `${text} (no location listed, read as ${countries?.join(', ')})` : text;
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)} title={title}>
      <Flags codes={codes} />
      <span className="truncate">{text}</span>
    </span>
  );
}
