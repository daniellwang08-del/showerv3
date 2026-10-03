import { describe, expect, it } from 'vitest';
import { makeJob, readyJob } from '@/test/jobFixtures';
import { buildJobMenu, type JobMenuEntry, type JobMenuItem } from './jobMenu';

const noIntegrations = { sheetsConfigured: false, pumbleConfigured: false };
const ids = (entries: JobMenuEntry[]) =>
  entries.filter((e): e is JobMenuItem => e !== 'separator').map((e) => e.id);

describe('buildJobMenu', () => {
  it('offers Apply only when the job is ready', () => {
    expect(ids(buildJobMenu([readyJob()], noIntegrations))).toContain('apply');
    expect(ids(buildJobMenu([makeJob()], noIntegrations))).not.toContain('apply');
  });

  it('single-job menu has details and copy; multi-job menu does not', () => {
    const single = ids(buildJobMenu([makeJob()], noIntegrations));
    expect(single).toEqual(['open', 'open-url', 'copy-url', 'mark-applied', 'prepare', 'delete']);
    const multi = ids(buildJobMenu([makeJob(), makeJob()], noIntegrations));
    expect(multi).toEqual(['open-url', 'mark-applied', 'prepare', 'delete']);
  });

  it('splits mixed selections into apply and unapply subsets', () => {
    const a = makeJob({ applied_at: '2026-10-01T00:00:00Z' });
    const b = makeJob();
    const c = makeJob();
    const entries = buildJobMenu([a, b, c], noIntegrations).filter((e): e is JobMenuItem => e !== 'separator');
    expect(entries.find((e) => e.id === 'mark-applied')?.targets).toEqual([b, c]);
    expect(entries.find((e) => e.id === 'unmark-applied')?.targets).toEqual([a]);
    expect(entries.find((e) => e.id === 'mark-applied')?.label).toBe('Mark applied (2)');
  });

  it('shows integrations only when configured and disables them while posting', () => {
    const entries = buildJobMenu([makeJob()], {
      sheetsConfigured: true,
      pumbleConfigured: true,
      postingToSheet: true,
    }).filter((e): e is JobMenuItem => e !== 'separator');
    expect(entries.find((e) => e.id === 'post-sheet')?.disabled).toBe(true);
    expect(entries.find((e) => e.id === 'post-pumble')?.disabled).toBeFalsy();
  });

  it('disables re-analysis while a job is still being read', () => {
    const entries = buildJobMenu([makeJob({ extraction_status: 'processing' })], noIntegrations).filter(
      (e): e is JobMenuItem => e !== 'separator',
    );
    expect(entries.find((e) => e.id === 'prepare')?.disabled).toBe(true);
  });
});
