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

import { isSelected, readScope, setSelected } from '../../src/web/src/state/selected-hunks.js';

beforeEach(() => {
  (globalThis as unknown as { localStorage: LocalStorageMock }).localStorage.clear();
});

describe('selected-hunks state', () => {
  const scope = 'scope:review-x:repo-a:hunks';
  const hunkKey = 'src/foo.ts@10-12';

  it('round-trips a selection through localStorage', () => {
    expect(isSelected(scope, hunkKey)).toBe(false);
    setSelected(scope, hunkKey, true);
    expect(isSelected(scope, hunkKey)).toBe(true);
    expect(readScope(scope)).toEqual(new Set([hunkKey]));
  });

  it('readScope returns every selected hunk in the scope', () => {
    setSelected(scope, 'a@1-1', true);
    setSelected(scope, 'b@2-2', true);
    expect(readScope(scope)).toEqual(new Set(['a@1-1', 'b@2-2']));
  });

  it('toggling off removes the key (and prunes empty scopes)', () => {
    setSelected(scope, hunkKey, true);
    setSelected(scope, hunkKey, false);
    expect(isSelected(scope, hunkKey)).toBe(false);
    expect(readScope(scope)).toEqual(new Set());
    // Empty scope should be pruned from the raw store.
    const raw = (globalThis as unknown as { localStorage: LocalStorageMock })
      .localStorage.getItem('work-web:selected-hunks');
    expect(raw ? JSON.parse(raw) : {}).toEqual({});
  });

  it('keeps distinct scopes isolated — no leakage', () => {
    const other = 'scope:review-y:repo-b:hunks';
    setSelected(scope, hunkKey, true);
    setSelected(other, 'other@5-5', true);
    expect(readScope(scope)).toEqual(new Set([hunkKey]));
    expect(readScope(other)).toEqual(new Set(['other@5-5']));
    expect(isSelected(scope, 'other@5-5')).toBe(false);
    expect(isSelected(other, hunkKey)).toBe(false);
  });
});
