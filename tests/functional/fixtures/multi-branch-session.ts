import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { takeCheckpoint, type ScopeRepo } from '../../../src/core/diff/checkpoint.js';
import { scopeHashForPaths } from '../../../src/core/diff/scope-manager.js';
import { saveHistory, type WorktreeSession } from '../../../src/core/sessions/history.js';
import { noteBranchFacts, recordCheckedOutBranches } from '../../../src/core/sessions/session-branches.js';
import { sessionIdFor } from '../../../src/core/sessions/session-id.js';

/**
 * A group session that worked on six branches over six turns, in two repos, as Claude does it — the Diff tab's
 * hardest case, built with real git and recorded as work records it (checkpoints, the branch record, the branch
 * facts). Used by tests (tests/core/diff/multi-branch-session.test.ts) and by hand, to look at in a browser
 * (`scripts`-free: a scratch script runs it under a scratch HOME and starts work web there).
 *
 * The story (group `shop`, session `feat/orders`; T = a turn's checkpoint):
 *   T0  Initial.
 *   T1  api: feat/orders "Add orders" (orders.cs).        web: feat/orders "Web orders" (orders.tsx).
 *   T2  api: feat/orders "Validate orders" (orders.cs) — pushed and merged into main upstream, then deleted locally.
 *   T3  api: fix/refunds from origin/main, "Add refunds" (refunds.cs).   web: feat/orders-ui from feat/orders, "Add UI".
 *   T4  api: refunds.cs edited, not committed (then stashed: it is the turn's work, never a commit).
 *   T5  api: scratch/try from origin/main, try.cs edited, never committed (then thrown away).
 *   T6  api: feat/export from origin/main, "Add export" (export.cs).    web: "Polish UI" (ui.tsx).
 * Checked out at the end: api feat/export, web feat/orders-ui.
 *
 * Writes under `root` and to the HOME the caller set (state.db, config.json): the caller isolates it.
 */
export interface MultiBranchSession {
  session: WorktreeSession;
  api: string;
  web: string;
  scopeHash: string;
  sha: Record<string, string>;
}

export async function buildMultiBranchSession(root: string, opts: { pace?: () => Promise<void> } = {}): Promise<MultiBranchSession> {
  // Turns and commits are ordered by time; a commit is stamped to the second, so a turn and the commit after it
  // must not share one.
  const pace = opts.pace ?? (() => new Promise<void>((r) => setTimeout(r, 1100)));
  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const write = (dir: string, file: string, text: string) => fs.writeFileSync(path.join(dir, file), text);
  const commit = (dir: string, file: string, text: string, msg: string) => {
    write(dir, file, text);
    run(dir, 'add', '-A');
    run(dir, 'commit', '-q', '-m', msg);
    return run(dir, 'rev-parse', 'HEAD');
  };

  const repos = path.join(root, 'repos');
  const up = path.join(root, 'upstream');
  fs.mkdirSync(repos, { recursive: true });
  fs.mkdirSync(up, { recursive: true });
  for (const name of ['api', 'web']) {
    const seed = path.join(root, `seed-${name}`);
    fs.mkdirSync(seed);
    run(seed, 'init', '-q', '-b', 'main');
    run(seed, 'config', 'user.email', 't@t.t');
    run(seed, 'config', 'user.name', 'Test');
    commit(seed, 'README.md', `# ${name}\n`, 'Initial');
    run(root, 'clone', '-q', '--bare', seed, path.join(up, `${name}.git`));
    run(root, 'clone', '-q', path.join(up, `${name}.git`), path.join(repos, name));
    run(path.join(repos, name), 'config', 'user.email', 't@t.t');
    run(path.join(repos, name), 'config', 'user.name', 'Test');
  }
  const folder = path.join(root, 'worktrees', 'shop', 'feat-orders');
  const api = path.join(folder, 'api');
  const web = path.join(folder, 'web');
  run(path.join(repos, 'api'), 'worktree', 'add', '-q', '-b', 'feat/orders', api, 'origin/main');
  run(path.join(repos, 'web'), 'worktree', 'add', '-q', '-b', 'feat/orders', web, 'origin/main');

  const now = new Date().toISOString();
  const session: WorktreeSession = {
    target: 'shop',
    isGroup: true,
    branch: 'feat/orders',
    paths: [api, web],
    repos: ['api', 'web'],
    createdAt: now,
    lastAccessedAt: now,
  };
  saveHistory([session]);
  const id = sessionIdFor(session);
  const scopeHash = scopeHashForPaths(session.paths);
  const scope: ScopeRepo[] = session.paths.map((p) => ({ name: path.basename(p), root: p }));
  // Each turn's end, as the hooks do it: the checkpoint, then the branches checked out (10+ minutes apart, so each
  // sighting moves the record's lastSeen).
  let minute = 0;
  const turn = async (label: string) => {
    const e = await takeCheckpoint(scopeHash, scope, { force: true, label });
    if (!e) throw new Error(`no checkpoint for ${label}`);
    minute += 11;
    recordCheckedOutBranches(session, new Date(Date.now() + minute * 60_000));
    await pace();
  };

  const sha: Record<string, string> = {};
  await turn('Initial');
  sha.apiOrders = commit(api, 'orders.cs', 'orders v1\n', 'Add orders');
  sha.webOrders = commit(web, 'orders.tsx', 'orders ui v1\n', 'Web orders');
  await turn('Orders, both repos');
  sha.apiValidate = commit(api, 'orders.cs', 'orders v2: validated\n', 'Validate orders');
  await turn('Validate orders');

  // feat/orders merges into main upstream; its tip is recorded while it's there (the branch facts), then it goes.
  run(api, 'push', '-q', 'origin', 'feat/orders');
  const merger = path.join(root, 'merger');
  run(root, 'clone', '-q', path.join(up, 'api.git'), merger);
  run(merger, 'config', 'user.email', 't@t.t');
  run(merger, 'config', 'user.name', 'Test');
  run(merger, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #1 from feat/orders', 'origin/feat/orders');
  run(merger, 'push', '-q', 'origin', 'main');
  run(api, 'fetch', '-q', 'origin');
  noteBranchFacts(id, [{ repo: 'api', name: 'feat/orders', exists: true, merged: true, pushed: true, sha: sha.apiValidate }]);

  run(api, 'checkout', '-q', '-b', 'fix/refunds', 'origin/main');
  sha.mainAfterMerge = run(api, 'rev-parse', 'origin/main');
  sha.apiRefunds = commit(api, 'refunds.cs', 'refunds v1\n', 'Add refunds');
  run(web, 'checkout', '-q', '-b', 'feat/orders-ui');
  sha.webUi = commit(web, 'ui.tsx', 'ui v1\n', 'Add UI');
  await turn('Refunds; the UI');
  write(api, 'refunds.cs', 'refunds v2, not committed\n');
  await turn('Refunds, uncommitted');
  run(api, 'stash', '-q');

  run(api, 'checkout', '-q', '-b', 'scratch/try', 'origin/main');
  write(api, 'try.cs', 'an experiment\n');
  await turn('An experiment');
  run(api, 'checkout', '-q', '--', '.');
  run(api, 'clean', '-qfd');

  run(api, 'checkout', '-q', '-b', 'feat/export', 'origin/main');
  run(api, 'branch', '-q', '-D', 'feat/orders');
  sha.apiExport = commit(api, 'export.cs', 'export v1\n', 'Add export');
  sha.webPolish = commit(web, 'ui.tsx', 'ui v2\n', 'Polish UI');
  await turn('Export; polish');

  return { session, api, web, scopeHash, sha };
}
