import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sessionIdFor } from '../../../src/core/sessions/session-id.js';
import { flatFolderName, flatFolderOwner, sessionFolderPath } from '../../../src/core/worktree/session-folder.js';

/** Where a session folder lives: flat (`<branch>-<id6>`) for a new one with `sessionFolders`, else `<target>/<branch>`. */

const root = path.join('/', 'wt');
const on = { worktreesRoot: root, sessionFolders: true };
const off = { worktreesRoot: root };

describe('flatFolderName', () => {
  it('the branch, then the first six characters of the session id', () => {
    expect(flatFolderName('shop', 'fix/login')).toBe(`fix-login-${sessionIdFor({ target: 'shop', branch: 'fix/login' }).slice(0, 6)}`);
  });

  it('the same branch in two projects: two folders', () => {
    expect(flatFolderName('shop', 'fix/login')).not.toBe(flatFolderName('admin', 'fix/login'));
  });
});

describe('sessionFolderPath', () => {
  it('a new session: flat with the switch on, <target>/<branch> with it off', () => {
    expect(sessionFolderPath('shop', 'feat/x', on)).toBe(path.join(root, flatFolderName('shop', 'feat/x')));
    expect(sessionFolderPath('shop', 'feat/x', off)).toBe(path.join(root, 'shop', 'feat-x'));
  });

  it('an existing session keeps its layout, whatever the switch says now', () => {
    const old = { paths: [path.join(root, 'shop', 'feat-x', 'api')] };
    expect(sessionFolderPath('shop', 'feat/x', on, old)).toBe(path.join(root, 'shop', 'feat-x'));
    const flat = { paths: [path.join(root, flatFolderName('shop', 'feat/x'), 'api')] };
    expect(sessionFolderPath('shop', 'feat/x', off, flat)).toBe(path.join(root, flatFolderName('shop', 'feat/x')));
  });

  it('no row, switch on: an old-layout folder already there is used, never a flat one beside it', () => {
    const old = path.join(root, 'shop', 'feat-x');
    expect(sessionFolderPath('shop', 'feat/x', on, null, (p) => p === old)).toBe(old);
    expect(sessionFolderPath('shop', 'feat/x', on, null, () => false)).toBe(path.join(root, flatFolderName('shop', 'feat/x')));
  });

  it('under the configured root (a moved root: there, not where it was)', () => {
    const flat = { paths: [path.join('/elsewhere', flatFolderName('shop', 'feat/x'), 'api')] };
    expect(sessionFolderPath('shop', 'feat/x', off, flat)).toBe(path.join(root, flatFolderName('shop', 'feat/x')));
  });
});

describe('flatFolderOwner', () => {
  const config = { repos: { api: '/r/api', web: '/r/web' }, groups: { shop: ['api', 'web'] } };
  it("the project whose session of this branch has the folder's name", () => {
    expect(flatFolderOwner(flatFolderName('web', 'feat/x'), 'feat/x', config)).toBe('web');
    expect(flatFolderOwner(flatFolderName('shop', 'feat/x').toUpperCase(), 'feat/x', config)).toBe('shop');
  });

  it("none for another branch's folder or a name that is no project's", () => {
    expect(flatFolderOwner(flatFolderName('web', 'feat/x'), 'feat/y', config)).toBeUndefined();
    expect(flatFolderOwner('feat-x-000000', 'feat/x', config)).toBeUndefined();
  });
});
