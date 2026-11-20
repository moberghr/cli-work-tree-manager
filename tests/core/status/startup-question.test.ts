import { describe, expect, it } from 'vitest';
import { claudeStartupQuestion, TRUST_QUESTION } from '../../../src/core/agents/claude/startup-question.js';
import { createStartupQuestions, type StartupTerminal } from '../../../src/core/status/startup-question.js';

/** An agent stopped at its own question before its first turn (reported: a session sat at "do you trust this folder?" unnoticed). */
const TRUST_SCREEN = [
  '────────────────────────────────────────────────',
  ' Accessing workspace:',
  ' C:\\repos\\worktrees\\feat-x',
  '',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open',
  ' source project, or work from your team). If not, take a moment to review what’s in this folder first.',
  '',
  ' Claude Code’ll be able to read, edit, and execute files here.',
  '',
  ' Security guide',
  '',
  ' ❯ 1. Yes, I trust this folder',
  '   2. No, exit',
  '',
  ' Enter to confirm · Esc to cancel',
  '',
].join('\n');

describe('Claude’s trust question on a screen', () => {
  it('is recognised by its two answers at the end of the screen, in this version’s words and the older one’s', () => {
    expect(claudeStartupQuestion(TRUST_SCREEN)).toBe(TRUST_QUESTION);
    const older = [
      '│ Do you trust the files in this folder?   │',
      '│ ❯ 1. Yes, proceed                        │',
      '│   2. No, exit                            │',
    ].join('\n');
    expect(claudeStartupQuestion(older)).toBe(TRUST_QUESTION);
  });

  it('a conversation that only mentions it isn’t one: Claude’s prompt comes after', () => {
    const talk = [
      'It showed "❯ 1. Yes, I trust this folder" and',
      ' ❯ 1. Yes, I trust this folder',
      '   2. No, exit',
      '● That is the dialog you saw.',
      '',
      '● It appears once per folder.',
      '  A folder under a trusted one is trusted too.',
      '  Nothing else changes.',
      '────────────────────────',
      '❯ ',
      '────────────────────────',
      '  ? for shortcuts',
    ].join('\n');
    expect(claudeStartupQuestion(talk)).toBeNull();
    expect(claudeStartupQuestion('')).toBeNull();
    expect(claudeStartupQuestion(' ❯ 1. Yes\n   2. No, exit')).toBeNull();
  });
});

describe('createStartupQuestions', () => {
  const NOW = new Date('2026-11-19T10:00:00Z');
  const term = (over: Partial<StartupTerminal> = {}): StartupTerminal => ({
    id: 's1',
    startedAt: '2026-11-19T09:00:00Z',
    lastOutputAt: '2026-11-19T09:00:05Z',
    turnAt: 0,
    ...over,
  });
  const make = (screens: Record<string, string | null>) => {
    const reads: string[] = [];
    const q = createStartupQuestions({
      screen: async (id) => (reads.push(id), screens[id] ?? null),
      question: (_id, screen) => claudeStartupQuestion(screen),
      now: () => NOW,
    });
    return { q, reads };
  };

  it('an agent with no turn since it started, stopped at the question: found once, said once, its screen read once', async () => {
    const { q, reads } = make({ s1: TRUST_SCREEN });
    expect(q.for('s1')).toBeNull();
    expect(await q.check([term()])).toEqual({ changed: true, asked: ['s1'] });
    expect(q.for('s1')).toEqual({ what: TRUST_QUESTION, since: NOW.toISOString() });
    // Nothing printed since: not read again, nothing changed.
    expect(await q.check([term()])).toEqual({ changed: false, asked: [] });
    expect(reads).toEqual(['s1']);
  });

  it('answered (it printed, and the question is gone), or a turn recorded, or its terminal gone: cleared', async () => {
    const screens: Record<string, string | null> = { s1: TRUST_SCREEN, s2: TRUST_SCREEN, s3: TRUST_SCREEN };
    const { q, reads } = make(screens);
    await q.check([term(), term({ id: 's2' }), term({ id: 's3' })]);
    screens.s1 = '❯ \n  ? for shortcuts';
    const next = await q.check([
      term({ lastOutputAt: '2026-11-19T09:10:00Z' }),
      term({ id: 's2', turnAt: Date.parse('2026-11-19T09:05:00Z') }),
    ]);
    expect(next).toEqual({ changed: true, asked: [] });
    expect([q.for('s1'), q.for('s2'), q.for('s3')]).toEqual([null, null, null]);
    // One with a turn since its start is never read again.
    const before = reads.length;
    await q.check([term({ id: 's2', turnAt: Date.parse('2026-11-19T09:05:00Z'), lastOutputAt: '2026-11-19T09:30:00Z' })]);
    expect(reads.length).toBe(before);
  });

  it('a session that had a turn before this start is still looked at; a screen that can’t be read is tried again', async () => {
    const screens: Record<string, string | null> = { s1: null };
    const { q, reads } = make(screens);
    const restarted = term({ turnAt: Date.parse('2026-11-18T12:00:00Z') });
    expect(await q.check([restarted])).toEqual({ changed: false, asked: [] });
    screens.s1 = TRUST_SCREEN;
    expect(await q.check([restarted])).toEqual({ changed: true, asked: ['s1'] });
    expect(reads).toEqual(['s1', 's1']);
  });

  it('an agent with nothing work recognises is asked nothing', async () => {
    const q = createStartupQuestions({ screen: async () => TRUST_SCREEN, question: () => null });
    expect(await q.check([term()])).toEqual({ changed: false, asked: [] });
    expect(q.for('s1')).toBeNull();
  });
});
