import { describe, it, expect } from 'vitest';
import type { SessionAttention, SessionSummary } from '../../src/web/src/api/client.js';
import { isDoneUnseen, nextInQueue, queuePosition, startQueue } from '../../src/web/src/state/review-queue.js';

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const att = (state: SessionAttention['state'], seen: boolean, mins: number): SessionAttention =>
  ({ state, seen, since: minsAgo(mins), updatedAt: minsAgo(mins), stale: false });
const s = (id: string, attention: SessionAttention | null, archivedAt: string | null = null): SessionSummary =>
  ({ id, target: 'r', branch: id, isGroup: false, paths: [], createdAt: minsAgo(99), lastAccessedAt: minsAgo(9), attention, archivedAt, activityState: 'stale' });

const SESSIONS = [
  s('done-new', att('idle', false, 2)),
  s('blocked', att('needs_input', false, 30)),
  s('done-old', att('idle', false, 20)),
  s('seen', att('idle', true, 5)),
  s('working', att('working', true, 1)),
  s('archived', att('idle', false, 50), minsAgo(1)),
];

describe('review queue', () => {
  it('holds the finished, unseen sessions in inbox order (longest waiting first)', () => {
    expect(startQueue(SESSIONS)?.ids).toEqual(['done-old', 'done-new']);
    expect(SESSIONS.filter(isDoneUnseen).map((x) => x.id).sort()).toEqual(['done-new', 'done-old']);
    expect(startQueue([s('w', att('working', true, 1))])).toBeNull();
  });

  it('keeps its order after the sessions it opened are marked seen', () => {
    const q = startQueue(SESSIONS)!;
    const afterSeen = SESSIONS.map((x) => (x.id === 'done-old' ? { ...x, attention: att('idle', true, 20) } : x));
    expect(nextInQueue(q, 'done-old', afterSeen)).toBe('done-new');
    expect(queuePosition(q, 'done-new')).toBe(2);
    expect(queuePosition(q, 'working')).toBeNull();
    expect(queuePosition(q, null)).toBeNull();
  });

  it('skips sessions deleted or archived meanwhile, and ends after the last', () => {
    const q = { ids: ['a', 'b', 'c'] };
    const live = [s('a', null), s('b', null, minsAgo(1)), s('c', null)];
    expect(nextInQueue(q, 'a', live)).toBe('c');
    expect(nextInQueue(q, 'c', live)).toBeNull();
    expect(nextInQueue(q, 'a', [s('a', null)])).toBeNull();
  });
});
