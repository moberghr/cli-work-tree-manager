import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeSteps, STEP_CAP_MS, workedBetween, workedByDay, workSteps } from '../../src/core/work-time.js';
import { dayKey, formatWorked, worklogTime } from '../../src/core/work-time-view.js';
import { resetWorkTimeCache, sessionWorkTime } from '../../src/core/work-time-source.js';
import { encodeProjectDir } from '../../src/core/claude-activity.js';
import { digestSession, type DigestInput } from '../../src/core/digest.js';
import { digestMarkdown } from '../../src/core/digest-view.js';
import type { TranscriptEntry } from '../../src/core/transcript-entry.js';
import { claudeEntries } from '../../src/core/agents/claude-entries.js';
import type { WorktreeSession } from '../../src/core/session-types.js';

const T0 = Date.parse('2026-09-30T09:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
/** Claude's lines as its adapter reads them. */
const cl = (lines: TranscriptEntry[]) => claudeEntries(lines);
const you = (min: number, text = 'do it'): TranscriptEntry => ({ type: 'user', timestamp: at(min), message: { role: 'user', content: text } });
const claude = (min: number): TranscriptEntry => ({ type: 'assistant', timestamp: at(min), message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
const toolResult = (min: number): TranscriptEntry => ({ type: 'user', timestamp: at(min), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't' }] } });

describe('workSteps', () => {
  it("counts the time up to each of Claude's lines (its replies, tool results) — not yours", () => {
    // You ask at 0; Claude works 0→2 (reply), a tool runs 2→5; you read for 20 minutes; ask again; Claude 25→26.
    const { steps } = workSteps(cl([you(0), claude(2), toolResult(5), claude(6), you(26), claude(27)]));
    expect(workedBetween(steps)).toBe((2 + 3 + 1 + 1) * 60_000);
  });

  it('a step counts for at most 15 minutes (a permission prompt left all afternoon is no work)', () => {
    const { steps } = workSteps(cl([you(0), claude(1), toolResult(180)]));
    expect(workedBetween(steps)).toBe(60_000 + STEP_CAP_MS);
  });

  it('continues across reads of one file, and never counts backwards (lines a little out of order)', () => {
    const a = workSteps(cl([you(0), claude(3)]));
    const b = workSteps(cl([claude(2), claude(5)]), a.lastMs);
    expect(workedBetween([...a.steps, ...b.steps])).toBe((3 + 2) * 60_000); // 2 is before 3: nothing; 3→5
  });

  it('two transcripts working at the same time count that time once', () => {
    const a = workSteps(cl([you(0), claude(10)])).steps; // 0→10
    const b = workSteps(cl([you(5), claude(15)])).steps; // 5→15, overlapping 5→10
    expect(workedBetween(mergeSteps([...a, ...b]))).toBe(15 * 60_000);
    expect(workedBetween(mergeSteps([...a, ...workSteps(cl([you(20), claude(22)])).steps]))).toBe(12 * 60_000);
  });

  it('per window and per day', () => {
    const { steps } = workSteps(cl([you(0), claude(10), you(60 * 24), claude(60 * 24 + 5)]));
    expect(workedBetween(steps, T0 + 60 * 60_000)).toBe(5 * 60_000);
    expect(workedByDay(steps)).toEqual([
      { day: dayKey(T0 + (60 * 24 + 5) * 60_000), ms: 5 * 60_000 },
      { day: dayKey(T0 + 10 * 60_000), ms: 10 * 60_000 },
    ]);
  });
});

describe('in words', () => {
  it('formatWorked and the worklog notation (rounded up to a quarter hour)', () => {
    expect(formatWorked(20_000)).toBe('<1m');
    expect(formatWorked(45 * 60_000)).toBe('45m');
    expect(formatWorked(65 * 60_000)).toBe('1h 05m');
    expect(worklogTime(1)).toBe('15m');
    expect(worklogTime(61 * 60_000)).toBe('1h 15m');
    expect(worklogTime(120 * 60_000)).toBe('2h');
  });
});

