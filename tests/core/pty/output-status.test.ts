import { describe, it, expect } from 'vitest';
import { OUTPUT_WORKING_MS, statusFromOutput, statusFromSignal } from '../../../src/core/pty/output-status.js';
import { STALE_WORKING_MS } from '../../../src/core/status/session-status.js';
import type { ProgramRecord, StreamSignal } from '../../../src/core/pty/stream-status.js';

const now = Date.parse('2026-11-23T12:00:00Z');
const ago = (ms: number) => new Date(now - ms).toISOString();
const program = (r: Omit<ProgramRecord, 'id'>, since = ago(60_000)): StreamSignal => ({ program: { id: '', ...r, since } });
const out = (signal: StreamSignal | undefined, lastMsAgo: number, tool = 'codex') => ({
  tool,
  lastOutputAt: ago(lastMsAgo),
  startedAt: ago(3_600_000),
  ...(signal ? { signal } : {}),
});

describe('statusFromOutput: what the agent says beats the output guess', () => {
  it('OSC 7501: working, blocked (needs you), done / error / idle (idle, seen)', () => {
    expect(statusFromOutput(out(program({ state: 'working', progress: 40 }), OUTPUT_WORKING_MS * 3), now)).toMatchObject({
      state: 'working', // quiet, so the guess would say idle
      seen: true,
      progress: 40,
      since: ago(60_000),
      summary: 'Working, 40% — codex says so in its terminal',
    });
    expect(statusFromOutput(out(program({ state: 'blocked', kind: 'permission' }), 0), now)).toMatchObject({
      state: 'needs_input', // it just printed, so the guess would say working
      seen: false,
      summary: 'Waiting for your permission — codex says so in its terminal',
    });
    expect(statusFromOutput(out(program({ state: 'blocked', message: 'Allow bash: npm test?' }), 0), now)?.summary).toBe(
      'Allow bash: npm test?',
    );
    for (const state of ['done', 'error', 'idle'] as const) {
      expect(statusFromOutput(out(program({ state }), 0), now)).toMatchObject({ state: 'idle', seen: true, stale: false });
    }
  });

  it('OSC 9;4: a bar with a percent or indeterminate is working; error, paused or none leave it to the guess', () => {
    const bar = (state: 1 | 2 | 3 | 4, percent: number): StreamSignal => ({ progress: { state, percent, since: ago(1_000) } });
    expect(statusFromOutput(out(bar(1, 70), OUTPUT_WORKING_MS * 3), now)).toMatchObject({ state: 'working', progress: 70 });
    expect(statusFromOutput(out(bar(3, 70), OUTPUT_WORKING_MS * 3), now)).toMatchObject({ state: 'working' });
    expect(statusFromOutput(out(bar(3, 70), OUTPUT_WORKING_MS * 3), now)?.progress).toBeUndefined();
    expect(statusFromOutput(out(bar(2, 70), OUTPUT_WORKING_MS * 3), now)).toMatchObject({
      state: 'idle',
      summary: expect.stringMatching(/^Quiet/),
    });
    expect(statusFromOutput(out(bar(4, 70), 0), now)).toMatchObject({ state: 'working', summary: expect.stringMatching(/^Printing/) });
  });

  it('a stale "working" expires: no output for STALE_WORKING_MS shows it idle and stale; any output keeps it', () => {
    expect(statusFromOutput(out(program({ state: 'working' }), STALE_WORKING_MS - 1), now)?.state).toBe('working');
    expect(statusFromOutput(out(program({ state: 'working' }), STALE_WORKING_MS + 1), now)).toMatchObject({
      state: 'idle',
      seen: true,
      stale: true,
      summary: 'Said it was working, then printed nothing for 15 min — codex says so in its terminal',
    });
    const bar: StreamSignal = { progress: { state: 3, percent: 0, since: ago(STALE_WORKING_MS * 2) } };
    expect(statusFromOutput(out(bar, STALE_WORKING_MS + 1), now)).toMatchObject({ state: 'idle', stale: true });
  });

  it('a blocked kind this build does not know (a host of another build said it) waits for "you"', () => {
    const unknownKind = { program: { id: '', state: 'blocked', kind: 'telepathy', since: ago(60_000) } } as unknown as StreamSignal;
    expect(statusFromOutput(out(unknownKind, 0), now)?.summary).toBe('Waiting for you — codex says so in its terminal');
  });

  it('blocked never expires: waiting on you is quiet', () => {
    expect(statusFromOutput(out(program({ state: 'blocked' }), STALE_WORKING_MS * 10), now)).toMatchObject({
      state: 'needs_input',
      stale: false,
    });
  });

  it('still nothing for Claude (its hooks report), and no signal is the guess as before', () => {
    expect(statusFromOutput(out(program({ state: 'blocked' }), 0, 'claude'), now)).toBeNull();
    expect(statusFromOutput(out(undefined, 0), now)?.summary).toBe('Printing — from its terminal output (codex has no status hooks)');
  });

  it("a state from a newer host this build doesn't know says nothing", () => {
    const odd = { program: { id: '', state: 'sleeping', since: ago(0) } } as unknown as StreamSignal;
    expect(statusFromSignal(odd, 'codex', ago(0), now)).toBeNull();
  });
});
