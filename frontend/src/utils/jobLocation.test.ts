import { describe, expect, it } from 'vitest';
import { countryFlag, parseLocationCountries } from './jobLocation';

describe('parseLocationCountries', () => {
  it('resolves city-only and city-country strings', () => {
    expect(parseLocationCountries('London')).toEqual(['GB']);
    expect(parseLocationCountries('Berlin, Germany')).toEqual(['DE']);
    expect(parseLocationCountries('San Francisco, CA')).toEqual(['US']);
    expect(parseLocationCountries('Toronto')).toEqual(['CA']);
    expect(parseLocationCountries('Remote, United States')).toEqual(['US']);
  });

  it('keeps US state form over a city default (Paris, TX)', () => {
    expect(parseLocationCountries('Paris, TX')).toEqual(['US']);
    expect(parseLocationCountries('Berlin, DE')).toEqual(['DE']);
  });

  it('resolves Canadian subdivisions', () => {
    expect(parseLocationCountries('London, ON')).toEqual(['CA']);
  });

  it('returns no codes for placeholders', () => {
    expect(parseLocationCountries('Remote')).toEqual([]);
    expect(parseLocationCountries('')).toEqual([]);
  });
});

describe('countryFlag', () => {
  it('builds regional-indicator flags', () => {
    expect(countryFlag('US')).toBe('\u{1F1FA}\u{1F1F8}');
    expect(countryFlag('GB')).toBe('\u{1F1EC}\u{1F1E7}');
    expect(countryFlag('USA')).toBe('');
  });
});
