/** Country flags and ISO codes from a free-form job location string. */

const COUNTRY_PHRASES: Array<[string, string]> = [
  ['united states of america', 'US'],
  ['united states', 'US'],
  ['u.s.a.', 'US'],
  ['u.s.a', 'US'],
  ['usa', 'US'],
  ['u.s.', 'US'],
  ['united kingdom', 'GB'],
  ['great britain', 'GB'],
  ['northern ireland', 'GB'],
  ['united arab emirates', 'AE'],
  ['south korea', 'KR'],
  ['hong kong', 'HK'],
  ['new zealand', 'NZ'],
  ['south africa', 'ZA'],
  ['saudi arabia', 'SA'],
  ['czech republic', 'CZ'],
  ['canada', 'CA'],
  ['mexico', 'MX'],
  ['england', 'GB'],
  ['scotland', 'GB'],
  ['wales', 'GB'],
  ['ireland', 'IE'],
  ['france', 'FR'],
  ['germany', 'DE'],
  ['netherlands', 'NL'],
  ['holland', 'NL'],
  ['belgium', 'BE'],
  ['switzerland', 'CH'],
  ['austria', 'AT'],
  ['spain', 'ES'],
  ['portugal', 'PT'],
  ['italy', 'IT'],
  ['sweden', 'SE'],
  ['norway', 'NO'],
  ['denmark', 'DK'],
  ['finland', 'FI'],
  ['poland', 'PL'],
  ['india', 'IN'],
  ['singapore', 'SG'],
  ['australia', 'AU'],
  ['japan', 'JP'],
  ['china', 'CN'],
  ['israel', 'IL'],
  ['brazil', 'BR'],
  ['uk', 'GB'],
  ['u.k.', 'GB'],
  ['uae', 'AE'],
];

const US_STATE_ABBREVS = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN',
  'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV',
  'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN',
  'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC', 'PR',
]);

const SUBDIVISION: Record<string, string> = {
  ontario: 'CA', quebec: 'CA', 'british columbia': 'CA', alberta: 'CA',
  manitoba: 'CA', saskatchewan: 'CA', 'nova scotia': 'CA', on: 'CA', qc: 'CA',
  bc: 'CA', ab: 'CA', 'new south wales': 'AU', queensland: 'AU', nsw: 'AU',
  qld: 'AU', vic: 'AU', 'greater london': 'GB', karnataka: 'IN',
  maharashtra: 'IN', telangana: 'IN', bavaria: 'DE', bayern: 'DE',
};

const CITIES: Array<[string, string]> = [
  ['new york city', 'US'], ['san francisco', 'US'], ['sf bay area', 'US'],
  ['silicon valley', 'US'], ['los angeles', 'US'], ['washington dc', 'US'],
  ['washington d.c.', 'US'], ['salt lake city', 'US'], ['new york', 'US'],
  ['mountain view', 'US'], ['palo alto', 'US'], ['san jose', 'US'],
  ['san diego', 'US'], ['seattle', 'US'], ['austin', 'US'], ['boston', 'US'],
  ['chicago', 'US'], ['denver', 'US'], ['atlanta', 'US'], ['miami', 'US'],
  ['dallas', 'US'], ['houston', 'US'], ['phoenix', 'US'], ['nyc', 'US'],
  ['toronto', 'CA'], ['vancouver', 'CA'], ['montreal', 'CA'], ['ottawa', 'CA'],
  ['calgary', 'CA'], ['london', 'GB'], ['edinburgh', 'GB'], ['dublin', 'IE'],
  ['berlin', 'DE'], ['munich', 'DE'], ['hamburg', 'DE'], ['frankfurt', 'DE'],
  ['amsterdam', 'NL'], ['paris', 'FR'], ['madrid', 'ES'], ['barcelona', 'ES'],
  ['lisbon', 'PT'], ['milan', 'IT'], ['stockholm', 'SE'], ['oslo', 'NO'],
  ['copenhagen', 'DK'], ['helsinki', 'FI'], ['vienna', 'AT'], ['zurich', 'CH'],
  ['geneva', 'CH'], ['brussels', 'BE'], ['warsaw', 'PL'], ['prague', 'CZ'],
  ['dubai', 'AE'], ['tel aviv', 'IL'], ['singapore', 'SG'], ['tokyo', 'JP'],
  ['seoul', 'KR'], ['sydney', 'AU'], ['melbourne', 'AU'], ['auckland', 'NZ'],
  ['hong kong', 'HK'], ['bangalore', 'IN'], ['bengaluru', 'IN'], ['mumbai', 'IN'],
  ['hyderabad', 'IN'], ['delhi', 'IN'], ['pune', 'IN'], ['chennai', 'IN'],
  ['mexico city', 'MX'], ['são paulo', 'BR'], ['sao paulo', 'BR'],
  ['buenos aires', 'AR'],
];

const PLACEHOLDER = new Set([
  '', 'unknown', 'n/a', 'na', 'none', 'null', 'not specified', 'tbd', 'remote',
  'hybrid', 'on-site', 'onsite', 'office', 'various', 'multiple locations',
  'worldwide', 'global', 'anywhere', 'flexible',
]);

function normalize(text: string | null | undefined): string {
  return (text ?? '')
    .trim()
    .toLowerCase()
    .replace(/\u2013|\u2014/g, '-')
    .replace(/\s+/g, ' ');
}

function hasWord(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i').test(text);
}

function splitSegments(text: string): string[] {
  return text.split(/\s*(?:\||\/|;|\u2022|\n|·)\s*/).filter(Boolean);
}

/** Regional-indicator emoji for an ISO 3166-1 alpha-2 code. */
export function countryFlag(code: string): string {
  const cc = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(
    ...[...cc].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65),
  );
}

export function parseLocationCountries(location: string | null | undefined): string[] {
  const normalized = normalize(location);
  if (!normalized || PLACEHOLDER.has(normalized)) return [];
  const codes = new Set<string>();
  for (const segment of splitSegments(normalized)) {
    for (const [phrase, code] of COUNTRY_PHRASES) {
      if (hasWord(segment, phrase)) codes.add(code);
    }
    if (hasWord(segment, 'us') && !hasWord(segment, 'focus')) codes.add('US');

    const comma = segment.match(/^(.+?),\s*(.+)$/);
    const cityHits: string[] = [];
    for (const [city, code] of CITIES) {
      if (hasWord(segment, city)) cityHits.push(code);
    }
    if (comma) {
      const region = comma[2].trim();
      const regionUp = region.toUpperCase();
      if (US_STATE_ABBREVS.has(regionUp)) {
        const foreign = cityHits.filter((c) => c !== 'US');
        if (foreign.includes(regionUp)) {
          codes.add(regionUp);
          continue;
        }
        codes.add('US');
        continue;
      }
      const sub = SUBDIVISION[region] ?? SUBDIVISION[region.toLowerCase()];
      if (sub) {
        codes.add(sub);
        continue;
      }
      if (/^[a-z]{2}$/.test(region)) {
        codes.add(region.toUpperCase());
        continue;
      }
    }
    for (const code of cityHits) codes.add(code);
  }
  return [...codes].sort();
}

export function locationCountriesFor(
  location: string | null | undefined,
  apiCountries?: string[] | null,
): string[] {
  if (apiCountries && apiCountries.length) {
    return apiCountries.map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
  }
  return parseLocationCountries(location);
}
