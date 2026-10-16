import { describe, expect, it } from 'vitest';
import type { ResumeContent } from '@/types/resumeDesign';
import { mergeTailoredContent } from './mergeTailoredContent';

const base: ResumeContent = {
  name_first: 'Ada',
  name_middle: '',
  name_last: 'Lovelace',
  title: 'Engineer',
  email: 'ada@example.com',
  phone_country_code: '+1',
  phone_number: '555',
  location: 'London',
  linkedin_url: '',
  github_url: '',
  profile_summary: 'Old summary',
  technical_skills: [{ category: 'Languages', skills: 'Python' }],
  work_experience: [
    {
      company_name: 'Analytical Engines',
      job_title: 'Mathematician',
      period_start: '1840',
      period_end: '1843',
      location: 'London',
      job_type: '',
      employment_type: '',
      project_title: '',
      project_intro: '',
      contributions: ['Wrote notes'],
      used_skills: 'Math',
      description: '',
    },
  ],
  education: [
    {
      university_name: 'Home',
      degree: 'Self-taught',
      mark: '',
      period_start: '',
      period_end: '',
      location: '',
      description: '',
    },
  ],
  certificates: [{ name: 'Honorary', issued_at: '1852', url: '' }],
};

describe('mergeTailoredContent', () => {
  it('replaces summary, skills, and experience while keeping header and education', () => {
    const merged = mergeTailoredContent(base, {
      profile_summary: 'New summary for this role',
      technical_skills: [{ category: 'Core', skills: 'Python, SQL' }],
      work_experience: [
        {
          company_name: 'Analytical Engines',
          job_title: 'Lead Mathematician',
          period_start: '1840',
          period_end: '1843',
          location: 'London',
          job_type: '',
          employment_type: 'Full-time',
          project_title: 'Difference Engine',
          project_intro: 'Advanced computation',
          contributions: ['Published algorithms'],
          used_skills: 'Python',
          description: '',
        },
      ],
    });

    expect(merged.name_first).toBe('Ada');
    expect(merged.education).toEqual(base.education);
    expect(merged.certificates).toEqual(base.certificates);
    expect(merged.profile_summary).toBe('New summary for this role');
    expect(merged.technical_skills).toEqual([{ category: 'Core', skills: 'Python, SQL' }]);
    expect(merged.work_experience[0].job_title).toBe('Lead Mathematician');
    expect(merged.work_experience[0].contributions).toEqual(['Published algorithms']);
  });

  it('keeps base sections when tailored payload is empty', () => {
    const merged = mergeTailoredContent(base, {
      profile_summary: '',
      technical_skills: [],
      work_experience: [],
    });
    expect(merged.profile_summary).toBe('Old summary');
    expect(merged.technical_skills).toEqual(base.technical_skills);
    expect(merged.work_experience).toEqual(base.work_experience);
  });
});
