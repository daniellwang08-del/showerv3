import { describe, expect, it } from 'vitest';
import { profileToForm } from './profileFormData';
import { profileFormToPayload } from './profilePayload';
import type { UserProfile } from '../types/profile';

const profile = {
  user_id: 'u1',
  name: 'Ada Lovelace',
  name_first: 'Ada',
  name_last: 'Lovelace',
  title: 'Engineer',
  email: 'ada@example.com',
  phone_country_code: '+44',
  phone_number: '7700900123',
  linkedin_url: '',
  github_url: '',
  profile_summary: 'Math and machines.',
  technical_skills: [],
  work_experience: [],
  education: [
    {
      university_name: 'Oxford',
      degree: 'BA, History',
      field_of_study: 'History',
      period_start: '2014',
      period_end: '2017',
    },
  ],
  certificates: [],
  extra: [],
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
} as UserProfile;

describe('profile education field_of_study', () => {
  it('round-trips a parsed major through form save', () => {
    const form = profileToForm(profile);
    expect(form.education[0].field_of_study).toBe('History');
    const payload = profileFormToPayload(form);
    expect(payload.education[0].field_of_study).toBe('History');
  });
});
