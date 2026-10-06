import type { ApplicationResumeSource } from '@/types/settings';

export const RESUME_SOURCE_OPTIONS: { value: ApplicationResumeSource; label: string; hint: string }[] = [
  {
    value: 'tailored',
    label: 'Tailored resume per job',
    hint: 'After scoring, NAO rewrites your resume and cover letter for the job. The extension uploads and fills from that version.',
  },
  {
    value: 'original',
    label: 'My original resume',
    hint: 'NAO only scores and ranks jobs. The extension uploads your resume as it is and fills every application from it.',
  },
];
