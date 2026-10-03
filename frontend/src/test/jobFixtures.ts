import type { DashboardJob } from '../types/scraper';

let seq = 0;

export function makeJob(overrides: Partial<DashboardJob> = {}): DashboardJob {
  seq += 1;
  const id = overrides.id ?? `job-${seq}`;
  return {
    id,
    source_url: `https://jobs.example.com/${id}`,
    normalized_url: `https://jobs.example.com/${id}`,
    domain: 'jobs.example.com',
    title: `Engineer ${seq}`,
    company: `Company ${seq}`,
    location: 'Remote, US',
    description: null,
    posted_date: null,
    experience_level: null,
    industry: null,
    status: 'active',
    created_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
    updated_at: new Date().toISOString(),
    extraction_id: 'ext-1',
    extraction_status: 'extracted',
    is_job_posting: true,
    match_overall_score: null,
    match_in_progress: false,
    resume_build_status: null,
    content_generation_status: null,
    resume_build_id: null,
    resume_pdf_status: null,
    resume_pdf_path: null,
    cover_letter_pdf_status: null,
    cover_letter_pdf_path: null,
    applied_at: null,
    applied_by_name: null,
    sheet_posted_at: null,
    pumble_posted_at: null,
    user_status: null,
    source: 'greenhouse',
    is_remote: true,
    work_mode: 'remote',
    salary_raw: null,
    job_type: null,
    ...overrides,
  };
}

export function readyJob(overrides: Partial<DashboardJob> = {}): DashboardJob {
  return makeJob({
    match_overall_score: 86,
    content_generation_status: 'completed',
    resume_build_status: 'completed',
    resume_pdf_status: 'completed',
    resume_pdf_path: '/r.pdf',
    cover_letter_pdf_status: 'completed',
    cover_letter_pdf_path: '/c.pdf',
    ...overrides,
  });
}
