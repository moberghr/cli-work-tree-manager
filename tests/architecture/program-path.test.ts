import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * On Windows every way of starting a program by its bare name looks in the working folder first (node-which
 * inside cross-spawn, libuv under child_process, cmd.exe), so a `git.cmd` committed at a worktree's root ran in
 * place of git. Programs are started by their absolute path on PATH (`programPath`, core/platform/program-path.ts):
 * - cross-spawn only through core/platform/spawn.ts, which resolves the program itself (pty-session.ts uses its
 *   parser on a path already resolved);
 * - every child_process start names its program as `programPath(…)` or `process.execPath`, but in the files below,
 *   which start the user's own shell command line (that's what they're for).
 */

const SRC = path.resolve(__dirname, '../../src');
const SHELL_COMMAND_FILES = new Map([
  ['core/worktree/dev-server.ts', "config devCommands: the user's shell command, shell: true"],
  ['core/status/status-hooks.ts', "config statusHooks: the user's shell command"],
  ['core/platform/shell-path.ts', 'the login shell, $SHELL: POSIX only'],
  ['core/pty/pty-session.ts', 'child_process only to hide fork() consoles; the program comes from programFor'],
]);
const CROSS_SPAWN_OK = new Set(['core/platform/spawn.ts', 'core/pty/pty-session.ts']);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'web') out.push(...walk(p));
    } else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const files = walk(SRC).map((f) => ({ rel: path.relative(SRC, f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8') }));

describe('programs start from PATH, never the working folder', () => {
  it('cross-spawn is imported only by the spawn wrapper (and the PTY parser)', () => {
    const offenders = files.filter((f) => /from\s+['"]cross-spawn['"]/.test(f.text) && !CROSS_SPAWN_OK.has(f.rel)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('every child_process start names its program by programPath(…) or process.execPath', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (SHELL_COMMAND_FILES.has(f.rel)) continue;
      const named = /import\s+\{([^}]*)\}\s+from\s+['"](?:node:)?child_process['"]/.exec(f.text);
      if (!named) continue;
      const starters = named[1]
        .split(',')
        .map((s) =>
          s
            .trim()
            .split(/\s+as\s+/)
            .pop()!,
        )
        .filter((s) => /^(spawn|spawnSync|execFile|execFileSync|exec|execSync)$/.test(s));
      for (const s of starters)
        for (const m of f.text.matchAll(new RegExp(`(?<![\\w.])${s}\\(\\s*([^,)]*)`, 'g')))
          if (!/^(programPath\(|process\.execPath)/.test(m[1].trim())) offenders.push(`${f.rel}: ${s}(${m[1].trim()}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the exceptions are real', () => {
    for (const rel of SHELL_COMMAND_FILES.keys()) expect(files.some((f) => f.rel === rel)).toBe(true);
  });
});
