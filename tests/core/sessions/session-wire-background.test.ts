import { describe, expect, it, vi } from 'vitest';
import type { WorktreeSession } from '../../../src/core/sessions/history.js';

/**
 * The wire's "In background": a recorded turn that ended (idle), Claude Code still busy since before it, and the
 * agent reporting a background agent at work → the row's attention is working, marked `background` with what it is.
 */

const ended = '2026-10-26T09:43:45.000Z';
vi.mock('../../../src/core/sessions/session-meta.js', () => ({
  readSessionMeta: () => ({
    draftCount: 0,
    commentCount: 0,
    claudeCount: 0,
    ptyStatus: 'running',
    pendingForClaudeCount: 0,
    lastActivity: Date.parse(ended),
    activityState: 'open',
    attention: { state: 'idle', seen: true, since: ended, updatedAt: ended, turnEndedAt: ended, stale: false },
  }),
}));
vi.mock('../../../src/core/conversations/context-usage.js', () => ({ readContextUsage: () => null }));

// The session's agent: Claude's, but with its background lookup answered here (`work` decides what it says).
const background = vi.hoisted(() => ({
  answer: null as { what: string | null } | null,
  asked: [] as number[],
  /** The background commands its conversation has running; null: the read throws. */
  commands: [] as string[] | null,
}));
vi.mock('../../../src/core/agents/index.js', async (orig) => {
  const real = await orig<typeof import('../../../src/core/agents/index.js')>();
  return {
    ...real,
    agentOf: (s: WorktreeSession) => {
      const a = real.agentOf(s);
      return {
        ...a,
        conversation: a.conversation && {
          ...a.conversation,
          backgroundWorkSince: (_s: WorktreeSession, ms: number) => (background.asked.push(ms), background.answer),
          backgroundCommandNames: () => {
            if (background.commands === null) throw new Error('transcript unreadable');
            return background.commands;
          },
        },
      };
    },
  };
});

const { sessionWire } = await import('../../../src/core/sessions/session-wire.js');

const s = {
  target: 'straumur-docs',
  branch: 'feat/stored-card-email',
  isGroup: true,
  paths: ['/wt/feat-stored-card-email/backend', '/wt/feat-stored-card-email/docs'],
  createdAt: '2026-10-22T00:00:00Z',
  lastAccessedAt: '2026-10-26T09:00:00Z',
} as WorktreeSession;
const busy = { inTerminal: 0, inApp: 1, busy: true, duplicate: false, state: 'busy' as const, stateAt: Date.parse(ended) - 14_000 };

describe('sessionWire: In background', () => {
  it('a turn that ended while Claude Code stays busy and a background agent works: working, marked with what it is', () => {
    background.answer = { what: '/mtk:code-review-and-quality Re-review' };
    background.asked.length = 0;
    const row = sessionWire(s, { claudesFor: () => busy, liveKnown: true });
    expect(row.attention).toMatchObject({ state: 'working', background: { what: '/mtk:code-review-and-quality Re-review' } });
    // Asked from the turn's end (the Stop hook's time).
    expect(background.asked).toEqual([Date.parse(ended)]);
  });

  it('no background agent: the turn is over (idle, no mark)', () => {
    background.answer = null;
    const row = sessionWire(s, { claudesFor: () => busy, liveKnown: true });
    expect(row.attention?.state).toBe('idle');
    expect(row.attention).not.toHaveProperty('background');
  });

  it('Claude Code says `shell`: idle, marked with the background command its conversation has running', () => {
    const shell = { ...busy, busy: false, state: 'shell' as const };
    background.commands = ['Run the backend tests'];
    expect(sessionWire(s, { claudesFor: () => shell, liveKnown: true }).attention).toMatchObject({
      state: 'idle',
      background: { what: 'Run the backend tests', command: true },
    });
    // A conversation that can't be read still says In background, with no name.
    background.commands = null;
    expect(sessionWire(s, { claudesFor: () => shell, liveKnown: true }).attention).toMatchObject({
      state: 'idle',
      background: { what: null, command: true },
    });
  });
});

describe('sessionWire: kept after its PR merges', () => {
  it('says so for a live session you asked to keep, and for no other', () => {
    expect(sessionWire({ ...s, keepAfterMerge: true }, {}).keepAfterMerge).toBe(true);
    expect(sessionWire(s, {})).not.toHaveProperty('keepAfterMerge');
    expect(sessionWire({ ...s, keepAfterMerge: true, archivedAt: ended }, {})).not.toHaveProperty('keepAfterMerge');
  });
});
