import { describe, expect, it } from 'vitest';
import { PARENT_SESSION_VARS, withoutParentSession } from '../../src/core/claude-env.js';
import { PtySession } from '../../src/tui/session.js';

describe('withoutParentSession', () => {
  it("drops the parent Claude session's markers and keeps everything else", () => {
    const env = {
      PATH: '/bin',
      CLAUDE_CONFIG_DIR: '/cfg',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
      CLAUDECODE: '1',
      claude_pid: '42', // Windows env names are case-insensitive
    };
    expect(withoutParentSession(env)).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_CODE_USE_BEDROCK: '1' });
  });

  it('a process the PTY host starts never inherits them (e.g. the host itself was started from inside a Claude)', async () => {
    const saved = Object.fromEntries(PARENT_SESSION_VARS.map((k) => [k, process.env[k]]));
    for (const k of PARENT_SESSION_VARS) process.env[k] = 'x';
    let s: PtySession | undefined;
    try {
      const script = `process.stdout.write('VARS=[' + ${JSON.stringify(PARENT_SESSION_VARS)}.filter((k) => process.env[k]).join(',') + ']')`;
      s = new PtySession(process.cwd(), 120, 30, { cmd: process.execPath, args: ['-e', script] });
      let out = '';
      await new Promise<void>((resolve) => {
        s!.setOutputHandler((d) => { out += d; if (out.includes(']')) resolve(); });
        setTimeout(resolve, 10_000);
      });
      expect(out).toContain('VARS=[]');
    } finally {
      s?.dispose();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }, 20_000);
});
