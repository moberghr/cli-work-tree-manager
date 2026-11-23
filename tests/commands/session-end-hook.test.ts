import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sessionEnded } from '../../src/commands/hook.js';
import { upsertSession } from '../../src/core/sessions/history.js';
import { sessionIdFor } from '../../src/core/sessions/session-id.js';
import { agentEnded, readStatus, recordStatusEvent } from '../../src/core/status/session-status.js';

async function session(branch: string) {
  const wt = path.join(os.homedir(), 'wt', branch);
  fs.mkdirSync(wt, { recursive: true });
  await upsertSession('api', false, branch, [wt]);
  return { wt, id: sessionIdFor({ target: 'api', branch }) };
}

describe('its agent exits (SessionEnd)', () => {
  it('quit mid-turn: no longer working — idle, nothing to look at, and recorded as stopped', async () => {
    const { wt, id } = await session('feat/quit');
    await recordStatusEvent(id, { kind: 'prompt', prompt: 'refactor' });
    expect(readStatus(id)?.state).toBe('working');
    const at = new Date('2026-11-23T12:00:00Z');
    expect(await sessionEnded(path.join(wt, 'src'), 'prompt_input_exit', at)).toBe(true);
    expect(readStatus(id)).toMatchObject({ state: 'idle', seen: true, since: at.toISOString(), stoppedAt: at.toISOString() });
  });

  it('a turn already over keeps its state (and its unseen finish), only marked stopped', async () => {
    const { wt, id } = await session('feat/done');
    await recordStatusEvent(id, { kind: 'prompt', prompt: 'x' });
    await recordStatusEvent(id, { kind: 'stop' });
    const before = readStatus(id)!;
    await sessionEnded(wt, 'other');
    expect(readStatus(id)).toMatchObject({ state: before.state, seen: before.seen });
    expect(readStatus(id)?.stoppedAt).toBeDefined();
  });

  it('/clear and /resume end a conversation, not the agent: nothing changes; outside a session, nothing', async () => {
    const { wt, id } = await session('feat/clear');
    await recordStatusEvent(id, { kind: 'prompt', prompt: 'x' });
    expect(await sessionEnded(wt, 'clear')).toBe(false);
    expect(await sessionEnded(wt, 'resume')).toBe(false);
    expect(readStatus(id)?.state).toBe('working');
    expect(await sessionEnded(path.join(os.homedir(), 'nowhere'), 'other')).toBe(false);
    expect([agentEnded('logout'), agentEnded(undefined), agentEnded('clear')]).toEqual([true, true, false]);
  });
});
