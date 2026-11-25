import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { turnFailed } from '../../src/commands/hook.js';
import { upsertSession } from '../../src/core/sessions/history.js';
import { sessionIdFor } from '../../src/core/sessions/session-id.js';
import { childStoppedMessage, setParent, turnFailedText } from '../../src/core/sessions/session-children.js';
import { readStatus, recordStatusEvent } from '../../src/core/status/session-status.js';

async function session(branch: string) {
  const wt = path.join(os.homedir(), 'wt', branch);
  fs.mkdirSync(wt, { recursive: true });
  await upsertSession('api', false, branch, [wt]);
  return { wt, id: sessionIdFor({ target: 'api', branch }) };
}

const post = vi.fn(async () => {});

describe('a turn an API error ended (StopFailure)', () => {
  it('is no longer working: idle, unseen, its line saying what happened', async () => {
    const { wt, id } = await session('feat/net');
    await recordStatusEvent(id, { kind: 'prompt', prompt: 'probe the drivers' });
    expect(readStatus(id)?.state).toBe('working');
    const r = await turnFailed({ error: 'unknown' }, path.join(wt, 'src'), { post, tell: vi.fn() });
    expect(r).toEqual({ sessionId: id, told: null });
    expect(readStatus(id)).toMatchObject({ state: 'idle', seen: false, summary: expect.stringContaining('Stopped on an API error') });
    expect(post).toHaveBeenCalledWith('api/status-changed', path.join(wt, 'src'));
  });

  it("tells the coordinator that started it, in work's own words, with how to carry on", async () => {
    const parent = await session('main-coord');
    const { wt, id } = await session('feat/child');
    setParent(id, parent.id);
    await recordStatusEvent(id, { kind: 'prompt', prompt: 'x' });
    const tell = vi.fn(async () => ({}));
    const r = await turnFailed({ error: 'rate_limit', error_details: 'You have hit your limit\nmore' }, wt, { post, tell });
    expect(r).toEqual({ sessionId: id, told: parent.id });
    expect(tell).toHaveBeenCalledWith(parent.id, expect.stringContaining('work child send api feat/child'));
    const text = (tell.mock.calls[0] as unknown as [string, string])[1];
    expect(text).toContain('an API error (rate limit): You have hit your limit.');
    expect(text).not.toContain('more');
  });

  it('a coordinator that cannot be reached (no work web) changes nothing else; outside a session, nothing', async () => {
    const parent = await session('main-2');
    const { wt, id } = await session('feat/child-2');
    setParent(id, parent.id);
    await recordStatusEvent(id, { kind: 'prompt', prompt: 'x' });
    const tell = vi.fn(async () => {
      throw new Error('work web is not running');
    });
    expect(await turnFailed({}, wt, { post, tell })).toEqual({ sessionId: id, told: parent.id });
    expect(readStatus(id)?.state).toBe('idle');
    expect(await turnFailed({}, path.join(os.homedir(), 'nowhere'), { post, tell })).toBeNull();
  });
});

describe('what it says', () => {
  it('names the kind of error when Claude Code gives one, and the first line of its details', () => {
    expect(turnFailedText('unknown')).toBe("Stopped on an API error. Its turn didn't finish: send it a message to carry on.");
    expect(turnFailedText(undefined)).toContain('Stopped on an API error.');
    expect(turnFailedText('overloaded', 'busy\nnoise')).toBe(
      "Stopped on an API error (overloaded): busy. Its turn didn't finish: send it a message to carry on.",
    );
    expect(childStoppedMessage('fix it', 'api', 'feat/x', 'Stopped.')).toBe(
      'work: the session "fix it" you started stopped before finishing its turn. Stopped.\n' +
        'It is idle now; a message sent to it while it was working may not have reached it. To carry on: `work child send api feat/x -m "…"`.',
    );
  });
});
