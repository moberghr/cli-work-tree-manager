import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Architecture rules from CLAUDE.md / .claude/rules, enforced as tests so
 * they can't silently rot. Each rule scans the source's import statements
 * (static `import … from`, `export … from`, and dynamic `import()`).
 */

const SRC = path.resolve(__dirname, '../../src');

interface SourceFile {
  /** Repo-relative, forward slashes: `src/core/foo.ts`. */
  rel: string;
  imports: string[];
  text: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

const files: SourceFile[] = walk(SRC).map((abs) => {
  const text = fs.readFileSync(abs, 'utf-8');
  const imports: string[] = [];
  for (const m of text.matchAll(IMPORT_RE)) imports.push(m[1] ?? m[2] ?? m[3]);
  return { rel: path.relative(path.resolve(SRC, '..'), abs).split(path.sep).join('/'), imports, text };
});

/** Resolve a relative specifier to a repo-relative path (extension kept). */
function resolveRel(from: string, spec: string): string {
  return path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
}

function violations(pred: (f: SourceFile, spec: string) => boolean): string[] {
  const out: string[] = [];
  for (const f of files) for (const s of f.imports) if (pred(f, s)) out.push(`${f.rel} → ${s}`);
  return out;
}

describe('architecture boundaries', () => {
  it('scans a meaningful number of files (guards against a broken walker)', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.find((f) => f.rel === 'src/core/pty/pty-host.ts')?.imports).toContain('ws');
  });

  it('§2.1 core never imports the commands layer', () => {
    expect(
      violations((f, s) =>
        f.rel.startsWith('src/core/') && s.startsWith('.') && resolveRel(f.rel, s).startsWith('src/commands/'),
      ),
    ).toEqual([]);
  });

  it('§2.1 core never imports the server: the HTTP front-end calls core, never the other way', () => {
    expect(
      violations((f, s) => f.rel.startsWith('src/core/') && s.startsWith('.') && resolveRel(f.rel, s).startsWith('src/server/')),
    ).toEqual([]);
  });

  it('§2.1 the CLI starts servers, it never calls into routes: only `work web` and `wd -c` import src/server', () => {
    // A route module holding logic a command needs means that logic belongs in core (catch-up-deps.ts, fork-deps.ts, …).
    const starters = new Set(['src/commands/web.ts', 'src/commands/diff.ts']);
    expect(
      violations((f, s) => f.rel.startsWith('src/commands/') && !starters.has(f.rel) && s.startsWith('.') && resolveRel(f.rel, s).startsWith('src/server/')),
    ).toEqual([]);
  });

  it('§2.3 nothing imports Ink (the terminal dashboard was retired), and React stays in the SPA', () => {
    expect(violations((_f, s) => s === 'ink' || s.startsWith('ink-'))).toEqual([]);
    expect(
      violations((f, s) => (s === 'react' || s.startsWith('react/') || s.startsWith('react-dom')) && !f.rel.startsWith('src/web/')),
    ).toEqual([]);
  });

