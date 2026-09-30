import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mountCleanupRoutes } from '../../src/core/cleanup-routes.js';
import type { CleanupJob } from '../../src/core/cleanup.js';
import type { CommandRunner } from '../../src/core/ship.js';
import type { BranchesState } from '../../src/core/api-types.js';

const TIP = 'a'.repeat(40);

/** A repo with one merged branch (feat/done) and one that isn't (feat/wip). */
function fakeGit() {
  const deleted: string[] = [];
  const run: CommandRunner = async (_cmd, args) => {
    const a = args.slice(2).join(' '); // drop `-C <repo>`
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    if (a === 'rev-parse --abbrev-ref origin/HEAD') return ok('origin/main\n');
    if (a.startsWith('branch --merged')) return ok(deleted.includes('feat/done') ? 'main\n' : 'main\nfeat/done\n');
    if (a.startsWith('for-each-ref')) return ok(['main\t' + TIP + '\t', ...(deleted.includes('feat/done') ? [] : ['feat/done\t' + TIP + '\t']), 'feat/wip\t' + 'b'.repeat(40) + '\t'].join('\n'));
    if (a.startsWith('branch -D')) {
      deleted.push(args.at(-1)!);
      return ok();
    }
    return ok();
  };
  return { run, deleted };
}

function app() {
  const git = fakeGit();
  const a = new Hono();
  mountCleanupRoutes(a, {
    broadcast: () => {},
    job: {} as CleanupJob,
    buildFolders: { sessions: async () => [] },
    branches: { repos: () => [{ alias: 'api', path: '/repos/api' }], sessionBranches: () => new Map(), run: git.run },
  });
  return { a, git };
}
const post = (a: Hono, url: string, body?: unknown) =>
  a.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

describe('cleanup branch routes', () => {
  it('scans in the background, then deletes a chosen branch and drops it from the list', async () => {
    const { a, git } = app();
    expect(await (await a.request('/api/cleanup/branches')).json()).toMatchObject({ scanning: false, scannedAt: null });
    expect(await (await post(a, '/api/cleanup/branches/scan')).json()).toMatchObject({ scanning: true });
    let st: BranchesState = { scanning: true, scannedAt: null, candidates: [] };
    await vi.waitFor(async () => {
      st = await (await a.request('/api/cleanup/branches')).json();
      expect(st.scanning).toBe(false);
    });
    expect(st.candidates.map((b) => b.branch)).toEqual(['feat/done']);

    const res = await (await post(a, '/api/cleanup/branches/apply', { items: [{ repo: 'api', branch: 'feat/done' }, { repo: 'api', branch: 'feat/wip' }] })).json();
    expect(res.results.map((r: { branch: string; ok: boolean }) => [r.branch, r.ok])).toEqual([['feat/done', true], ['feat/wip', false]]);
    expect(git.deleted).toEqual(['feat/done']);
    expect(res.state.candidates).toEqual([]);
  });

  it('refuses a body without items', async () => {
    const { a } = app();
    expect((await post(a, '/api/cleanup/branches/apply', {})).status).toBe(400);
    expect((await post(a, '/api/cleanup/branches/apply', { items: [{ repo: 'api' }] })).status).toBe(400);
  });
});
