import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { whenStarted } from '../../../src/core/platform/started.js';
import { notOnPath, programPath } from '../../../src/core/platform/program-path.js';

describe('whenStarted: a start answered only once it is known', () => {
  it('null once the child started; a later error is swallowed, never thrown or answered', async () => {
    const child = new EventEmitter();
    const started = whenStarted(child as never);
    child.emit('spawn');
    child.emit('error', new Error('later'));
    expect(await started).toBeNull();
  });

  it("the reason when it couldn't start, in the program's own name for one not on PATH", async () => {
    const child = new EventEmitter();
    const started = whenStarted(child as never);
    child.emit('error', Object.assign(new Error(`spawn ${notOnPath('wt.exe')} ENOENT`), { code: 'ENOENT' }));
    child.emit('spawn');
    expect(await started).toBe('wt.exe not found on PATH');
  });

  it('a real start of a program PATH lacks, and of one it has', async () => {
    const missing = spawn(programPath('work-no-such-terminal', { ...process.env, PATH: '' }), [], { stdio: 'ignore', windowsHide: true });
    expect(await whenStarted(missing)).toMatch(/work-no-such-terminal|ENOENT/);
    const node = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
    expect(await whenStarted(node)).toBeNull();
  });
});