  it('§2.7 core and the server never print: no chalk, no console output, no raw stdout/stderr writes', () => {
    // Core reports through report() (core/report.ts); the CLI, the server
    // and a future app each decide how to show it. logger.ts is the one
    // place that wraps the console (it IS the debug log).
    const printing = /\bconsole\.(log|error|warn|info)\s*\(|process\.(stdout|stderr)\.write\s*\(/;
    const offenders = files
      .filter((f) => (f.rel.startsWith('src/core/') || f.rel.startsWith('src/server/')) && f.rel !== 'src/core/platform/logger.ts')
      .flatMap((f) => [
        ...(f.imports.includes('chalk') ? [`${f.rel} imports chalk`] : []),
        ...f.text
          .split('\n')
          .map((line, i) => ({ line, i }))
          .filter(({ line }) => printing.test(line) && !/^\s*(\/\/|\*)/.test(line))
          .map(({ line, i }) => `${f.rel}:${i + 1} ${line.trim()}`),
      ]);
    expect(offenders).toEqual([]);
  });

  it('§2.4 node-pty is imported only by src/tui/session.ts', () => {
    expect(violations((f, s) => s === 'node-pty' && f.rel !== 'src/tui/session.ts')).toEqual([]);
  });

  it('the SQLite engine is loaded only by src/core/platform/db.ts (db-import.ts borrows its types)', () => {
    // One file owns the engine, so swapping it (e.g. to node:sqlite) is one
    // change and every other module goes through db.ts's transactions.
    const allowed = new Set(['src/core/platform/db.ts', 'src/core/platform/db-import.ts']);
    expect(violations((f, s) => s === 'better-sqlite3' && !allowed.has(f.rel))).toEqual([]);
    const importer = files.find((x) => x.rel === 'src/core/platform/db-import.ts');
    expect(fs.readFileSync(path.resolve(SRC, '..', importer!.rel), 'utf-8')).toMatch(/import type Database from 'better-sqlite3'/);
  });

  it('the browser SPA and the demo never touch state.db', () => {
    const db = /(^|\/)db(-import)?\.js$/;
    expect(
      violations((f, s) => (f.rel.startsWith('src/web/') || f.rel.startsWith('src/server/demo/')) && db.test(s)),
    ).toEqual([]);
  });

  it('§2.5 relative imports carry an explicit extension (.js for sources)', () => {
    expect(
      violations((f, s) => s.startsWith('.') && !/\.(js|css|json|svg|png)$/.test(s)),
    ).toEqual([]);
  });

  it('§2.6 Node builtins use the node: prefix', () => {
    const builtins = new Set([
      'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'child_process', 'events',
      'url', 'util', 'stream', 'readline', 'zlib', 'tty', 'assert', 'buffer', 'worker_threads',
      'fs/promises', 'timers', 'timers/promises',
    ]);
    expect(violations((_file, s) => builtins.has(s))).toEqual([]);
  });

  it('the browser SPA reaches into src/core only for the shared comment types', () => {
    // Shared wire types + pure logic: one definition for server and SPA.
    const allowed = new Set(['src/core/comments/comment-types.js', 'src/core/status/attention.js', 'src/core/api-types.js', 'src/core/diff/diff-parse.js', 'src/core/sessions/saved-prompts.js', 'src/core/conversations/digest-view.js', 'src/core/sessions/session-view.js', 'src/core/chat/chat-view.js', 'src/core/rail/session-order.js', 'src/core/jira/jira-board.js', 'src/core/jira/jira-prompt.js', 'src/core/rail/snooze.js', 'src/core/rail/rail-layout.js', 'src/core/conversations/work-time-view.js', 'src/core/rail/blocks.js', 'src/core/conversations/timeline.js', 'src/core/pty/host-health.js']);
    expect(
      violations(
        (f, s) =>
          f.rel.startsWith('src/web/') &&
          s.startsWith('.') &&
          resolveRel(f.rel, s).startsWith('src/core/') &&
          !allowed.has(resolveRel(f.rel, s)),
      ),
    ).toEqual([]);
  });

  it('core modules the SPA may import are pure (no imports at all)', () => {
    // Anything in the SPA allowlist above gets bundled for the browser, so
    // it must not reach Node — keep them dependency-free.
    for (const rel of ['src/core/comments/comment-types.ts', 'src/core/status/attention.ts', 'src/core/api-types.ts', 'src/core/diff/diff-parse.ts', 'src/core/sessions/saved-prompts.ts', 'src/core/conversations/digest-view.ts', 'src/core/sessions/session-view.ts', 'src/core/chat/chat-view.ts', 'src/core/rail/session-order.ts', 'src/core/jira/jira-board.ts', 'src/core/jira/jira-prompt.ts', 'src/core/rail/snooze.ts', 'src/core/rail/rail-layout.ts', 'src/core/conversations/work-time-view.ts', 'src/core/rail/blocks.ts', 'src/core/conversations/timeline.ts', 'src/core/pty/host-health.ts']) {
      const f = files.find((x) => x.rel === rel);
      expect(f, rel).toBeDefined();
      expect(f!.imports.filter((s) => !s.startsWith('.')), rel).toEqual([]);
    }
  });

  it('the browser SPA never imports Node-only modules', () => {
    const nodeOnly = /^(node:|node-pty$|better-sqlite3$|ws$|chokidar$|hono|@hono\/|cross-spawn$|proper-lockfile$|@xterm\/headless$|yargs)/;
    expect(violations((f, s) => f.rel.startsWith('src/web/') && nodeOnly.test(s))).toEqual([]);
  });

  it('Claude PTYs for sessions are spawned only by the PTY host', () => {
    // A session PTY created anywhere else would not survive restarts, would
    // not be restorable after a reboot and could not be attached to.
    const allowed = new Set(['src/core/pty/pty-registry.ts', 'src/tui/session.ts']);
    const offenders = files
      .filter((f) => /new PtySession\s*\(/.test(f.text) && !allowed.has(f.rel))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('work web does not own PTYs: nothing in core but the registry touches PtySession', () => {
    expect(
      violations(
        (f, s) =>
          f.rel.startsWith('src/core/') &&
          f.rel !== 'src/core/pty/pty-registry.ts' &&
          s.startsWith('.') &&
          resolveRel(f.rel, s) === 'src/tui/session.js' &&
          // type-only imports are fine (no runtime ownership)
          !new RegExp(`import\\s+type[^;]*['"]${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(f.text),
      ),
    ).toEqual([]);
  });

  it('source and test files contain no raw control characters', () => {
    // A literal ESC/GS byte works at runtime but is invisible in review and
    // breaks exact-match edits — write \x1b-style escapes instead.
    const all = [...walk(SRC), ...walk(path.resolve(SRC, '../tests'))];
    const offenders = all
      .filter((abs) => /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(fs.readFileSync(abs, 'utf-8')))
      .map((abs) => path.relative(path.resolve(SRC, '..'), abs));
    expect(offenders).toEqual([]);
  });

  it('only the PTY host imports the registry — node-pty never loads into work web or the CLI', () => {
    expect(
      violations(
        (f, s) =>
          s.startsWith('.') &&
          resolveRel(f.rel, s) === 'src/core/pty/pty-registry.js' &&
          f.rel !== 'src/core/pty/pty-host.ts',
      ),
    ).toEqual([]);
  });

  it('local servers bind to 127.0.0.1, never 0.0.0.0 (§1.3)', () => {
    const offenders = files.filter((f) => /['"]0\.0\.0\.0['"]/.test(f.text)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('every package the Node side imports is a runtime dependency (§9.3)', () => {
    // tsup externalizes `dependencies`, so they resolve from node_modules at
    // runtime. A package imported by Node code but listed only under
    // devDependencies works in dev and breaks a global install.
    const pkg = JSON.parse(fs.readFileSync(path.resolve(SRC, '../package.json'), 'utf-8'));
    const deps = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ]);
    const missing = violations((f, s) => {
      if (f.rel.startsWith('src/web/') || s.startsWith('.') || s.startsWith('node:')) return false;
      const name = s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0];
      return !deps.has(name);
    });
    expect(missing).toEqual([]);
  });
});
