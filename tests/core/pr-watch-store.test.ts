import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSeenStores, prWatchFileFor } from '../../src/core/pr-watch-store.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'prw-store-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  fs.mkdirSync(path.join(home, '.work'), { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('PR watch seen-stores', () => {
  it('keeps one file per session and survives a restart', () => {
    const stores = createSeenStores();
    stores('aaa').add('rv:aaa:api:7:t:C1');
    stores('bbb').add('bbb:api:deadbeef');
    expect(stores('aaa').has('rv:aaa:api:7:t:C1')).toBe(true);
    expect(stores('aaa').has('bbb:api:deadbeef')).toBe(false);
    expect(JSON.parse(fs.readFileSync(prWatchFileFor('aaa'), 'utf-8'))).toEqual({ seen: ['rv:aaa:api:7:t:C1'] });

    const again = createSeenStores();
    expect(again('bbb').has('bbb:api:deadbeef')).toBe(true);
  });

  it('splits the old single pr-watch.json by session, then removes it', () => {
    const legacy = path.join(home, '.work', 'pr-watch.json');
    fs.writeFileSync(legacy, JSON.stringify({ told: ['rv:aaa:api:7:baseline', 'aaa:api:sha1', 'rv:bbb:web:3:t:C9'] }));
    const stores = createSeenStores();
    expect(fs.existsSync(legacy)).toBe(false);
    expect(stores('aaa').has('rv:aaa:api:7:baseline')).toBe(true);
    expect(stores('aaa').has('aaa:api:sha1')).toBe(true);
    expect(stores('bbb').has('rv:bbb:web:3:t:C9')).toBe(true);
  });

  it('a corrupt file reads as empty instead of failing', () => {
    fs.mkdirSync(path.dirname(prWatchFileFor('aaa')), { recursive: true });
    fs.writeFileSync(prWatchFileFor('aaa'), 'not json');
    expect(createSeenStores()('aaa').has('x')).toBe(false);
  });
});
