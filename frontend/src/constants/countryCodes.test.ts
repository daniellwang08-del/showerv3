import { describe, expect, it } from 'vitest';
import { COUNTRY_CODES, countryCodesForValue } from './countryCodes';

describe('country dial codes', () => {
  it('includes common international prefixes', () => {
    const codes = COUNTRY_CODES.map((c) => c.code);
    for (const code of ['+1', '+44', '+49', '+353', '+91', '+61', '+81']) {
      expect(codes).toContain(code);
    }
  });

  it('keeps an unknown parsed code visible', () => {
    const list = countryCodesForValue('+999');
    expect(list[0]).toEqual({ code: '+999', country: 'Other' });
  });
});
