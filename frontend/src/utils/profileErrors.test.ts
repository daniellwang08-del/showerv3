import { describe, expect, it } from 'vitest';
import {
  extractApiErrorMessage,
  friendlyProfileError,
  profileErrorFromUnknown,
} from './profileErrors';
import { axiosError } from '../test/profileFixtures';

describe('extractApiErrorMessage', () => {
  it('returns string FastAPI details', () => {
    expect(extractApiErrorMessage(axiosError(500, 'boom'), 'fallback')).toBe('boom');
  });

  it('formats extra_forbidden validation arrays', () => {
    const err = axiosError(422, [
      { loc: ['body', 'mystery_field'], msg: 'Extra inputs are not permitted', type: 'extra_forbidden' },
    ]);
    expect(extractApiErrorMessage(err, 'fallback')).toContain("Unexpected field 'mystery_field'");
  });

  it('joins field validation messages', () => {
    const err = axiosError(422, [
      { loc: ['body', 'email'], msg: 'Invalid email format', type: 'value_error' },
      { loc: ['body', 'linkedin_url'], msg: 'Invalid LinkedIn URL', type: 'value_error' },
    ]);
    const msg = extractApiErrorMessage(err, 'fallback');
    expect(msg).toContain('email: Invalid email format');
    expect(msg).toContain('linkedin_url: Invalid LinkedIn URL');
  });

  it('maps network failures', () => {
    expect(extractApiErrorMessage({ code: 'ERR_NETWORK' }, 'fallback')).toMatch(/Network error/);
  });
});

describe('friendlyProfileError', () => {
  it('maps invalid API key noise to an actionable sentence', () => {
    const raw =
      "All LLM providers failed. openai: AuthenticationError: Error code: 401 - Incorrect API key provided";
    expect(friendlyProfileError(raw, 'fallback')).toMatch(/invalid or missing API key/i);
  });

  it('maps parse failures', () => {
    expect(friendlyProfileError('Failed to parse extracted profile JSON', 'fallback')).toMatch(
      /Could not parse the extracted résumé/,
    );
  });
});

describe('profileErrorFromUnknown', () => {
  it('uses fallback when the error is empty', () => {
    expect(profileErrorFromUnknown({}, 'Failed to save profile')).toBe('Failed to save profile');
  });
});
