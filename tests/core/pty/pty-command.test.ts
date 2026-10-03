import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { resolvePtyCommand } from '../../../src/core/pty/pty-session.js';

const SHIM = path.resolve(__dirname, '../../functional/fixtures/echo-ai.cmd');

describe('resolvePtyCommand', () => {
  it.skipIf(process.platform === 'win32')('passes argv straight through off Windows', () => {
    expect(resolvePtyCommand('claude', ['a & b'])).toEqual({ file: 'claude', args: ['a & b'] });
  });

  it.runIf(process.platform === 'win32')('runs a real .exe directly — no cmd.exe in between', () => {
    const r = resolvePtyCommand(process.execPath, ['-e', '1 & 2']);
    expect(path.basename(r.file).toLowerCase()).toBe('node.exe');
    expect(r.args).toEqual(['-e', '1 & 2']);
  });

  it.runIf(process.platform === 'win32')('caret-escapes cmd metacharacters for a .cmd shim', () => {
    const r = resolvePtyCommand(SHIM, ['fix it & echo INJECTED | more %PATH% ^ "q"']);
    expect(path.basename(r.file).toLowerCase()).toBe('cmd.exe');
    expect(typeof r.args).toBe('string'); // verbatim command line for node-pty
    const line = r.args as string;
    expect(line.startsWith('/d /s /c "')).toBe(true);
    // Every metacharacter is escaped; none is left bare for cmd to act on.
    expect(line).toContain('^&');
    expect(line).toContain('^|');
    expect(line).toContain('^%PATH^%');
    expect(line).not.toMatch(/[^^]&/);
    expect(line).not.toMatch(/[^^]\|/);
  });
});
