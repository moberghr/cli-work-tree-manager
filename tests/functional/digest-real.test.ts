import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { upsertSession } from '../../src/core/history.js';
import { sessionIdFor } from '../../src/core/session-id.js';
import { encodeProjectDir } from '../../src/core/agents/claude/activity.js';
import { disposeAllScopes } from '../../src/core/scope-manager.js';
import { startWebServer, type WebServerHandle } from '../../src/core/web-server.js';
import type { DigestResponse } from '../../src/core/api-types.js';

/** GET /api/digest against the real server and real transcript files. */

let home: string;
let wt: string;
let server: WebServerHandle;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-real-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  wt = path.join(home, 'wt', 'api', 'feat-x');
  fs.mkdirSync(wt, { recursive: true });
  await upsertSession('api', false, 'feat/x', [wt]);
  server = await startWebServer({ lean: true });
}, 60_000);
afterEach(async () => {
  await server.stop();
  disposeAllScopes();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const transcript = (name: string, lines: object[], mtime?: Date) => {
  const dir = path.join(home, '.claude', 'projects', encodeProjectDir(wt));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (mtime) fs.utimesSync(file, mtime, mtime);
};
const digest = async (since?: string) => {
  const res = await fetch(server.url.replace(/\/$/, '') + '/api/digest' + (since ? `?since=${encodeURIComponent(since)}` : ''));
  expect(res.status).toBe(200);
  return (await res.json()) as DigestResponse;
};

describe('GET /api/digest', () => {
  it("lists what you asked each session in the window, from its transcripts", async () => {
    const now = Date.now();
    const iso = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();
    transcript('today.jsonl', [
      { type: 'user', timestamp: iso(90), message: { content: 'Add the CSV export' } },
      { type: 'assistant', timestamp: iso(89), message: { content: [{ type: 'text', text: 'Done.' }] } },
      { type: 'user', timestamp: iso(30), message: { content: 'Now quote commas' } },
    ]);
    // Last week's conversation: its file wasn't touched in the window, never read.
    transcript('old.jsonl', [{ type: 'user', timestamp: iso(60 * 24 * 7), message: { content: 'ancient' } }], new Date(now - 7 * 86_400_000));

    const d = await digest(iso(120));
    expect(d.sessions).toHaveLength(1);
    expect(d.sessions[0]).toMatchObject({ sessionId: sessionIdFor({ target: 'api', branch: 'feat/x' }), target: 'api', branch: 'feat/x' });
    expect(d.sessions[0].prompts.map((p) => p.text)).toEqual(['Add the CSV export', 'Now quote commas']);

    const narrow = await digest(iso(60));
    expect(narrow.sessions[0].prompts.map((p) => p.text)).toEqual(['Now quote commas']);
  });

  it("a busy day's morning is not cut off by a transcript that grew past a fixed tail", async () => {
    const now = Date.now();
    const iso = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();
    // First the morning prompt, then ~3 MB of tool results (the bulk of any
    // real transcript), then an afternoon prompt.
    const filler = 'x'.repeat(30_000);
    const lines: object[] = [{ type: 'user', timestamp: iso(400), uuid: 'morning', message: { content: 'Start on the export' } }];
    for (let i = 0; i < 100; i++) {
      lines.push({ type: 'user', timestamp: iso(390 - i), message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: filler }] } });
    }
    lines.push({ type: 'user', timestamp: iso(30), uuid: 'afternoon', message: { content: 'Now the tests' } });
    transcript('busy.jsonl', lines);
    const d = await digest(iso(480));
    expect(d.sessions[0].prompts.map((p) => p.text)).toEqual(['Start on the export', 'Now the tests']);
    expect(d.sessions[0].partial).toBeUndefined();
  }, 30_000);

  it('defaults to the last 24 hours and never reaches back more than two weeks', async () => {
    const now = Date.now();
    const def = await digest();
    expect(Math.abs(Date.parse(def.since) - (now - 86_400_000))).toBeLessThan(60_000);
    const far = await digest(new Date(now - 90 * 86_400_000).toISOString());
    expect(Math.abs(Date.parse(far.since) - (now - 14 * 86_400_000))).toBeLessThan(60_000);
    expect(def.sessions).toEqual([]); // nothing happened
  });
});
