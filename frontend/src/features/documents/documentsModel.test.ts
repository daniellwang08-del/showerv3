import { describe, expect, it } from 'vitest';
import { groupByRecency, rowStatus, type DocRow } from './documentsModel';

function row(key: string, updatedAt: string | null, files: Partial<DocRow['files']> = {}, note: string | null = null): DocRow {
  return {
    key,
    kind: 'library',
    id: key,
    jobId: null,
    title: key,
    subtitle: null,
    origin: 'mine',
    updatedAt,
    isActive: false,
    note,
    files: { resume_pdf: 'ready', resume_docx: 'ready', cover_letter_pdf: 'none', cover_letter_docx: 'none', ...files },
    hasPosting: false,
    matchScore: null,
    fromChat: false,
  };
}

describe('documentsModel', () => {
  it('groups newest-first rows into recency buckets and drops empty ones', () => {
    const now = new Date(2026, 9, 16, 15, 0, 0);
    const groups = groupByRecency(
      [
        row('a', new Date(2026, 9, 16, 9).toISOString()),
        row('b', new Date(2026, 9, 13, 9).toISOString()),
        row('c', new Date(2026, 7, 1, 9).toISOString()),
        row('d', null),
      ],
      now,
    );
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.key)])).toEqual([
      ['Today', ['a']],
      ['This week', ['b']],
      ['Earlier', ['c', 'd']],
    ]);
  });

  it('reports generating before failed, and failed for notes', () => {
    expect(rowStatus(row('a', null))).toBe('ready');
    expect(rowStatus(row('b', null, { resume_pdf: 'working', cover_letter_pdf: 'failed' }))).toBe('working');
    expect(rowStatus(row('c', null, { cover_letter_pdf: 'failed' }))).toBe('failed');
    expect(rowStatus(row('d', null, {}, 'Content generation failed.'))).toBe('failed');
  });
});
