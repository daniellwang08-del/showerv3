import { describe, expect, it } from 'vitest';
import type { InterviewEvent } from '@/types/interviews';
import { makeEvent, makeProcess } from './interviewsFixtures';
import {
  actionItems,
  awaitingOutcome,
  buildBoard,
  dayLabel,
  eventsByDate,
  interviewLanes,
  mailErrorMessage,
  plannedSteps,
  processSteps,
  relativeAgo,
  roundType,
  shouldAutoSync,
  stageIndex,
  syncDoneMessage,
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

  it('orders each column by the next interview, then by latest activity', () => {
    const at = (d: string) => makeEvent({ scheduled_at: d });
    const board = buildBoard(
      [
        makeProcess({ id: 'idle-old', last_activity_at: '2026-10-01T00:00:00Z' }),
        makeProcess({ id: 'later', next_event: at('2026-10-20T10:00:00Z') }),
        makeProcess({ id: 'idle-new', last_activity_at: '2026-10-10T00:00:00Z' }),
        makeProcess({ id: 'soon', next_event: at('2026-10-17T10:00:00Z') }),
      ],
      NOW.getTime(),
    );
    const interviewing = board.columns.find((c) => c.id === 'interviewing')!;
    expect(interviewing.processes.map((p) => p.id)).toEqual(['soon', 'later', 'idle-new', 'idle-old']);
  });

  it('classifies rounds by kind and wording', () => {
    const r = (kind: InterviewEvent['kind'], title: string) => roundType(makeEvent({ kind, title }));
    expect(r('technical', 'Live coding with Sam')).toBe('coding');
    expect(r('technical', 'System Design interview')).toBe('design');
    expect(r('other', 'Culture and values chat')).toBe('culture');
    expect(r('behavioral', 'Meet the team')).toBe('culture');
    expect(r('other', 'Chat with the hiring manager')).toBe('manager');
    expect(r('final', 'Virtual onsite')).toBe('onsite');
    expect(r('recruiter_screen', 'Intro')).toBe('screen');
    expect(r('assessment', 'HackerRank test')).toBe('assessment');
    expect(r('other', 'Next steps')).toBe('other');
  });

  it('merges reminders and reschedules of a round into one step, ordered by date', () => {
    const steps = processSteps(
      makeProcess({
        events: [
          makeEvent({ id: 'cul', kind: 'behavioral', title: 'Values', scheduled_at: '2026-10-22T15:00:00Z', email_date: '2026-10-14T00:00:00Z' }),
          makeEvent({ id: 'cod', title: 'Coding round', scheduled_at: '2026-10-20T10:00:00Z', email_date: '2026-10-14T00:00:00Z' }),
          makeEvent({ id: 'rem', title: 'Reminder: Coding round', scheduled_at: '2026-10-20T10:00:00Z', email_date: '2026-10-19T00:00:00Z' }),
          makeEvent({ id: 'old', title: 'System design', status: 'cancelled', scheduled_at: '2026-10-18T10:00:00Z', email_date: '2026-10-13T00:00:00Z' }),
          makeEvent({ id: 'new', title: 'System design', scheduled_at: '2026-10-21T10:00:00Z', email_date: '2026-10-15T00:00:00Z' }),
          makeEvent({ id: 'ask', kind: 'scheduling', status: 'needs_scheduling', title: 'Pick a time: coding', email_date: '2026-10-10T00:00:00Z' }),
          makeEvent({ id: 'app', kind: 'application_received', status: 'info', email_date: '2026-10-01T00:00:00Z' }),
        ],
      }),
    );
    expect(steps.map((s) => [s.type, s.title, s.event.id])).toEqual([
      ['design', 'System design', 'old'],
      ['coding', 'Coding round', 'rem'],
      ['design', 'System design', 'new'],
      ['culture', 'Values', 'cul'],
    ]);
    expect(steps[0].rescheduled).toBe(true);
    expect(steps[2].rescheduled).toBe(false);
  });

  it('keeps only real rounds from the remaining steps', () => {
    const steps = processSteps(makeProcess({ events: [makeEvent({ title: 'Coding round', scheduled_at: '2026-10-20T10:00:00Z' })] }));
    const planned = plannedSteps(
      makeProcess({ remaining_steps: ['Coding round', 'Culture interview', 'Wait for a decision', 'Team review', 'Onsite loop'] }),
      steps,
    );
    expect(planned).toEqual([
      { type: 'culture', title: 'Culture interview' },
      { type: 'onsite', title: 'Onsite loop' },
    ]);
  });

  it('groups interviewing processes by the round coming up next', () => {
    const groups = interviewLanes(
      [
        makeProcess({ id: 'w', events: [makeEvent({ title: 'Coding', status: 'completed', scheduled_at: '2026-10-10T10:00:00Z' })] }),
        makeProcess({ id: 'd2', events: [makeEvent({ title: 'System design', scheduled_at: '2026-10-19T10:00:00Z' })] }),
        makeProcess({ id: 'c', events: [makeEvent({ title: 'Pair programming', scheduled_at: '2026-10-17T10:00:00Z' })] }),
        makeProcess({ id: 'd1', events: [makeEvent({ title: 'Architecture', scheduled_at: '2026-10-18T10:00:00Z' })] }),
      ],
      NOW.getTime(),
    );
    expect(groups.map((g) => [g.label, g.lanes.map((l) => l.process.id)])).toEqual([
      ['Up next: Coding', ['c']],
      ['Up next: System design', ['d1', 'd2']],
      ['Waiting on feedback', ['w']],
    ]);
  });

  it('lists events newest first by interview time, else email date', () => {
    const events = [
      makeEvent({ id: 'a', email_date: '2026-10-01T00:00:00Z' }),
      makeEvent({ id: 'b', scheduled_at: '2026-10-20T00:00:00Z', email_date: '2026-10-02T00:00:00Z' }),
      makeEvent({ id: 'c', email_date: '2026-10-05T00:00:00Z' }),
    ];
    expect(eventsByDate(events).map((e) => e.id)).toEqual(['b', 'c', 'a']);
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

  it('describes how long ago something happened', () => {
    const now = NOW.getTime();
    const ago = (ms: number) => relativeAgo(new Date(now - ms).toISOString(), now);
    expect(ago(20_000)).toBe('just now');
    expect(ago(5 * 60_000)).toBe('5 min ago');
    expect(ago(61 * 60_000)).toBe('1 hour ago');
    expect(ago(5 * 3_600_000)).toBe('5 hours ago');
    expect(ago(30 * 3_600_000)).toBe('yesterday');
    expect(ago(4 * 86_400_000)).toBe('4 days ago');
    expect(relativeAgo(null, now)).toBeNull();
  });

  it('auto-syncs only when the last sync is stale', () => {
    const now = NOW.getTime();
    expect(shouldAutoSync(null, now)).toBe(true);
    expect(shouldAutoSync(new Date(now - 5 * 60_000).toISOString(), now)).toBe(false);
    expect(shouldAutoSync(new Date(now - 45 * 60_000).toISOString(), now)).toBe(true);
  });

  it('summarises a finished sync', () => {
    const base = { scanned: 900, candidates: 40, relevant: 20, created: 0, updated: 0 };
    expect(syncDoneMessage({ ...base, applications: 1, created: 2, updated: 1, jobs_marked: 3 })).toBe(
      'Sync done: 1 new application, 2 new processes, 1 updated process, 3 jobs marked applied',
    );
    expect(syncDoneMessage(base)).toBe('Sync done. No new hiring emails.');
    expect(syncDoneMessage(null)).toBe('Sync done. No new hiring emails.');
  });

  it('turns callback reasons into readable errors', () => {
    expect(mailErrorMessage('invalid_state')).toMatch(/expired/);
    expect(mailErrorMessage('User cancelled the sign in')).toBe('User cancelled the sign in');
    expect(mailErrorMessage('weird_code')).toBe('Could not connect your email. Try again.');
    expect(mailErrorMessage(null)).toBe('Could not connect your email. Try again.');
  });
});
