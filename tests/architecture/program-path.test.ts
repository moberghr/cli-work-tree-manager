import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { importsOf, scan } from './source-scan.js';

/**
 * On Windows every way of starting a program by its bare name looks in the working folder first (node-which
 * inside cross-spawn, libuv under child_process, cmd.exe), so a `git.cmd` committed at a worktree's root ran in
 * place of git. Programs are started by their absolute path on PATH (`programPath`, core/platform/program-path.ts):
 * - cross-spawn only through core/platform/spawn.ts, which resolves the program itself; pty-session.ts may hold it
 *   for one thing only, its parser (`_parse`), on a path programFor already resolved — never calling it;
 * - every child_process start (`spawn`, `spawnSync`, `execFile`, `execFileSync`, `exec`, `execSync`, however it is
 *   loaded: a named, default or namespace import, `require`, a dynamic `import()`, through `promisify`) names its
 *   program as `programPath(…)` or `process.execPath`, but for the starts below, which run the user's own shell
 *   command line (that's what they're for) — each by the one expression it starts;
 * - a `shell: true` start runs with cmd.exe's lookup in the working folder off (`shellEnv`, shell-env.ts).
 * `fork` isn't a start by name: it runs a Node module on this process's node.
 */

const SRC = path.resolve(__dirname, '../../src');
/** file → the one first argument its shell-command start may have. */
const SHELL_COMMAND_STARTS = new Map([
  ['core/worktree/dev-server.ts', { arg: 'cmd.command', why: "config devCommands: the user's shell command, shell: true" }],
  ['core/status/status-hooks.ts', { arg: 'command', why: "config statusHooks: the user's shell command" }],
  ['core/platform/shell-path.ts', { arg: 'cmd', why: 'the login shell, $SHELL: POSIX only' }],
]);
const CROSS_SPAWN_HOME = 'core/platform/spawn.ts';
const CROSS_SPAWN_PARSER = 'core/pty/pty-session.ts';

const STARTERS = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync'];
const CP_SPEC = String.raw`['"](?:node:)?child_process['"]`;
const LOAD = String.raw`(?:await\s+)?(?:require|import)\s*\(\s*${CP_SPEC}\s*\)`;
const STARTER_ALT = STARTERS.join('|');

/** The text of a call's arguments, from just after its `(` to the matching `)` (strings skipped over). */
function argsAt(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < code.length && code[i] !== c; i++) if (code[i] === '\\') i++;
    } else if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c === ')' || c === ']' || c === '}') && --depth === 0) return code.slice(open + 1, i);
  }
  return code.slice(open + 1);
}

/** The first argument of an argument list (to its first top-level comma). */
function firstArg(args: string): string {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < args.length && args[i] !== c; i++) if (args[i] === '\\') i++;
    } else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) return args.slice(0, i).trim();
  }
  return args.trim();
}

/** `{ a, b as c }` / `{ a, b: c }` → the local names bound to child_process's starters. */
function boundStarters(list: string): string[] {
  const out: string[] = [];
  for (const part of list.split(',')) {
    const p = part.trim().replace(/^type\s+/, '');
    if (!p || /^type\s/.test(part.trim())) continue;
    const [orig, alias] = p.split(/\s+as\s+|\s*:\s*/);
    if (STARTERS.includes(orig)) out.push(alias ?? orig);
  }
  return out;
}

/**
 * Where a file starts a program by something other than its path on PATH: `file: what`. `allowedArg` is the one
 * first argument a shell-command file may start (SHELL_COMMAND_STARTS); `crossSpawn` says what the file may do
 * with cross-spawn: `home` (the wrapper), `parser` (hold it for `_parse` only) or `none`.
 */
