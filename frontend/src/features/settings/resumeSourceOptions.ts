import type { ApplicationResumeSource, TailoringStrategy } from '@/types/settings';

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

export const TAILORING_STRATEGY_OPTIONS: { value: TailoringStrategy; label: string; hint: string }[] = [
  {
    value: 'evidence',
    label: 'Stay close to my resume',
    hint: 'Rewrites and reorders your own experience for the job. Skills the resume never mentions stay out, even if the posting requires them. Recommended for interviews you can defend.',
  },
  {
    value: 'job_first',
    label: 'Rebuild around the job',
    hint: 'Keeps your employers, dates and education, then rewrites titles, metrics, ownership and stack so the resume matches the job. Can invent tools under real employers; every listed skill still needs an experience story.',
  },
];
