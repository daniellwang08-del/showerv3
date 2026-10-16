import { describe, expect, it } from 'vitest';
import { makeEvent, makeProcess } from './interviewsFixtures';
import {
  actionItems,
  awaitingOutcome,
  buildBoard,
  dayLabel,
  mailErrorMessage,
  shouldAutoSync,
  stageIndex,
  upcomingInterviews,
} from './interviewsModel';

const NOW = new Date('2026-10-16T12:00:00Z');

describe('interviewsModel', () => {
  it('groups active processes into columns and keeps closed ones apart', () => {
    const board = buildBoard([
      makeProcess({ id: 'a', stage: 'applied' }),
      makeProcess({ id: 'b', stage: 'screening' }),
      makeProcess({ id: 'c', stage: 'offer' }),
      makeProcess({ id: 'd', stage: 'rejected', status: 'closed' }),
      makeProcess({ id: 'e', stage: 'final', status: 'closed' }),
    ]);
    const ids = Object.fromEntries(board.columns.map((c) => [c.id, c.processes.map((p) => p.id)]));
    expect(ids).toEqual({ screening: ['a', 'b'], assessment: [], interviewing: [], final: [], offer: ['c'] });
    expect(board.closed.map((p) => p.id)).toEqual(['d', 'e']);
  });

  it('splits scheduled rounds into upcoming and awaiting outcome', () => {
    const past = makeEvent({ id: 'past', scheduled_at: '2026-10-15T12:00:00Z' });
    const soon = makeEvent({ id: 'soon', scheduled_at: '2026-10-17T09:00:00Z' });
    const later = makeEvent({ id: 'later', scheduled_at: '2026-10-20T09:00:00Z' });
    const done = makeEvent({ id: 'done', status: 'completed', scheduled_at: '2026-10-18T09:00:00Z' });
    const processes = [
      makeProcess({ events: [later, past, done] }),
      makeProcess({ id: 'p2', events: [soon] }),
      makeProcess({ id: 'p3', status: 'closed', events: [makeEvent({ id: 'x', scheduled_at: '2026-10-19T09:00:00Z' })] }),
    ];
    expect(upcomingInterviews(processes, NOW).map((i) => i.event.id)).toEqual(['soon', 'later']);
    expect(awaitingOutcome(processes, NOW).map((i) => i.event.id)).toEqual(['past']);
  });

  it('lists scheduling requests and required actions', () => {
    const processes = [
      makeProcess({
        events: [
          makeEvent({ id: 'a', status: 'needs_scheduling', email_date: '2026-10-10T00:00:00Z' }),
          makeEvent({ id: 'b', status: 'action_required', email_date: '2026-10-12T00:00:00Z' }),
          makeEvent({ id: 'c', status: 'info' }),
        ],
      }),
    ];
    expect(actionItems(processes).map((i) => i.event.id)).toEqual(['b', 'a']);
  });

  it('labels days and stage positions', () => {
    const now = new Date(2026, 9, 16, 10);
    expect(dayLabel(new Date(2026, 9, 16, 15).toISOString(), now)).toBe('Today');
    expect(dayLabel(new Date(2026, 9, 17, 9).toISOString(), now)).toBe('Tomorrow');
    expect(dayLabel(new Date(2026, 9, 19, 9).toISOString(), now)).toBe('In 3 days');
    expect(stageIndex('applied')).toBe(0);
    expect(stageIndex('offer')).toBe(5);
    expect(stageIndex('rejected')).toBe(-1);
  });

  it('auto-syncs only when the last sync is stale', () => {
    const now = NOW.getTime();
    expect(shouldAutoSync(null, now)).toBe(true);
    expect(shouldAutoSync(new Date(now - 5 * 60_000).toISOString(), now)).toBe(false);
    expect(shouldAutoSync(new Date(now - 45 * 60_000).toISOString(), now)).toBe(true);
  });

  it('turns callback reasons into readable errors', () => {
    expect(mailErrorMessage('invalid_state')).toMatch(/expired/);
    expect(mailErrorMessage('User cancelled the sign in')).toBe('User cancelled the sign in');
    expect(mailErrorMessage('weird_code')).toBe('Could not connect your email. Try again.');
    expect(mailErrorMessage(null)).toBe('Could not connect your email. Try again.');
  });
});
