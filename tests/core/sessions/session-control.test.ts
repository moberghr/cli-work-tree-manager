import { describe, expect, it, vi } from 'vitest';
import {
  parseDuration,
  pendingRequest,
  sendHowText,
  sendToSession,
  waitForTurn,
  MAX_SEND_CHARS,
  type SendDeps,
  type TurnStatus,
} from '../../../src/core/sessions/session-control.js';
import { STILL_UNSAFE } from '../../../src/core/sessions/legacy-unsafe.js';

/** Driving a session from outside its terminal: the policy (session-control.ts), with its I/O faked. */

const deps = (over: Partial<SendDeps> = {}, delivered: 'typed' | 'next-turn' | null = null): SendDeps & { posted: string[] } => {
  const posted: string[] = [];
  return {
    posted,
    post: vi.fn(async (_id: string, body: string) => (posted.push(body), delivered)),
    hostRuns: () => false,
    runningOutside: () => false,
    start: vi.fn(async () => true),
    state: () => 'idle',
    archived: () => false,
    ...over,
  };
};
const NOW = () => new Date('2026-10-02T09:00:00Z');

describe('sendToSession', () => {
  it('in the PTY host: says what the comment route did — typed in, or left for the end of the turn (reviewed: not a second look at the state)', async () => {
    const d = deps({ hostRuns: () => true, state: () => 'working' }, 'typed'); // the route typed it; the state read after says otherwise
    expect(await sendToSession('s', '  Run the tests  ', d, { now: NOW })).toEqual({
      ok: true,
      how: 'typed',
      sentAt: '2026-10-02T09:00:00.000Z',
    });
    expect(d.posted).toEqual(['Run the tests']);
    expect(await sendToSession('s', 'x', deps({ hostRuns: () => true }, 'next-turn'))).toMatchObject({ how: 'next-turn' });
    // The host runs it but the route typed nothing (it had nothing pending to nudge): its next turn.
    expect(await sendToSession('s', 'x', deps({ hostRuns: () => true }, null))).toMatchObject({ how: 'next-turn' });
  });

  it('an agent still running as started --unsafe before the retirement is refused, nothing posted (remove next release)', async () => {
    const d = deps({ stillUnsafe: (id) => id === 's', hostRuns: () => true });
    expect(await sendToSession('s', 'Run the tests', d)).toEqual({ ok: false, status: 409, error: STILL_UNSAFE });
    expect(d.posted).toEqual([]);
    expect(d.start).not.toHaveBeenCalled();
    expect(await sendToSession('t', 'x', d)).toMatchObject({ ok: true });
  });

  it('running in a terminal outside work: queued for its next turn there, nothing started', async () => {
    const d = deps({ runningOutside: () => true });
    expect(await sendToSession('s', 'x', d)).toMatchObject({ ok: true, how: 'outside' });
    expect(d.start).not.toHaveBeenCalled();
  });

  it('not running anywhere: its Claude is started for it; a start that fails says the note waits', async () => {
    const d = deps();
    expect(await sendToSession('s', 'x', d)).toMatchObject({ ok: true, how: 'started' });
    expect(d.start).toHaveBeenCalledWith('s');
    expect(await sendToSession('s', 'x', deps({ start: async () => false }))).toMatchObject({
      ok: false,
      status: 502,
      error: expect.stringContaining('queued'),
    });
  });

  it('refused: empty, too long, archived', async () => {
    expect(await sendToSession('s', '   ', deps())).toMatchObject({ ok: false, status: 400 });
    expect(await sendToSession('s', 'x'.repeat(MAX_SEND_CHARS + 1), deps())).toMatchObject({ ok: false, status: 400 });
    expect(await sendToSession('s', 'x', deps({ archived: () => true }))).toMatchObject({
      ok: false,
      status: 409,
      error: expect.stringContaining('archived'),
    });
  });

  it('says how in a line', () => {
    expect(sendHowText('typed')).toContain('typed into its terminal');
    expect(sendHowText('started')).toContain('started');
    expect(sendHowText('outside')).toContain('outside work');
    expect(sendHowText('next-turn')).toContain('when the turn ends');
  });
});

describe('waitForTurn', () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  it('without `after`: returns as soon as it isn’t working', async () => {
    const statuses: TurnStatus[] = [
      { state: 'working', since: 'x' },
      { state: 'working', since: 'x' },
      { state: 'idle', since: '2026-10-02T09:01:00Z', summary: 'Done.' },
    ];
    const c = clock();
    const r = await waitForTurn('s', { ...c, status: () => statuses.shift() ?? null }, { timeoutMs: 60_000 });
    expect(r).toEqual({ ok: true, status: { state: 'idle', since: '2026-10-02T09:01:00Z', summary: 'Done.' } });
    expect(c.now()).toBe(2000); // two polls
  });

  it('with `after`: the turn before the message doesn’t count; asking you does', async () => {
    const statuses: TurnStatus[] = [
      { state: 'idle', since: '2026-10-02T08:00:00Z' }, // the old turn
      { state: 'working', since: '2026-10-02T09:00:01Z' },
      { state: 'needs_input', since: '2026-10-02T09:00:30Z', summary: 'Bash npm test' },
    ];
    const r = await waitForTurn(
      's',
      { ...clock(), status: () => statuses.shift() ?? null },
      { after: '2026-10-02T09:00:00Z', timeoutMs: 60_000 },
    );
    expect(r).toMatchObject({ ok: true, status: { state: 'needs_input' } });
  });

  it('gives up at the timeout, with the state it saw', async () => {
    const r = await waitForTurn('s', { ...clock(), status: () => ({ state: 'working', since: 'x' }) }, { timeoutMs: 5000 });
    expect(r).toEqual({ ok: false, reason: 'timeout', status: { state: 'working', since: 'x' } });
  });
});

describe('the small helpers', () => {
  it('pendingRequest: only while waiting on a permission prompt', () => {
    const request = { tool: 'Bash', detail: 'npm test' };
    expect(pendingRequest({ state: 'needs_input', request })).toEqual(request);
    expect(pendingRequest({ state: 'needs_input' })).toBeNull(); // a question, not a tool call
    expect(pendingRequest({ state: 'idle', request })).toBeNull();
    expect(pendingRequest(null)).toBeNull();
  });

  it('parseDuration: s, m, h or plain seconds', () => {
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('15m')).toBe(900_000);
    expect(parseDuration('1.5h')).toBe(5_400_000);
    expect(parseDuration('30')).toBe(30_000);
    expect(parseDuration('soon')).toBeNull();
  });
});
