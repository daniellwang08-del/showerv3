import type { ApplicationResumeSource } from '@/types/settings';

export const RESUME_SOURCE_OPTIONS: { value: ApplicationResumeSource; label: string; hint: string }[] = [
  {
    value: 'tailored',
    label: 'Tailored resume per job',
    hint: 'After scoring, NAO rewrites your resume and writes a cover letter for the job. The extension uploads and fills from that version.',
  },
  {
    value: 'original',
    label: 'My original resume',
    hint: 'NAO writes only a cover letter for each job. The extension uploads the resume file you imported, unchanged, and fills applications from it.',
  },
];
