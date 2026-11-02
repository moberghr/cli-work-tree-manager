import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { git } from '../../../src/core/git/git.js';
import { saveConfig, type WorkConfig } from '../../../src/core/platform/config.js';
import { accountRefusal, openBaseCheckout, setupWorktree } from '../../../src/core/worktree/worktree.js';
import { findSession, loadHistory, setSessionAccount, upsertSession } from '../../../src/core/sessions/history.js';
import { collectingReporter, withReporter } from '../../../src/core/platform/report.js';

/** A new session records the Claude account it runs on (WorktreeSession.account); an existing one keeps its own. */

let fixture: string;
let tmp: string;
let config: WorkConfig;

beforeAll(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'session-account-fixture-'));
  for (const name of ['api', 'web']) {
    const dir = path.join(fixture, name);
    fs.mkdirSync(dir);
    git(['init', '-b', 'main'], dir);
    git(['config', 'user.email', 't@t.t'], dir);
    git(['config', 'user.name', 'T'], dir);
    fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
    git(['add', '.'], dir);
    git(['commit', '-m', 'init', '--no-gpg-sign'], dir);
  }
}, 60_000);
afterAll(() => fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-account-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tmp);
  fs.cpSync(fixture, path.join(tmp, 'src'), { recursive: true });
  config = {
    worktreesRoot: path.join(tmp, 'worktrees'),
    repos: { api: path.join(tmp, 'src', 'api'), web: path.join(tmp, 'src', 'web') },
    groups: { shop: ['api', 'web'] },
    copyFiles: [],
    claudeAccounts: { work: path.join(tmp, '.claude-work'), alt: path.join(tmp, '.claude-alt') },
  };
  saveConfig(config);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const setup = (target: string, branch: string, account?: string) =>
  setupWorktree(target, branch, config, undefined, undefined, { pull: false, ...(account ? { account } : {}) });

describe('recording the account of a new session', () => {
  it('the account asked for, in a single repo and in a group', async () => {
    await setup('api', 'feat/a', 'work');
    await setup('shop', 'feat/g', 'alt');
    expect(findSession(loadHistory(), 'api', 'feat/a')?.account).toBe('work');
    expect(findSession(loadHistory(), 'shop', 'feat/g')?.account).toBe('alt');
  });

  it('else the configured default account, and `default` when none is configured', async () => {
    await setup('api', 'feat/d');
    expect(findSession(loadHistory(), 'api', 'feat/d')?.account).toBe('default');
    config = { ...config, claudeAccount: 'work' };
    saveConfig(config);
    await setup('api', 'feat/w');
    expect(findSession(loadHistory(), 'api', 'feat/w')?.account).toBe('work');
    await setup('api', 'feat/explicit', 'default'); // asking for the default account by name beats the configured one
    expect(findSession(loadHistory(), 'api', 'feat/explicit')?.account).toBe('default');
  });

  it('re-entering keeps the account the session has — whatever is asked or configured now', async () => {
    await setup('api', 'feat/a', 'work');
    await setup('api', 'feat/a', 'alt');
    config = { ...config, claudeAccount: 'alt' };
    saveConfig(config);
    await setup('api', 'feat/a');
    expect(findSession(loadHistory(), 'api', 'feat/a')?.account).toBe('work');
    await setup('shop', 'feat/g', 'alt');
    await setup('shop', 'feat/g', 'work');
    expect(findSession(loadHistory(), 'shop', 'feat/g')?.account).toBe('alt');
  });

  it('a row from before accounts stays without one (it runs on the default account)', async () => {
    await setup('api', 'feat/a', 'work');
    const rows = loadHistory().map(({ account: _a, ...s }) => s);
    const { saveHistory } = await import('../../../src/core/sessions/history.js');
    saveHistory(rows);
    await setup('api', 'feat/a');
    expect(findSession(loadHistory(), 'api', 'feat/a')).not.toHaveProperty('account');
  });

  it('an unknown account is refused before any git: no worktree, no session', async () => {
    const reports = collectingReporter();
    const made = await withReporter(reports, () => setup('api', 'feat/x', 'nope'));
    expect(made).toBeNull();
    expect(reports.errors().join(' ')).toMatch(/Unknown Claude Code account: nope/);
    expect(loadHistory()).toEqual([]);
    expect(fs.existsSync(config.worktreesRoot)).toBe(false);
    expect(await withReporter(collectingReporter(), () => setup('shop', 'feat/x', 'nope'))).toBeNull();
  });

  it('the base checkout is a session: it records the account, and the unknown one is refused', async () => {
    const opened = await openBaseCheckout('api', config, { pull: false, account: 'work' });
    expect(opened).toMatchObject({ ok: true });
    expect(loadHistory().find((s) => s.target === 'api')?.account).toBe('work');
    expect(await openBaseCheckout('web', config, { pull: false, account: 'nope' })).toEqual({
      ok: false,
      error: expect.stringContaining('Unknown Claude Code account: nope'),
    });
  });

  it('upsertSession: new rows record it, existing rows are never overwritten', async () => {
    await upsertSession('x', false, 'b', ['/p'], undefined, undefined, undefined, undefined, 'alt');
    await upsertSession('x', false, 'b', ['/p'], undefined, undefined, undefined, undefined, 'work');
    await upsertSession('x', false, 'b', ['/p']);
    expect(findSession(loadHistory(), 'x', 'b')?.account).toBe('alt');
  });

  it('setSessionAccount moves a row to another account; an unknown session is false', async () => {
    await upsertSession('x', false, 'b', ['/p'], undefined, undefined, undefined, undefined, 'alt');
    expect(await setSessionAccount('x', 'b', 'work')).toBe(true);
    expect(findSession(loadHistory(), 'x', 'b')?.account).toBe('work');
    expect(await setSessionAccount('x', 'nope', 'work')).toBe(false);
  });

  it('an agent without accounts (A2): its new sessions record none, and only the default may be asked for', async () => {
    config = { ...config, aiCommand: 'opencode' };
    saveConfig(config);
    await upsertSession('x', false, 'b', ['/p']);
    await upsertSession('y', false, 'b', ['/p'], undefined, undefined, undefined, undefined, 'work');
    expect(findSession(loadHistory(), 'x', 'b')).not.toHaveProperty('account');
    expect(findSession(loadHistory(), 'y', 'b')).not.toHaveProperty('account');
    expect(accountRefusal(undefined, config)).toBeNull();
    expect(accountRefusal('default', config)).toBeNull(); // a fork passes its parent's, `default` for a row from before
    expect(accountRefusal('work', config)).toMatch(/opencode has no accounts/);
    // Claude's: its accounts.
    const claude = { ...config, aiCommand: undefined };
    saveConfig(claude);
    expect(accountRefusal('work', claude)).toBeNull();
    expect(accountRefusal('nope', claude)).toMatch(/Unknown Claude Code account: nope/);
  });
});
