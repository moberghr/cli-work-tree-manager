import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every process work starts says `windowsHide`. On Windows a console program
 * (git, gh, cmd, PowerShell, node) started by a process with no console of its
 * own — work web, the PTY host, a detached child — gets a new console window,
 * which flashes up and is gone a moment later (reported: windows blinking
 * during test runs; the desktop toast's PowerShell flashed with every
 * notification). `windowsHide: true` stops that. A process that is meant to be
 * seen, or that shares this terminal (an editor, `work run`, Windows
 * Terminal), says `windowsHide: false` with the reason.
 *
 * The check reads the calls of every function that starts a process —
 * child_process's and cross-spawn's (`src/core/platform/spawn.ts`) — and wants
 * `windowsHide` in the call, or in the options object it is handed by name.
 */

const SRC = path.resolve(__dirname, '../../src');
const STARTERS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'web') out.push(...walk(p)); // the SPA starts no processes
    } else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** The call expressions in `text` that start a process: `spawn(`, `cp.execFile(`, `crossSpawn.sync(`… */
export function starterCalls(text: string): RegExp | null {
  const names: string[] = [];
  for (const m of text.matchAll(/import\s+(?!type\b)([\w$]+)\s+from\s+['"](?:node:)?child_process['"]/g))
    names.push(...STARTERS.map((f) => `${m[1]}\\.${f}`));
  for (const m of text.matchAll(/import\s+\*\s+as\s+([\w$]+)\s+from\s+['"](?:node:)?child_process['"]/g))
    names.push(...STARTERS.map((f) => `${m[1]}\\.${f}`));
  for (const m of text.matchAll(/import\s+\{([^}]*)\}\s+from\s+['"](?:node:)?child_process['"]/g)) {
    for (const part of m[1].split(',')) {
      const [orig, alias] = part.trim().split(/\s+as\s+/);
      if (STARTERS.includes(orig)) names.push(alias ?? orig);
    }
  }
  for (const m of text.matchAll(/import\s+(?!type\b)([\w$]+)\s+from\s+['"](?:cross-spawn|[./]+(?:platform\/)?spawn\.js)['"]/g))
    names.push(m[1], `${m[1]}\\.sync`);
  return names.length ? new RegExp(`(?<![\\w$.])(?:${names.join('|')})\\s*\\(`, 'g') : null;
}

/** The text of a call's arguments, from just after its `(` to the matching `)` (strings and comments skipped over). */
export function callArgs(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++;
    } else if (c === '/' && text[i + 1] === '/') i = text.indexOf('\n', i);
    else if (c === '/' && text[i + 1] === '*') i = text.indexOf('*/', i) + 1;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return text.slice(open + 1, i);
    if (i < 0) break;
  }
  return text.slice(open + 1);
}

/** Calls in a file that start a process without saying `windowsHide`: `file:line  call`. */
export function unhidden(rel: string, text: string): string[] {
  const re = starterCalls(text);
  if (!re) return [];
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const before = text.slice(text.lastIndexOf('\n', m.index) + 1, m.index);
    if (/^\s*(\/\/|\*)/.test(before) || /\bfunction\s+$/.test(before)) continue;
    const args = callArgs(text, m.index + m[0].length - 1);
    if (/\bwindowsHide\b/.test(args)) continue;
    // Options handed by name (`spawn(cmd, args, opts)`) or made by a call (`spawn(cmd, args, opts())`): what it names says it.
    const named = /,\s*([\w$]+)\s*(?:\([^()]*\))?\s*$/.exec(args.trim())?.[1];
    if (named && new RegExp(`\\b${named}\\b[^=;]*=[^;]*\\bwindowsHide\\b`, 's').test(text)) continue;
    const line = text.slice(0, m.index).split('\n').length;
    out.push(`${rel}:${line}  ${m[0]}${args.split('\n')[0].slice(0, 80)}`);
  }
  return out;
}

/**
 * `detached: true` as it stands, outside the one place allowed it. On Windows a detached process has no
 * console, so each console program it starts opens a window that `windowsHide` can't stop (measured);
 * background programs use `detached: detachHere()` (POSIX only). spawnDetachedWork keeps it: it starts
 * work's own servers, whose every child is hidden.
 */
export function detachedOnWindows(rel: string, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\bdetached:\s*true\b/g)) {
    const line = text.slice(0, m.index).split('\n').length;
    if (rel === 'src/core/platform/process.ts' && /export function spawnDetachedWork[\s\S]*$/.test(text.slice(0, m.index))) continue;
    out.push(`${rel}:${line}`);
  }
  return out;
}

describe('every process work starts says windowsHide (no console windows flashing on Windows)', () => {
  it('src/: each process-starting call has windowsHide, or windowsHide: false with its reason', () => {
    const found = walk(SRC).flatMap((abs) =>
      unhidden(path.relative(path.resolve(SRC, '..'), abs).split(path.sep).join('/'), fs.readFileSync(abs, 'utf8')),
    );
    expect(found).toEqual([]);
  });

  it('nothing but spawnDetachedWork starts detached on Windows (detachHere: POSIX only)', () => {
    const found = walk(SRC).flatMap((abs) =>
      detachedOnWindows(path.relative(path.resolve(SRC, '..'), abs).split(path.sep).join('/'), fs.readFileSync(abs, 'utf8')),
    );
    expect(found).toEqual([]);
    expect(detachedOnWindows('src/a.ts', "spawn('code', [], { detached: true, windowsHide: true });")).toEqual(['src/a.ts:1']);
    expect(detachedOnWindows('src/a.ts', "spawn('code', [], { detached: detachHere(), windowsHide: true });")).toEqual([]);
  });

  it('the check finds a call that forgot it, in each import form, and passes one that has it', () => {
    expect(unhidden('a.ts', "import { execFile } from 'node:child_process';\nexecFile('git', ['status'], (e) => {});")).toHaveLength(1);
    expect(unhidden('a.ts', "import cp from 'node:child_process';\ncp.spawnSync('git', []);")).toHaveLength(1);
    expect(
      unhidden('a.ts', "import spawn from '../platform/spawn.js';\nspawn.sync('git', ['x'], { cwd });\nspawn('gh', []);"),
    ).toHaveLength(2);
    expect(unhidden('a.ts', "import { spawn as s } from 'child_process';\ns('cmd', ['/c', 'start'], { detached: true });")).toHaveLength(1);
    expect(unhidden('a.ts', "import spawn from 'cross-spawn';\nspawn('git', ['a(b)'], { cwd, windowsHide: true });")).toEqual([]);
    expect(
      unhidden(
        'a.ts',
        "import { spawnSync } from 'node:child_process';\nconst opts = (t = 5) => ({ timeout: t, windowsHide: true });\nspawnSync('sh', [], opts(500));",
      ),
    ).toEqual([]);
    expect(
      unhidden(
        'a.ts',
        "import { spawnSync } from 'node:child_process';\nconst opts = (t = 5) => ({ timeout: t });\nspawnSync('sh', [], opts());",
      ),
    ).toHaveLength(1);
    expect(unhidden('a.ts', "import spawn from 'cross-spawn';\nconst opts = { cwd, windowsHide: true };\nspawn('git', [], opts);")).toEqual(
      [],
    );
    expect(unhidden('a.ts', "import spawn from 'cross-spawn';\n// spawn('git') in a comment\n")).toEqual([]);
    expect(unhidden('a.ts', 'const m = /x/.exec(s); fork(a); spawn(b);')).toEqual([]); // nothing imported that starts processes
  });
});
