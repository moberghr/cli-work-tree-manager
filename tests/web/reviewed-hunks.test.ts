import { beforeEach, describe, expect, it } from 'vitest';

// jsdom isn't installed in this repo, so provide a minimal localStorage
// mock on globalThis before importing the module under test. The module
// reads/writes localStorage at call time (not import time), so installing
// the mock here is sufficient.
class LocalStorageMock {
  private store: Record<string, string> = {};
  getItem(key: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.store, key)
      ? this.store[key]
      : null;
  }
  setItem(key: string, value: string): void {
    this.store[key] = String(value);
  }
  removeItem(key: string): void {
    delete this.store[key];
  }
  clear(): void {
    this.store = {};
  }
}

(globalThis as unknown as { localStorage: LocalStorageMock }).localStorage =
  new LocalStorageMock();

import {
  isReviewed,
  readScope,
  setReviewed,
} from '../../src/web/src/state/reviewed-hunks.js';

beforeEach(() => {
  (globalThis as unknown as { localStorage: LocalStorageMock }).localStorage.clear();
});

describe('reviewed-hunks state', () => {
  const scope = 'scope:review-x:repo-a:hunks';
  const hunkKey = 'src/foo.ts@a1b2c3d4';

  it('round-trips a reviewed mark through localStorage', () => {
    expect(isReviewed(scope, hunkKey)).toBe(false);
    setReviewed(scope, hunkKey, true);
    expect(isReviewed(scope, hunkKey)).toBe(true);
    expect(readScope(scope)).toEqual(new Set([hunkKey]));
  });

  it('readScope returns every reviewed hunk in the scope', () => {
    setReviewed(scope, 'a@0001', true);
    setReviewed(scope, 'b@0002', true);
    expect(readScope(scope)).toEqual(new Set(['a@0001', 'b@0002']));
  });

  it('toggling off removes the key (and prunes empty scopes)', () => {
    setReviewed(scope, hunkKey, true);
    setReviewed(scope, hunkKey, false);
    expect(isReviewed(scope, hunkKey)).toBe(false);
    expect(readScope(scope)).toEqual(new Set());
    // Empty scope should be pruned from the raw store.
    const raw = (globalThis as unknown as { localStorage: LocalStorageMock })
      .localStorage.getItem('work-web:reviewed-hunks');
    expect(raw ? JSON.parse(raw) : {}).toEqual({});
  });

  it('keeps distinct scopes isolated — no leakage', () => {
    const other = 'scope:review-y:repo-b:hunks';
    setReviewed(scope, hunkKey, true);
    setReviewed(other, 'other@5555', true);
    expect(readScope(scope)).toEqual(new Set([hunkKey]));
    expect(readScope(other)).toEqual(new Set(['other@5555']));
    expect(isReviewed(scope, 'other@5555')).toBe(false);
    expect(isReviewed(other, hunkKey)).toBe(false);
  });

  it('uses its own localStorage key, distinct from viewed-files', () => {
    setReviewed(scope, hunkKey, true);
    const ls = (globalThis as unknown as { localStorage: LocalStorageMock })
      .localStorage;
    expect(ls.getItem('work-web:reviewed-hunks')).not.toBeNull();
    expect(ls.getItem('work-web:viewed-files')).toBeNull();
  });
});
