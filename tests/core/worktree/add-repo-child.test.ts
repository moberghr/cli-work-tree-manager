import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveConfig } from '../../../src/core/platform/config.js';
import { saveHistory, type WorktreeSession } from '../../../src/core/sessions/history.js';
import { sessionIdFor } from '../../../src/core/sessions/session-id.js';
import { addRepoChildArgs, addRepoInChild, afterTimeout, parseChildOutcome } from '../../../src/core/worktree/add-repo-child.js';

/** work web's child `work add-repo … --in-process --json`: its arguments, its answer, and a run that takes too long. */

let tmp: string;
let folder: string;
const now = new Date().toISOString();
let session: WorktreeSession;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'add-repo-child-')));
  folder = path.join(tmp, 'wt', 'shop', 'feat-x');
  session = {
    target: 'shop',
    branch: 'feat/x',
    isGroup: true,
    paths: [path.join(folder, 'api-repo')],
    repos: ['api'],
    createdAt: now,
    lastAccessedAt: now,
  };
  saveConfig({
    worktreesRoot: path.join(tmp, 'wt'),
    repos: { api: path.join(tmp, 'src', 'api-repo'), web: path.join(tmp, 'src', 'web-repo') },
    groups: { shop: ['api'] },
    copyFiles: [],
  });
  saveHistory([session]);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

const wire = { ok: true, path: '/w/shop/feat-x/web-repo', branch: 'feat/x', created: true, from: 'main', imported: true, warnings: ['w'] };

describe('the child', () => {
  it('its arguments: values as --flag=value', () => {
    expect(addRepoChildArgs('abc', 'web', undefined)).toEqual(['add-repo', 'web', '--session-id=abc', '--in-process', '--json']);
    expect(addRepoChildArgs('abc', 'web', 'dev')).toContain('--base=dev');
  });

  it('its answer: the last JSON line, with its warnings', () => {
    expect(parseChildOutcome(`noise\n${JSON.stringify(wire)}\n`, '', 0)).toEqual({ ok: true, wire });
    // From a child before warnings: none, and not imported.
    const { imported: _i, warnings: _w, ...older } = wire;
    expect(parseChildOutcome(JSON.stringify(older), '', 0)).toEqual({ ok: true, wire: { ...older, imported: false, warnings: [] } });
  });

  it("an error line keeps the child's status; a status it can't have is a 500", () => {
    expect(parseChildOutcome('{"error":"no repo called x in your config","status":400}\n', 'warn line', 1)).toEqual({
      ok: false,
      error: 'no repo called x in your config',
      status: 400,
    });
    expect(parseChildOutcome('{"error":"git broke"}', '', 1)).toMatchObject({ status: 500 });
    expect(parseChildOutcome('{"error":"x","status":200}', '', 1)).toMatchObject({ status: 500 });
  });

  it('else what it printed on stderr', () => {
    expect(parseChildOutcome('', '\x1b[31mboom\x1b[0m\n  more\n', 1)).toEqual({ ok: false, error: 'boom more', status: 500 });
    expect(parseChildOutcome('', '', null)).toEqual({ ok: false, error: 'work add-repo exited (killed)', status: 500 });
  });
});

describe('after a child that took too long', () => {
  const id = () => sessionIdFor(session);

  it('says a half-made checkout is in the session folder, by its path', () => {
    fs.mkdirSync(path.join(folder, 'web-repo'), { recursive: true });
    expect(afterTimeout(id(), 'web')).toContain(`${path.join(folder, 'web-repo')} was left half made`);
  });

  it('says it was added when the session records it already', () => {
    saveHistory([{ ...session, paths: [...session.paths, path.join(folder, 'web-repo')], repos: ['api', 'web'] }]);
    expect(afterTimeout(id(), 'web')).toMatch(/web is in the session/);
  });

  it('nothing left: just that it was stopped', () => {
    expect(afterTimeout(id(), 'web')).toMatch(/took too long \(stopped; run `work add-repo`/);
  });

  it('a real run is killed at its time and answered with that', async () => {
    // A "work" that never answers.
    const bin = path.join(tmp, 'slow.mjs');
    fs.writeFileSync(bin, 'setTimeout(() => {}, 60_000);\n');
    const run = addRepoInChild(() => bin, { timeoutMs: 300, execArgv: [] });
    const r = await run(id(), 'web', undefined);
    expect(r).toMatchObject({ ok: false, status: 500 });
    expect(!r.ok && r.error).toMatch(/took too long/);
  }, 30_000);
});
