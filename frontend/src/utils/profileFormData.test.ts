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

  it('does not promote derived project_intro / contributions that exceed PUT limits', () => {
    const longDesc = `${'A'.repeat(2400)} • one • two • ${Array.from({ length: 45 }, (_, i) => `b${i}`).join(' • ')}`;
    const form = profileToForm({
      ...completeProfile,
      work_experience: [
        {
          company_name: 'Acme',
          job_title: 'Eng',
          description: longDesc,
          contributions: [],
          project_title: '',
          project_intro: '',
        },
      ],
    });
    const role = form.work_experience[0];
    // Oversized derived fields must stay out of the form so Preferences / Profile
    // saves do not 422 on work_experience.project_intro / contributions.
    expect(role.project_intro.length).toBeLessThanOrEqual(2000);
    expect(role.contributions.filter((c) => c.trim()).length).toBeLessThanOrEqual(40);
    // Full text remains available via description for resume derivation.
    expect(role.description.length).toBeGreaterThan(2000);
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
