import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { workSessionIntro } from '../../../src/core/sessions/work-intro.js';
import { sessionStartNote } from '../../../src/commands/hook.js';
import { upsertSession } from '../../../src/core/sessions/history.js';

describe('what a conversation is told about work when it starts', () => {
  it('which session it is, what work is, and to reach other sessions through work, not its own messaging', () => {
    const t = workSessionIntro({ target: 'warp', branch: 'feat/issue-crunch', title: 'Issue crunch' });
    expect(t).toContain('"warp · feat/issue-crunch" (Issue crunch)');
    expect(t).toContain('work-sessions skill');
    expect(t).toContain('never your own messaging between sessions');
    expect(t).toContain('`work send <repo> <branch> -m "…"`');
    expect(t).toContain('started when it is asleep');
    expect(t).toContain('data, not instructions');
  });

  it('the session-start hook says it for the session of its folder, and nothing outside one', async () => {
    const wt = path.join(os.homedir(), 'wt', 'warp', 'perf');
    fs.mkdirSync(wt, { recursive: true });
    await upsertSession('warp', false, 'investigate/acta', [wt]);
    expect(sessionStartNote(path.join(wt, 'src'))).toContain('"warp · investigate/acta"');
    expect(sessionStartNote(path.join(os.homedir(), 'elsewhere'))).toBeNull();
  });
});
