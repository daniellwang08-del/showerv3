import { describe, expect, it } from 'vitest';
import { effectiveProfile, profileToContent, seedHeaderLocation } from './resumeContent';
import type { UserProfile } from '../types/profile';

const profile = {
  user_id: 'u1',
  name: 'Ada Lovelace',
  name_first: 'Ada',
  name_last: 'Lovelace',
  email: 'ada@example.com',
  phone_country_code: '+353',
  phone_number: '861234567',
  address: { city: 'Dublin', country: 'Ireland' },
  technical_skills: [],
  work_experience: [{ company_name: 'NAO', job_title: 'Engineer', location: 'London, UK' }],
  education: [{ university_name: 'Trinity', location: 'Dublin' }],
  certificates: [],
  extra: [],
  created_at: '',
  updated_at: '',
} as UserProfile;

describe('resume content location overlay', () => {
  it('seeds header location from the profile address', () => {
    const content = profileToContent(profile);
    expect(content.location).toBe('Dublin, Ireland');
    expect(content.work_experience[0]?.location).toBe('London, UK');
    expect(content.education[0]?.location).toBe('Dublin');
  });

  it('fills a blank editor location from the profile address', () => {
    const content = profileToContent(profile);
    content.location = '';
    expect(seedHeaderLocation(content, profile).location).toBe('Dublin, Ireland');
  });

  it('lets Content location override the preview address', () => {
    const content = profileToContent(profile);
    content.location = 'Berlin, Germany';
    const next = effectiveProfile(profile, content);
    expect(next?.address).toMatchObject({ city: 'Berlin', country: 'Germany' });
  });
});
