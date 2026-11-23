import { describe, expect, it } from 'vitest';
import { noteDelivery } from '../../../src/core/comments/note-delivery.js';

const base = { author: 'user', hosted: true, pending: 1, live: [] as Array<'busy' | 'idle' | 'waiting' | 'shell' | null>, shown: null };

describe('noteDelivery', () => {
  it("the agent's own word first: idle at its prompt is typed into, even when the hooks still say working (an interrupted turn)", () => {
    expect(noteDelivery({ ...base, live: ['idle'], shown: 'working' })).toBe('typed');
    expect(noteDelivery({ ...base, live: ['shell'], shown: 'working' })).toBe('typed');
  });

  it('mid-turn, or waiting on you (Enter would answer its prompt): left for the turn end', () => {
    expect(noteDelivery({ ...base, live: ['busy'], shown: 'idle' })).toBe('next-turn');
    expect(noteDelivery({ ...base, live: ['waiting'] })).toBe('next-turn');
    // …and when only the hooks' record says it waits on you (the agent says nothing): a recheck must not answer it.
    expect(noteDelivery({ ...base, live: [null], shown: 'needs_input' })).toBe('next-turn');
    expect(noteDelivery({ ...base, shown: 'needs_input' })).toBe('next-turn');
  });

  it('the agent says nothing: the status as the dashboard shows it', () => {
    expect(noteDelivery({ ...base, live: [null], shown: 'working' })).toBe('next-turn');
    expect(noteDelivery({ ...base, shown: 'idle' })).toBe('typed');
    expect(noteDelivery({ ...base, shown: null })).toBe('typed');
  });

  it("nothing to do: a Claude's own reply, no terminal of work's, nothing pending", () => {
    expect(noteDelivery({ ...base, author: 'claude', live: ['idle'] })).toBeNull();
    expect(noteDelivery({ ...base, hosted: false, live: ['idle'] })).toBeNull();
    expect(noteDelivery({ ...base, pending: 0, live: ['idle'] })).toBeNull();
  });
});
