import { describe, expect, it } from 'vitest';
import { profileToForm } from './profileFormData';
import { computeProfileCompletion } from './profileCompletion';
import { validateProfileForSave } from './profileValidation';
import { completeForm, completeProfile } from '../test/profileFixtures';
import type { UserProfile } from '../types/profile';

describe('profileToForm', () => {
  it('maps a complete saved profile', () => {
    const form = profileToForm(completeProfile);
    expect(form.name_first).toBe('Jane');
    expect(form.work_experience[0].company_name).toBe('Acme');
    expect(form.technical_skills[0].skills).toContain('Python');
  });

  it('does not throw on malformed extra / contributions / nested junk', () => {
    const weird = {
      ...completeProfile,
      extra: 'one line\nsecond' as unknown as string[],
      work_experience: [
        {
          company_name: 'Acme',
          job_title: 'Eng',
          contributions: 'led the rewrite' as unknown as string[],
          unexpected_key: true,
        },
      ],
      technical_skills: 'Python, Go' as unknown as UserProfile['technical_skills'],
      education: { university_name: 'MIT' } as unknown as UserProfile['education'],
    };
    const form = profileToForm(weird);
    expect(form.extra).toEqual(['one line', 'second']);
    expect(form.work_experience[0].contributions.join(' ')).toMatch(/led the rewrite/);
    expect(form.technical_skills.length).toBeGreaterThan(0);
    expect(form.education[0].university_name).toBe('');
  });
});

describe('computeProfileCompletion', () => {
  it('scores a complete profile at 100% required', () => {
    const result = computeProfileCompletion(completeProfile);
    expect(result.requiredPercent).toBe(100);
    expect(result.missingRequired).toEqual([]);
  });

  it('lists missing required areas for an empty profile', () => {
    const result = computeProfileCompletion(null);
    expect(result.requiredFilled).toBe(0);
    expect(result.missingRequired.length).toBe(result.requiredTotal);
  });
});

describe('validateProfileForSave', () => {
  it('accepts a complete form', () => {
    expect(validateProfileForSave(completeForm())).toEqual({});
  });

  it('requires core contact fields', () => {
    const errors = validateProfileForSave(completeForm({ name_first: '', email: 'not-an-email' }));
    expect(errors.name_first).toMatch(/required/i);
    expect(errors.email).toMatch(/invalid/i);
  });
});
