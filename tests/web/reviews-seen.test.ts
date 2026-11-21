import { describe, expect, it } from 'vitest';
import { isNewReview, markSeen, newReviews, readSeen, SEEN_KEY, seedSeen, writeSeen } from '../../src/web/src/state/reviews-seen.js';

/** The Reviews list's "new" mark: ready since you last opened it, per browser (asked for: nothing said a review was done). */
const row = (number: number, status: string, at: string) => ({ repo: 'api', number, status, at });

describe('which reviews are new', () => {
  const list = [row(1, 'ready', 't1'), row(2, 'ready', 't2'), row(3, 'running', 't3'), row(4, 'waiting', 't4')];

  it('the first time, every review there is counts as seen: nothing starts out new', () => {
    expect(newReviews(list, seedSeen(list)).size).toBe(0);
  });

  it('a review prepared since you opened it is new (prepared again: new again); only ready ones are', () => {
    const seen = seedSeen(list);
    const later = [row(1, 'ready', 't1b'), row(2, 'ready', 't2'), row(3, 'ready', 't3b'), row(4, 'waiting', 't4b'), row(5, 'ready', 't5')];
    const marks = newReviews(later, seen);
    expect([...marks].sort()).toEqual(['api#1', 'api#3', 'api#5']);
    expect(isNewReview(marks, { repo: 'api', number: 1 })).toBe(true);
    expect(isNewReview(marks, { repo: 'api', number: 2 })).toBe(false);
    expect(isNewReview(marks, { repo: 'web', number: 1 })).toBe(false);
  });

  it('opening one marks it seen as it is now; the same again changes nothing', () => {
    const seen = seedSeen(list);
    const next = markSeen(seen, row(1, 'ready', 't1b'));
    expect(next['api#1']).toBe('t1b');
    expect(newReviews([row(1, 'ready', 't1b')], next).size).toBe(0);
    expect(markSeen(next, row(1, 'ready', 't1b'))).toBe(next);
  });

  it('kept per browser; nothing stored, or what can’t be read, is the first time', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(readSeen(storage)).toBeNull();
    writeSeen({ 'api#1': 't1' }, storage);
    expect(readSeen(storage)).toEqual({ 'api#1': 't1' });
    store.set(SEEN_KEY, '{not json');
    expect(readSeen(storage)).toBeNull();
    store.set(SEEN_KEY, JSON.stringify({ 'api#1': 't1', 'api#2': 7 }));
    expect(readSeen(storage)).toEqual({ 'api#1': 't1' });
    // A browser that won't store: nothing thrown.
    expect(() =>
      writeSeen(
        {},
        {
          setItem: () => {
            throw new Error('quota');
          },
        },
      ),
    ).not.toThrow();
    expect(readSeen(null)).toBeNull();
  });
});
