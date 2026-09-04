import type { UserProfile } from '../types/profile';
import type { ProfileFormData } from '../types/profile';

export const completeProfile: UserProfile = {
  user_id: 'user-1',
  name: 'Jane Doe',
  name_first: 'Jane',
  name_middle: '',
  name_last: 'Doe',
  title: 'Staff Engineer',
  email: 'jane@example.com',
  phone_country_code: '+1',
  phone_number: '6102347936',
  linkedin_url: 'https://www.linkedin.com/in/jane-doe',
  github_url: 'https://github.com/janedoe',
  profile_summary: 'Staff engineer building distributed systems.',
  technical_skills: [{ category: 'Languages', skills: 'Python, TypeScript' }],
  work_experience: [
    {
      company_name: 'Acme',
      job_title: 'Staff Engineer',
      period_start: '2021-01',
      period_end: 'Present',
      location: 'Remote',
      job_type: 'remote',
      employment_type: 'full-time',
      project_title: 'Platform',
      project_intro: 'Core platform work',
      contributions: ['Led backend rewrite'],
      used_skills: 'Python',
      description: '',
    },
  ],
  education: [
    {
      university_name: 'MIT',
      degree: 'B.S. Computer Science',
      period_start: '2012-09',
      period_end: '2016-06',
      location: 'Cambridge, MA',
    },
  ],
  certificates: [{ name: 'AWS SAP', issued_at: '2023-01', url: 'https://example.com/cert' }],
  extra: ['Open source contributor'],
  eeo_preferences: {},
  address: { country: 'United States of America', local_preferences: [] },
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-06-01T00:00:00Z',
};

export const emptyProfile: UserProfile = {
  user_id: 'user-1',
  name: '',
  name_first: null,
  name_middle: null,
  name_last: null,
  title: null,
  email: null,
  phone_country_code: null,
  phone_number: null,
  linkedin_url: null,
  github_url: null,
  profile_summary: null,
  technical_skills: [],
  work_experience: [],
  education: [],
  certificates: [],
  extra: [],
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

export function completeForm(overrides: Partial<ProfileFormData> = {}): ProfileFormData {
  return {
    name_first: 'Jane',
    name_middle: '',
    name_last: 'Doe',
    title: 'Staff Engineer',
    email: 'jane@example.com',
    phone_country_code: '+1',
    phone_number: '6102347936',
    linkedin_url: 'https://www.linkedin.com/in/jane-doe',
    github_url: '',
    profile_summary: 'Staff engineer building distributed systems.',
    technical_skills: [{ category: 'Languages', skills: 'Python' }],
    work_experience: [
      {
        company_name: 'Acme',
        job_title: 'Staff Engineer',
        period_start: '2021-01',
        period_end: '',
        location: 'Remote',
        job_type: 'remote',
        employment_type: 'full-time',
        project_title: '',
        project_intro: '',
        contributions: [''],
        used_skills: '',
        description: '',
      },
    ],
    education: [
      {
        university_name: 'MIT',
        degree: 'B.S. Computer Science',
        mark: '',
        period_start: '',
        period_end: '',
        location: '',
        description: '',
      },
    ],
    certificates: [{ name: '', issued_at: '', url: '' }],
    extra: [''],
    eeo_preferences: {
      gender: '',
      race: '',
      sexual_orientation: '',
      hispanic_latino: null,
      veteran_status: null,
      disability_status: null,
      work_authorized: null,
      needs_sponsorship: null,
    },
    address: {
      line1: '',
      line2: '',
      city: '',
      state: '',
      postal_code: '',
      country: 'United States of America',
      local_preferences: [],
    },
    ...overrides,
  };
}

export function axiosError(status: number, detail: unknown) {
  return {
    isAxiosError: true,
    response: { status, data: { detail } },
    message: 'Request failed',
  };
}
