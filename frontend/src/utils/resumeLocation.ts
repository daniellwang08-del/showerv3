import type { AddressInfo } from '../types/profile';

const US_COUNTRY = /^(united states( of america)?|usa|u\.s\.a?\.?|us)$/i;

function clean(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/** Compact 'City, ST' / 'City, Country' line for the résumé contact row. */
export function formatResumeHeaderLocation(addr: AddressInfo | Record<string, unknown> | null | undefined): string {
  if (!addr || typeof addr !== 'object') return '';
  const city = clean((addr as AddressInfo).city);
  const state = clean((addr as AddressInfo).state);
  const country = clean((addr as AddressInfo).country);
  if (city && state) return `${city}, ${state}`;
  if (city && country && !US_COUNTRY.test(country)) return `${city}, ${country}`;
  if (city) return city;
  if (state && country && !US_COUNTRY.test(country)) return `${state}, ${country}`;
  return state || country;
}

export function parseResumeHeaderLocation(text: string | null | undefined): AddressInfo {
  const raw = clean(text);
  if (!raw) return {};
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return {};
  const last = parts[parts.length - 1] ?? '';
  const postalMatch = last.match(/^(.*?)(?:\s+(\d{5}(?:-\d{4})?|\d{4,6}))$/);
  let postal = '';
  if (postalMatch?.[1]?.trim()) {
    parts[parts.length - 1] = postalMatch[1].trim();
    postal = postalMatch[2] ?? '';
  }
  const out: AddressInfo = {};
  if (parts.length >= 3) {
    out.city = parts[0];
    out.state = parts[1];
    out.country = parts.slice(2).join(', ');
  } else if (parts.length === 2) {
    out.city = parts[0];
    const region = parts[1];
    if (/^[A-Z]{2}$/.test(region) || /united states|usa|u\.s/i.test(region)) {
      out.state = /^[A-Z]{2}$/.test(region) ? region : undefined;
      out.country = 'United States';
    } else {
      out.country = region;
    }
  } else {
    out.city = parts[0];
  }
  if (postal) out.postal_code = postal;
  return out;
}
