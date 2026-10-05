import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSeenStores } from '../../../src/core/pr/pr-watch-store.js';
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