export function startViolations(
  rel: string,
  text: string,
  opts: { allowedArg?: string; crossSpawn?: 'home' | 'parser' | 'none' } = {},
): string[] {
  const out: string[] = [];
  const { code } = scan(text, { jsx: rel.endsWith('.tsx') });
  const runtime = importsOf(text, { jsx: rel.endsWith('.tsx') }).runtime;

  // cross-spawn: loaded by an import, `require('cross-spawn')` or `createRequire(…)('cross-spawn')`.
  const loadsCrossSpawn = runtime.includes('cross-spawn') || /\(\s*['"]cross-spawn['"]\s*\)/.test(code);
  const crossSpawn = opts.crossSpawn ?? 'none';
  if (loadsCrossSpawn && crossSpawn === 'none') out.push(`${rel}: loads cross-spawn (start through core/platform/spawn.ts)`);
  if (loadsCrossSpawn && crossSpawn === 'parser') {
    const name = /import\s+([\w$]+)\s+from\s+['"]cross-spawn['"]/.exec(code)?.[1];
    if (!name || /\(\s*['"]cross-spawn['"]\s*\)/.test(code)) out.push(`${rel}: holds cross-spawn other than by one default import`);
    else {
      const uses = [...code.matchAll(new RegExp(String.raw`(?<![\w$.])${name.replace('$', '\\$')}(?![\w$])`, 'g'))].length;
      const parses = [
        ...code.matchAll(new RegExp(String.raw`\(\s*${name}\s+as\s+unknown\s+as\s+\{\s*_parse\b[^}]*\}\s*\)\s*\._parse\b`, 'g')),
      ].length;
      if (parses !== 1 || uses !== 2) out.push(`${rel}: uses cross-spawn beyond its one _parse (${uses - 1} uses, ${parses} _parse)`);
    }
  }

  // child_process: every way it can be loaded, and the local names its starters get.
  const loadsCp = runtime.some((s) => /^(?:node:)?child_process$/.test(s)) || new RegExp(LOAD).test(code);
  if (!loadsCp) return out;
  const fns: string[] = [];
  const namespaces: string[] = [];
  for (const m of code.matchAll(new RegExp(String.raw`import\s+(?!type\b)([^'";]*?)\s+from\s*${CP_SPEC}`, 'g'))) {
    const clause = m[1];
    const named = /\{([^}]*)\}/.exec(clause);
    if (named) fns.push(...boundStarters(named[1]));
    const head = clause
      .replace(/\{[^}]*\}/, '')
      .replace(/,/g, ' ')
      .trim();
    const ns = /^(?:\*\s+as\s+)?([\w$]+)$/.exec(head)?.[1];
    if (ns) namespaces.push(ns);
  }
  let readLoads = 0;
  for (const m of code.matchAll(new RegExp(String.raw`(?:const|let|var)\s+([\w$]+)\s*=\s*${LOAD}`, 'g'))) {
    namespaces.push(m[1]);
    readLoads++;
  }
  for (const m of code.matchAll(new RegExp(String.raw`(?:const|let|var)\s*\{([^}]*)\}\s*=\s*${LOAD}`, 'g'))) {
    fns.push(...boundStarters(m[1]));
    readLoads++;
  }
  // `require('child_process').execFile(…)`, `(await import('node:child_process')).spawn(…)`: a start right there.
  const direct = [...code.matchAll(new RegExp(String.raw`${LOAD}\s*\)?\s*\.\s*(${STARTER_ALT})\s*\(`, 'g'))];
  readLoads += direct.length;
  // A type read off it (`import('node:child_process').ChildProcess`, `typeof import(…)`) loads nothing.
  const allLoads = [...code.matchAll(new RegExp(LOAD, 'g'))].filter((m) => {
    const after = code.slice(m.index + m[0].length);
    const member = /^\s*\.\s*([\w$]+)/.exec(after)?.[1];
    return !(member && !STARTERS.includes(member)) && !/\btypeof\s+$/.test(code.slice(Math.max(0, m.index - 10), m.index));
  }).length;
  if (allLoads > readLoads) out.push(`${rel}: loads child_process in a way this check can't follow`);
  // promisify(execFile) / promisify(cp.execFile): the promisified one is a starter too.
  const starterRef = (s: string) => fns.includes(s) || namespaces.some((ns) => new RegExp(String.raw`^${ns}\.(?:${STARTER_ALT})$`).test(s));
  for (const m of code.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*(?:[\w$]+\.)?promisify\(\s*([\w$.]+)\s*\)/g))
    if (starterRef(m[2])) fns.push(m[1]);
  for (const m of code.matchAll(/(?<![\w$.])(?:[\w$]+\.)?promisify\(\s*([\w$.]+)\s*\)\s*\(/g))
    if (starterRef(m[1])) out.push(`${rel}: promisify(${m[1]})(…) — start through a named function`);

  const calls = [
    ...fns.map((f) => f.replace('$', '\\$')),
    ...namespaces.map((ns) => String.raw`${ns.replace('$', '\\$')}\s*\.\s*(?:${STARTER_ALT})`),
  ];
  const sites: number[] = direct.map((m) => m.index + m[0].length - 1);
  if (calls.length) {
    const re = new RegExp(String.raw`(?<![\w$.])(?:${calls.join('|')})\s*\(`, 'g');
    for (const m of code.matchAll(re)) {
      if (/\bfunction\s+$/.test(code.slice(Math.max(0, m.index - 20), m.index))) continue;
      sites.push(m.index + m[0].length - 1);
    }
  }
  for (const open of sites) {
    const args = argsAt(code, open);
    const first = firstArg(args);
    const line = code.slice(0, open).split('\n').length;
    const ok = /^(programPath\(|process\.execPath\b)/.test(first) || (opts.allowedArg !== undefined && first === opts.allowedArg);
    if (!ok) out.push(`${rel}:${line}: starts ${first || '(nothing)'}`);
    if (/\bshell\s*:\s*true\b/.test(args) && !/\bshellEnv\(/.test(args)) out.push(`${rel}:${line}: shell: true without shellEnv(…)`);
  }
  return out;
}

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
  it('every start in src/ names its program by programPath(…) or process.execPath; cross-spawn only through the wrapper', () => {
    const found = files.flatMap((f) =>
      startViolations(f.rel, f.text, {
        allowedArg: SHELL_COMMAND_STARTS.get(f.rel)?.arg,
        crossSpawn: f.rel === CROSS_SPAWN_HOME ? 'home' : f.rel === CROSS_SPAWN_PARSER ? 'parser' : 'none',
      }),
    );
    expect(found).toEqual([]);
  });

  it('the exceptions are real, and each still starts what it is excused for', () => {
    for (const [rel, { arg }] of SHELL_COMMAND_STARTS) {
      const f = files.find((x) => x.rel === rel);
      expect(f, rel).toBeDefined();
      expect(startViolations(rel, f!.text), rel).toEqual(expect.arrayContaining([expect.stringContaining(`starts ${arg}`)]));
    }
    for (const rel of [CROSS_SPAWN_HOME, CROSS_SPAWN_PARSER])
      expect(startViolations(rel, files.find((x) => x.rel === rel)!.text), rel).toEqual(
        expect.arrayContaining([expect.stringContaining('loads cross-spawn')]),
      );
  });

  describe('the check itself', () => {
    const v = (text: string, opts?: Parameters<typeof startViolations>[2]) => startViolations('a.ts', text, opts);

    it('passes starts by programPath(…) or process.execPath, in every import form', () => {
      expect(v("import { execFile } from 'node:child_process';\nexecFile(programPath('git'), ['status'], () => {});")).toEqual([]);
      expect(v("import cp from 'child_process';\ncp.spawnSync(process.execPath, ['-e', '1']);")).toEqual([]);
      expect(v("import { fork } from 'node:child_process';\nfork('./x.js');")).toEqual([]);
      expect(v("import type { ChildProcess } from 'node:child_process';\nspawn('git');")).toEqual([]);
      expect(v("const live = new Set<import('node:child_process').ChildProcess>();")).toEqual([]);
    });

    it.each([
      ['a named import', "import { spawn } from 'node:child_process';\nspawn('git', []);"],
      ['an alias', "import { execFile as ef } from 'child_process';\nef('gh', []);"],
      ['a default import', "import cp from 'node:child_process';\ncp.execFile('git', []);"],
      ['a namespace import', "import * as cp from 'node:child_process';\ncp.spawn('git', []);"],
      ['a default and named import', "import cp, { spawnSync } from 'node:child_process';\nspawnSync('git');"],
      ['require', "const cp = require('child_process');\ncp.execFileSync('git', []);"],
      ['a destructured require', "const { spawn: s } = require('node:child_process');\ns('git');"],
      ['a dynamic import', "const { execFile } = await import('node:child_process');\nexecFile('git', []);"],
      ['a start right off require', "require('child_process').execSync('git status');"],
      ['promisify', "import { execFile } from 'node:child_process';\nconst run = promisify(execFile);\nawait run('git', []);"],
      [
        'util.promisify of a member',
        "import cp from 'node:child_process';\nconst run = util.promisify(cp.execFile);\nawait run('gh', []);",
      ],
      ['a call over several lines', "import { spawn } from 'node:child_process';\nspawn(\n  'git',\n  [],\n);"],
    ])('flags a bare name through %s', (_, text) => {
      expect(v(text)).not.toEqual([]);
    });

    it('flags a load it cannot follow, and promisify called in place', () => {
      expect(v("const cp = x ? require('child_process') : null;")).toEqual([expect.stringContaining("can't follow")]);
      expect(v("import { execFile } from 'node:child_process';\nawait promisify(execFile)('git', []);")).toEqual([
        expect.stringContaining('promisify(execFile)'),
      ]);
    });

    it('cross-spawn: any load outside the wrapper, and in the parser file anything but its one _parse', () => {
      expect(v("import spawn from 'cross-spawn';")).toEqual([expect.stringContaining('loads cross-spawn')]);
      expect(v("const s = require('cross-spawn');")).toEqual([expect.stringContaining('loads cross-spawn')]);
      expect(v("const s = createRequire(import.meta.url)('cross-spawn');")).toEqual([expect.stringContaining('loads cross-spawn')]);
      expect(v("import type X from 'cross-spawn';")).toEqual([]);
      expect(v("const s = createRequire(import.meta.url)('cross-spawn');", { crossSpawn: 'home' })).toEqual([]);
      const parser = "import crossSpawn from 'cross-spawn';\nconst parse = (crossSpawn as unknown as { _parse: P })._parse;";
      expect(v(parser, { crossSpawn: 'parser' })).toEqual([]);
      expect(v(`${parser}\ncrossSpawn.sync('git', []);`, { crossSpawn: 'parser' })).toEqual([
        expect.stringContaining('beyond its one _parse'),
      ]);
      expect(v(`${parser}\ncrossSpawn('git', []);`, { crossSpawn: 'parser' })).toEqual([expect.stringContaining('beyond its one _parse')]);
    });

    it('a shell-command file may start only its one expression, and a shell: true start needs shellEnv', () => {
      const hook = "import { spawn } from 'node:child_process';\nspawn(command, { shell: true, env: shellEnv(process.env) });";
      expect(v(hook, { allowedArg: 'command' })).toEqual([]);
      expect(v(`${hook}\nspawn('git', []);`, { allowedArg: 'command' })).toEqual([expect.stringContaining("starts 'git'")]);
      expect(v("import { spawn } from 'node:child_process';\nspawn(command, { shell: true });", { allowedArg: 'command' })).toEqual([
        expect.stringContaining('without shellEnv'),
      ]);
    });

    it('a comment is not a start', () => {
      expect(v("import { spawn } from 'node:child_process';\n// spawn('git')\n/* execFile('gh') */")).toEqual([]);
    });
  });
});