describe('sessionWorkTime (its transcripts on disk)', () => {
  let home: string;
  let wt: string;
  let file: string;
  const session = (): WorktreeSession => ({ target: 'api', branch: 'feat/x', isGroup: false, paths: [wt], createdAt: at(0), lastAccessedAt: at(0) });
  beforeEach(() => {
    resetWorkTimeCache();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'work-time-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    wt = path.join(home, 'wt', 'api');
    fs.mkdirSync(wt, { recursive: true });
    const dir = path.join(home, '.claude', 'projects', encodeProjectDir(wt));
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'conv.jsonl');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const line = (e: TranscriptEntry) => JSON.stringify(e) + '\n';

  it('adds up, follows the file as it grows (a half-written last line waits), and starts over when it is rewritten', async () => {
    fs.writeFileSync(file, line(you(0, 'héllo — ünïcode')) + line(claude(4)));
    const now = T0 + 60 * 60_000;
    expect(await sessionWorkTime(session(), now)).toMatchObject({ workedMs: 4 * 60_000, prompts: 1, firstAt: at(0), lastAt: at(4) });

    // Claude Code is mid-write: the last line has no newline yet.
    const next = line(toolResult(6));
    fs.appendFileSync(file, next.slice(0, 20));
    expect((await sessionWorkTime(session(), now)).workedMs).toBe(4 * 60_000);
    fs.appendFileSync(file, next.slice(20) + line(you(30)) + line(claude(31)));
    expect(await sessionWorkTime(session(), now)).toMatchObject({ workedMs: (4 + 2 + 1) * 60_000, prompts: 2 });

    fs.writeFileSync(file, line(you(0)) + line(claude(1))); // rewritten, shorter
    expect((await sessionWorkTime(session(), now)).workedMs).toBe(60_000);
  });

  it('a rewrite of the same size (or a longer one with another start) is read again, not taken for an append', async () => {
    const now = T0 + 120 * 60_000;
    fs.writeFileSync(file, line(you(0)) + line(claude(5)));
    expect((await sessionWorkTime(session(), now)).workedMs).toBe(5 * 60_000);
    const same = line(you(0)) + line(claude(9)); // same length, other content
    expect(Buffer.byteLength(same)).toBe(fs.statSync(file).size);
    fs.writeFileSync(file, same);
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    expect((await sessionWorkTime(session(), now)).workedMs).toBe(9 * 60_000);
    fs.writeFileSync(file, line(you(1, 'another conversation')) + line(claude(3)) + line(claude(40)));
    expect((await sessionWorkTime(session(), now)).workedMs).toBe((2 + 15) * 60_000);
  });

  it('GET /api/sessions/:id/time', async () => {
    const { Hono } = await import('hono');
    const { saveHistory } = await import('../../src/core/history.js');
    const { sessionIdFor } = await import('../../src/core/session-id.js');
    const { mountCatchUpRoutes } = await import('../../src/core/catch-up-routes.js');
    fs.writeFileSync(file, line(you(0)) + line(claude(7)));
    saveHistory([session()]);
    const app = new Hono();
    mountCatchUpRoutes(app, { ask: async () => null });
    expect(await (await app.request(`/api/sessions/${sessionIdFor(session())}/time`)).json()).toMatchObject({ workedMs: 7 * 60_000, prompts: 1 });
    expect((await app.request('/api/sessions/nope/time')).status).toBe(404);
  });

  it('no transcripts: nothing', async () => {
    fs.rmSync(file, { force: true });
    expect(await sessionWorkTime(session())).toMatchObject({ workedMs: 0, prompts: 0, byDay: [], firstAt: null });
  });
});

describe('the digest', () => {
  it('says how long its Claude worked in the window, per session and in all', () => {
    const input: DigestInput = {
      sessionId: 's1', target: 'api', branch: 'feat/x', isGroup: false, lastAccessedAt: at(0), archivedAt: null, status: null,
      transcripts: [cl([you(0)])], checkpoints: [], diffStat: null, ci: null,
      work: [workSteps(cl([you(0), claude(10), you(50), claude(75)])).steps], // 10m, then 25m capped at 15
    };
    const row = digestSession(input, T0)!;
    expect(row.workedMs).toBe((10 + 15) * 60_000);
    const md = digestMarkdown({ since: at(0), generatedAt: at(90), sessions: [row] }, 'Today');
    expect(md).toContain('~25m of Claude work');
    expect(digestSession({ ...input, work: [] }, T0)).not.toHaveProperty('workedMs');
  });
});
