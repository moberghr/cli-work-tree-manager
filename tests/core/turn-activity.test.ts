import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeProjectsRoot, encodeProjectDir } from '../../src/core/agents/claude/activity.js';
import { sessionStatusView } from '../../src/core/turn-activity.js';
import * as transcript from '../../src/core/jsonl.js';
import type { SessionStatus } from '../../src/core/session-status.js';
import type { WorktreeSession } from '../../src/core/history.js';

let tmp: string;
let file: string;
let session: WorktreeSession;
const line = (o: object) => JSON.stringify(o) + '\n';
const ENDED = '2026-10-01T08:43:01.000Z';
const idle: SessionStatus = { state: 'idle', since: ENDED, seen: true, updatedAt: ENDED, turnEndedAt: ENDED };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-activity-'));
  session = { target: 'api', branch: 'fix/pdf', isGroup: false, paths: [path.join(tmp, 'wt')], createdAt: '', lastAccessedAt: '' } as WorktreeSession;
  const dir = path.join(claudeProjectsRoot(), encodeProjectDir(session.paths[0]));
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, 'c.jsonl');
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('sessionStatusView', () => {
  it('idle by the hooks, but your `!` command after the turn ended: working', () => {
    fs.writeFileSync(file, line({ type: 'assistant', timestamp: '2026-10-01T08:43:00Z', message: { content: 'done' } }) + line({ type: 'user', timestamp: '2026-10-01T08:50:00Z', message: { content: '<bash-input>dotnet publish</bash-input>' } }));
    const now = Date.parse('2026-10-01T08:50:30Z');
    expect(sessionStatusView(idle, session, Date.parse('2026-10-01T08:50:00Z'), now).state).toBe('working');
  });

  it("only Claude Code's own lines after the turn (away summary): still idle", () => {
    fs.writeFileSync(file, line({ type: 'assistant', timestamp: '2026-10-01T08:43:00Z', message: { content: 'done' } }) + line({ type: 'system', subtype: 'away_summary', timestamp: '2026-10-01T08:49:45Z' }));
    const now = Date.parse('2026-10-01T08:50:00Z');
    expect(sessionStatusView(idle, session, Date.parse('2026-10-01T08:49:45Z'), now).state).toBe('idle');
  });

  it("reads the transcript only when it was written after the turn ended, and once per change", () => {
    fs.writeFileSync(file, line({ type: 'user', timestamp: '2026-10-01T08:50:00Z', message: { content: 'hi' } }));
    const read = vi.spyOn(transcript, 'readJsonlTail');
    const now = Date.parse('2026-10-01T08:50:30Z');
    sessionStatusView(idle, session, Date.parse(ENDED) + 1000, now); // written right at the end of the turn: no read
    expect(read).not.toHaveBeenCalled();
    sessionStatusView(idle, session, Date.parse('2026-10-01T08:50:00Z'), now);
    sessionStatusView(idle, session, Date.parse('2026-10-01T08:50:00Z'), now);
    expect(read).toHaveBeenCalledTimes(1);
    sessionStatusView({ ...idle, state: 'working' }, session, Date.parse('2026-10-01T08:50:00Z'), now); // not idle: no read
    expect(read).toHaveBeenCalledTimes(1);
  });
});
