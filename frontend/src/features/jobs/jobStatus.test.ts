import { describe, expect, it } from 'vitest';
import { makeJob, readyJob } from '@/test/jobFixtures';
import {
  isApplyReady,
  isDocsBuilding,
  isHiddenRow,
  isInFlight,
  jobStage,
  relativeTime,
  sourceLabel,
  workMode,
} from './jobStatus';

describe('jobStage', () => {
  it('orders stages by what the user can do next', () => {
    expect(jobStage(makeJob({ extraction_status: null, extraction_id: null }))).toBe('new');
    expect(jobStage(makeJob({ extraction_status: 'processing' }))).toBe('extracting');
    expect(jobStage(makeJob())).toBe('jd_ready');
    expect(jobStage(makeJob({ match_in_progress: true }))).toBe('matching');
    expect(jobStage(makeJob({ match_overall_score: 70 }))).toBe('scored');
    expect(jobStage(makeJob({ match_overall_score: 70, content_generation_status: 'processing' }))).toBe('documents');
    expect(jobStage(readyJob())).toBe('ready');
    expect(jobStage(readyJob({ applied_at: '2026-10-01T00:00:00Z' }))).toBe('applied');
    expect(jobStage(makeJob({ extraction_status: 'failed' }))).toBe('failed');
  });
});

describe('readiness', () => {
  it('needs a score and both PDFs with nothing in flight', () => {
    expect(isApplyReady(readyJob())).toBe(true);
    expect(isApplyReady(readyJob({ cover_letter_pdf_status: 'pending' }))).toBe(false);
    expect(isApplyReady(readyJob({ match_in_progress: true }))).toBe(false);
    expect(isApplyReady(readyJob({ match_overall_score: null }))).toBe(false);
  });

  it('treats a re-run over stale PDFs as building', () => {
    const rerun = readyJob({ content_generation_status: 'completed', resume_build_status: 'processing' });
    expect(isDocsBuilding(rerun)).toBe(true);
    expect(isApplyReady(rerun)).toBe(false);
    expect(isDocsBuilding(readyJob({ content_generation_status: 'failed', resume_build_status: 'processing' }))).toBe(false);
  });

  it('flags rows that should keep the fallback poll alive', () => {
    expect(isInFlight(makeJob({ extraction_status: 'pending' }))).toBe(true);
    expect(isInFlight(makeJob({ match_in_progress: true }))).toBe(true);
    expect(isInFlight(readyJob())).toBe(false);
  });
});

describe('formatting helpers', () => {
  it('formats relative time compactly', () => {
    const now = Date.parse('2026-10-03T12:00:00Z');
    expect(relativeTime(null, now)).toBe('-');
    expect(relativeTime('2026-10-03T11:59:40Z', now)).toBe('now');
    expect(relativeTime('2026-10-03T11:15:00Z', now)).toBe('45m');
    expect(relativeTime('2026-10-03T07:00:00Z', now)).toBe('5h');
    expect(relativeTime('2026-09-30T12:00:00Z', now)).toBe('3d');
    expect(relativeTime('2026-06-01T12:00:00Z', now)).toBe('4mo');
  });

  it('normalizes work mode', () => {
    expect(workMode(makeJob({ work_mode: 'Hybrid' }))).toBe('hybrid');
    expect(workMode(makeJob({ work_mode: 'On-site' }))).toBe('onsite');
    expect(workMode(makeJob({ work_mode: null, is_remote: true }))).toBe('remote');
    expect(workMode(makeJob({ work_mode: null, is_remote: false }))).toBeNull();
  });

  it('labels where a job came from', () => {
    expect(sourceLabel(makeJob({ added_from: 'manual', from_me: true }))).toBe('Added by you');
    expect(sourceLabel(makeJob({ added_from: 'manual', from_me: false, added_by_name: 'Raoyin' }))).toBe('Added by Raoyin');
    expect(sourceLabel(makeJob({ added_from: 'manual', from_me: false }))).toBe('Added by a teammate');
    expect(sourceLabel(makeJob({ added_from: 'admin_manual', source: null }))).toBe('Added by team');
    expect(sourceLabel(makeJob({ source: 'remoterocketship' }))).toBe('RemoteRocketship');
    expect(sourceLabel(makeJob({ source: null, added_from: null, domain: 'boards.greenhouse.io' }))).toBe('greenhouse.io');
  });

  it('hides dismissed rows except on the failed board', () => {
    const dup = makeJob({ user_status: 'duplicated' });
    expect(isHiddenRow(dup, 'all')).toBe(true);
    expect(isHiddenRow(dup, 'extraction_failed')).toBe(false);
    expect(isHiddenRow(makeJob(), 'all')).toBe(false);
  });
});
