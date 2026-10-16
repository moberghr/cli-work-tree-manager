import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCiStore, createSeenStores, isSessionCi } from '../../../src/core/pr/pr-watch-store.js';
import { withDb } from '../../../src/core/platform/db.js';
import type { SessionCi } from '../../../src/core/api-types.js';
import { purgeSessionState } from '../../../src/core/sessions/session-store.js';
import { sessionIdFor } from '../../../src/core/sessions/session-id.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'prw-store-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('PR watch seen-stores', () => {
  it('keeps keys per session and survives a restart', () => {
    const stores = createSeenStores();
    stores('aaa').add('rv:aaa:api:7:t:C1');
    stores('bbb').add('bbb:api:deadbeef');
    expect(stores('aaa').has('rv:aaa:api:7:t:C1')).toBe(true);
    expect(stores('aaa').has('bbb:api:deadbeef')).toBe(false);

    const again = createSeenStores(); // a new work web
    expect(again('bbb').has('bbb:api:deadbeef')).toBe(true);
    expect(again('aaa').has('rv:aaa:api:7:t:C1')).toBe(true);
  });

  it('removing a session removes its keys', async () => {
    const id = sessionIdFor({ target: 'api', branch: 'feat/x' });
    createSeenStores()(id).add(`rv:${id}:api:7:baseline`);
    await purgeSessionState('api', 'feat/x');
    expect(createSeenStores()(id).has(`rv:${id}:api:7:baseline`)).toBe(false);
  });

  it('a running work web sees the removal too (a re-created session starts clean)', async () => {
    const id = sessionIdFor({ target: 'api', branch: 'feat/x' });
    const stores = createSeenStores(); // the one work web holds for its lifetime
    stores(id).add(`${id}:api:sha1`);
    expect(stores(id).has(`${id}:api:sha1`)).toBe(true);
    await purgeSessionState('api', 'feat/x'); // `work remove`, from any process
    expect(stores(id).has(`${id}:api:sha1`)).toBe(false);
  });
});

const check = (number = 3565): SessionCi => ({
  checkedAt: '2026-10-16T08:00:00.000Z',
  viewer: 'me',
  repos: [
    {
      name: 'api',
      pr: {
        number,
        url: `https://github.com/o/api/pull/${number}`,
        state: 'OPEN',
        isDraft: false,
        mergeStateStatus: 'CLEAN',
        checks: 'pass',
        headSha: 'f3c0896',
      },
      done: false,
      openThreads: 1,
    },
  ],
});

describe("PR watch's last check", () => {
  it('a new work web reads back what the last one saved', () => {
    createCiStore().save('aaa', check());
    createCiStore().save('bbb', { checkedAt: '2026-10-16T08:00:00.000Z', repos: [{ name: 'web', pr: null, done: true }] });
    createCiStore().save('aaa', check(3566)); // a later check replaces it
    expect(new Map(createCiStore().load())).toEqual(
      new Map([
        ['aaa', check(3566)],
        ['bbb', { checkedAt: '2026-10-16T08:00:00.000Z', repos: [{ name: 'web', pr: null, done: true }] }],
      ]),
    );
  });

  it('drops a row that is not a check as the watch writes it', () => {
    createCiStore().save('good', check());
    withDb((d) => {
      const put = d.prepare('INSERT INTO pr_watch_state (session_id, data) VALUES (?, ?)');
      put.run('not-json', '{oops');
      put.run('no-repos', JSON.stringify({ checkedAt: 'x' }));
      put.run('bad-pr', JSON.stringify({ checkedAt: 'x', repos: [{ name: 'api', done: false, pr: { number: '7' } }] }));
      put.run('bad-state', JSON.stringify({ ...check(), repos: [{ ...check().repos[0], pr: { ...check().repos[0].pr, state: 'GONE' } }] }));
    });
    expect(
      createCiStore()
        .load()
        .map(([id]) => id),
    ).toEqual(['good']);
  });

  it('isSessionCi takes what the watch writes and refuses the rest', () => {
    expect(isSessionCi(check())).toBe(true);
    expect(isSessionCi({ checkedAt: 'x', repos: [{ name: 'api', pr: null, done: false, openThreads: 'two' }] })).toBe(false);
    expect(isSessionCi(null)).toBe(false);
    expect(isSessionCi([])).toBe(false);
  });

  it("a database it can't read gives none, rather than stopping work web from starting", () => {
    createCiStore().save('aaa', check());
    withDb((d) => d.exec('DROP TABLE pr_watch_state'));
    expect(createCiStore().load()).toEqual([]);
  });

  it('removing a session removes its last check', async () => {
    const id = sessionIdFor({ target: 'api', branch: 'feat/x' });
    createCiStore().save(id, check());
    await purgeSessionState('api', 'feat/x');
    expect(createCiStore().load()).toEqual([]);
  });
});
