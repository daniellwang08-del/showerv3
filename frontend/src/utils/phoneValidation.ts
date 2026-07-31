/** Shared phone validation for profile forms (national number, country code separate). */

export function phoneDigitCount(value: string): number {
  return (value || '').replace(/\D/g, '').length;
}

export function isUsCountryCode(countryCode: string): boolean {
  return (countryCode || '').replace(/\D/g, '') === '1';
}

/**
 * Validate the national phone field.
 * US/Canada (+1): exactly 10 digits. Other countries: 8–15 digits.
 */
export function validatePhoneNumber(number: string, countryCode: string = '+1'): boolean {
  const raw = (number || '').trim();
  if (!raw) return false;
  if (!/^[\d\s\-+()]{7,30}$/.test(raw)) return false;
  const digits = phoneDigitCount(raw);
  if (isUsCountryCode(countryCode)) {
    return digits === 10;
  }
  return digits >= 8 && digits <= 15;
}

export function phoneValidationMessage(number: string, countryCode: string = '+1'): string {
  if (!number.trim()) return 'Phone number is required';
  if (isUsCountryCode(countryCode)) {
    return 'US/Canada numbers need 10 digits (area code + number), e.g. (610) 234-7936';
  }
  return 'Use 8–15 digits (spaces, +, -, () allowed)';
}
