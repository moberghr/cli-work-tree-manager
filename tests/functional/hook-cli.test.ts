import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * `work hook <event>` through the BUILT binary, as Claude Code runs it: a
 * JSON payload on stdin, a 5 s timeout, several hooks per turn. Under a
 * throwaway HOME.
 */

const BIN = path.resolve(__dirname, '../../dist/bin.js');
const hasBuild = fs.existsSync(BIN);

let home: string;
let wt: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-cli-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  wt = path.join(home, 'wt', 'api', 'feat-x');
  fs.mkdirSync(wt, { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function hook(event: string, payload: unknown): Promise<{ code: number | null; stdout: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [BIN, 'hook', event], {
      env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    c.stdout.on('data', (d) => (stdout += d));
    c.on('error', reject);
    c.on('exit', (code) => resolve({ code, stdout, ms: Date.now() - started }));
    c.stdin.end(JSON.stringify(payload));
  });
}

describe.skipIf(!hasBuild)('work hook (built binary)', () => {
  it('records a permission prompt as "needs input", fast', async () => {
    const { upsertSession } = await import('../../src/core/history.js');
    const { sessionIdFor } = await import('../../src/core/session-id.js');
    const { readStatus } = await import('../../src/core/session-status.js');
    await upsertSession('api', false, 'feat/x', [wt]);

    const r = await hook('status-notify', { cwd: wt, message: 'Claude needs your permission to use Bash' });
    expect(r.code).toBe(0);
    expect(readStatus(sessionIdFor({ target: 'api', branch: 'feat/x' }))).toMatchObject({ state: 'needs_input' });
    // Well inside Claude's 5 s hook timeout (it used to idle 1 s on a
    // leftover stdin timer, after loading the whole CLI).
    expect(r.ms).toBeLessThan(3000);
  });

  it('a Stop with a pending review comment blocks the turn with it, and claims it', async () => {
    const { upsertSession } = await import('../../src/core/history.js');
    const { sessionIdFor } = await import('../../src/core/session-id.js');
    const { getCommentFileStore } = await import('../../src/core/comment-file-store.js');
    const { readPendingForSession } = await import('../../src/core/pending-delivery.js');
    await upsertSession('api', false, 'feat/x', [wt]);
    const id = sessionIdFor({ target: 'api', branch: 'feat/x' });
    getCommentFileStore(id).post({ side: 'general', status: 'published', body: 'please rename foo' });
    // The hook only delivers to a session Claude is active in: a fresh
    // transcript under ~/.claude/projects/<cwd with non-alphanumerics as ->.
    const project = path.join(home, '.claude', 'projects', path.resolve(wt).replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'transcript.jsonl'), '{}\n');

    const r = await hook('stop', { cwd: wt });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { decision: string; reason: string };
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('please rename foo');
    expect(readPendingForSession(id)).toEqual([]); // claimed: not sent again

    const again = await hook('stop', { cwd: wt });
    expect(again.stdout).toBe('');
  });

  it("assistant-context prints what the dashboard shows (Claude adds it to the prompt), and nothing when stale", async () => {
    const { writeAssistantContext } = await import('../../src/core/assistant.js');
    writeAssistantContext('The user is looking at the cleanup tab.');
    const r = await hook('assistant-context', { prompt: 'clean these up' });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('[work dashboard] The user is looking at the cleanup tab.');
    writeAssistantContext('old', Date.now() - 2 * 3_600_000);
    expect((await hook('assistant-context', {})).stdout).toBe('');
  });

  it('an unknown event, or no payload at all, is a quiet no-op', async () => {
    expect((await hook('not-an-event', {})).code).toBe(0);
    expect((await hook('status-stop', 'not json')).code).toBe(0);
  });
});
