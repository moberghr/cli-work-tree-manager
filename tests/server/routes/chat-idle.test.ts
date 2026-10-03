import { describe, expect, it } from 'vitest';
import { idleChats } from '../../../src/server/routes/chat-routes.js';

describe('idleChats', () => {
  it('only idle chats, quiet long enough, with no chat view open', () => {
    const now = 10_000_000;
    const chats = new Map([
      ['quiet', { state: 'idle' as const, lastActivityAt: now - 3_600_000 }],
      ['recent', { state: 'idle' as const, lastActivityAt: now - 60_000 }],
      ['working', { state: 'working' as const, lastActivityAt: now - 3_600_000 }],
      ['watched', { state: 'idle' as const, lastActivityAt: now - 3_600_000 }],
      ['stopped', { state: 'stopped' as const, lastActivityAt: now - 3_600_000 }],
    ]);
    expect(idleChats(chats, (id) => (id === 'watched' ? 1 : 0), 30 * 60_000, now)).toEqual(['quiet']);
    expect(idleChats(chats, () => 0, 0, now)).toEqual([]); // sleep turned off
  });
});
