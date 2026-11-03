import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PtySession, resolvePtyCommand, startsAsBatch } from '../../../src/core/pty/pty-session.js';
import type { AiToolSpec } from '../../../src/core/platform/ai-launcher.js';

const SHIM = path.resolve(__dirname, '../../functional/fixtures/echo-ai.cmd');
const ECHO_AI = path.resolve(__dirname, '../../functional/fixtures/echo-ai.cjs');
const win = process.platform === 'win32';

/** A prompt cmd.exe would act on: quotes, `&`, `|`, `%VAR%`, `^`, and line breaks that would cut it. */
const NASTY = 'Work on PAY-1: x"&echo INJECTED&"\nsecond line | more %PATH% ^ (a) <b> !c!\nthird "quoted" line';

describe('resolvePtyCommand', () => {
  it.skipIf(win)('passes argv straight through off Windows', () => {
    expect(resolvePtyCommand('claude', ['a & b'])).toEqual({ file: 'claude', args: ['a & b'] });
    expect(startsAsBatch('claude')).toBe(false);
  });

  it.runIf(win)('runs a real .exe directly — no cmd.exe in between', () => {
    const r = resolvePtyCommand(process.execPath, ['-e', '1 & 2']);
    expect(path.basename(r.file).toLowerCase()).toBe('node.exe');
    expect(r.args).toEqual(['-e', '1 & 2']);
  });

  it.runIf(win)('a batch file that starts a Node script (npm shims) runs node on the script: the prompt is plain argv', () => {
    const r = resolvePtyCommand(SHIM, [NASTY]);
    expect(path.basename(r.file).toLowerCase()).toBe('node.exe');
    expect(r.args).toEqual([ECHO_AI, NASTY]);
    expect(startsAsBatch(SHIM)).toBe(false);
  });
});

describe.runIf(win)('resolvePtyCommand with batch files on PATH and in the working folder (Windows)', () => {
  let bin: string;
  let cwd: string;
  beforeEach(() => {
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-bin-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-cwd-'));
    fs.writeFileSync(path.join(bin, 'plainagent.cmd'), '@echo ARGS: %*\r\n');
    fs.writeFileSync(path.join(cwd, 'cwdagent.cmd'), '@echo CWD > "%~dp0marker.txt"\r\n');
  });
  afterEach(() => {
    fs.rmSync(bin, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  });
  const env = () => ({ ...process.env, PATH: `${bin};.;${process.env.PATH ?? ''}` });

  it('another batch file goes through cmd.exe, and only with arguments cmd.exe would leave alone', () => {
    const r = resolvePtyCommand('plainagent', ['--continue', 'fix it'], { env: env(), cwd });
    expect(path.basename(r.file).toLowerCase()).toBe('cmd.exe');
    expect(r.args as string).toContain(path.join(bin, 'plainagent.cmd'));
    expect(startsAsBatch('plainagent', env())).toBe(true);
    expect(() => resolvePtyCommand('plainagent', [NASTY], { env: env(), cwd })).toThrow(/refused: an argument has/);
  });

  it("a program only the working folder has isn't started: it isn't on PATH", () => {
    expect(() => resolvePtyCommand('cwdagent', [], { env: env(), cwd })).toThrow(/isn't on PATH/);
  });
});

// The real thing: a PTY session of an agent installed by npm (claude.cmd, npm's own shim) gets its first prompt
// intact — every line, quote, & and % — and nothing else runs; a batch-file agent that isn't a Node shim gets it
// typed in once it's up, never on cmd.exe's command line. Echo-only files, a marker each.
describe.runIf(win)('the first prompt reaches a batch-file agent intact (Windows, real PTY)', () => {
  let bin: string;
  let cwd: string;
  let session: PtySession | undefined;
  beforeEach(() => {
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-agent-bin-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-agent-cwd-'));
  });
  afterEach(async () => {
    const s = session;
    session = undefined;
    if (s && !s.exited) {
      const gone = new Promise<void>((resolve) => {
        s.onExit = () => resolve();
        setTimeout(resolve, 10_000);
      });
      s.dispose();
      await gone;
    } else s?.dispose();
    // The terminal's console keeps the folder in use a moment after its process ended.
    for (const dir of [bin, cwd]) {
      for (let i = 0; ; i++) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          break;
        } catch (err) {
          if (i >= 50) throw err;
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    }
  }, 30_000);

  const tool = (cmd: string): AiToolSpec => ({ cmd, baseArgs: [] }) as unknown as AiToolSpec;
  const env = () =>
    Object.fromEntries(
      Object.entries({ ...process.env, PATH: `${bin};${process.env.PATH ?? ''}` }).filter((e): e is [string, string] => e[1] != null),
    );
  const waitFor = async (check: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    return check();
  };

  it("npm's claude.cmd: node runs the script with the prompt as one argument", async () => {
    const pkg = path.join(bin, 'node_modules', '@anthropic-ai', 'claude-code');
    fs.mkdirSync(pkg, { recursive: true });
    const marker = path.join(cwd, 'argv.json');
    fs.writeFileSync(
      path.join(pkg, 'cli.js'),
      `require('fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2))); setTimeout(() => {}, 500);`,
    );
    fs.writeFileSync(
      path.join(bin, 'claude.cmd'),
      [
        '@ECHO off',
        'GOTO start',
        ':find_dp0',
        'SET dp0=%~dp0',
        'EXIT /b',
        ':start',
        'SETLOCAL',
        'CALL :find_dp0',
        'IF EXIST "%dp0%\\node.exe" (',
        '  SET "_prog=%dp0%\\node.exe"',
        ') ELSE (',
        '  SET "_prog=node"',
        ')',
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
      ].join('\r\n'),
    );
    session = new PtySession(cwd, 120, 30, undefined, { tool: tool('claude'), initialPrompt: NASTY, env: env() });
    expect(await waitFor(() => fs.existsSync(marker), 15_000)).toBe(true);
    expect(JSON.parse(fs.readFileSync(marker, 'utf8'))).toEqual([NASTY]);
  }, 30_000);

  it('another batch-file agent: the prompt is typed in once it is up, not given to cmd.exe', async () => {
    const reader = path.join(bin, 'reader.cjs');
    const typed = path.join(cwd, 'typed.txt');
    fs.writeFileSync(
      reader,
      [
        "process.stdout.write('agent ready\\r\\n');",
        "let buf = '';",
        "process.stdin.on('data', (d) => {",
        '  buf += d;',
        `  if (/[\\r\\n]/.test(buf)) { require('fs').writeFileSync(${JSON.stringify(typed)}, buf); process.exit(0); }`,
        '});',
      ].join('\n'),
    );
    // Not a Node shim (no %* after the script): cmd.exe runs it. It records its own arguments, then reads a line.
    fs.writeFileSync(
      path.join(bin, 'batchagent.cmd'),
      `@echo off\r\n>"%~dp0args.txt" echo ARGS:%*\r\n"${process.execPath}" "${reader}"\r\n`,
    );
    const prompt = 'fix "it" & echo INJECTED | more %PATH%';
    session = new PtySession(cwd, 120, 30, undefined, { tool: tool('batchagent'), initialPrompt: prompt, env: env() });
    expect(await waitFor(() => fs.existsSync(typed), 25_000)).toBe(true);
    expect(fs.readFileSync(typed, 'utf8')).toContain(prompt);
    expect(fs.readFileSync(path.join(bin, 'args.txt'), 'utf8').trim()).toBe('ARGS:');
    expect(session.screenText()).not.toMatch(/^\s*INJECTED\s*$/m);
  }, 40_000);
});
