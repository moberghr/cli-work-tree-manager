import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  linkedComments,
  scopeLinkedStoreIds,
  sessionLinkedStoreIds,
  storeHolding,
  viewersOf,
} from '../../../src/core/comments/linked-stores.js';
import { scopeHashFor } from '../../../src/core/diff/repo-spec.js';
import type { Comment } from '../../../src/core/comments/comment-types.js';

const comment = (id: string, at: string, extra: Partial<Comment> = {}): Comment => ({
  id,
  repo: '',
  file: '',
  line: 0,
  side: 'general',
  body: id,
  createdAt: at,
  author: 'user',
  status: 'published',
  ...extra,
});

const backend = path.resolve('/w/group/feat-x/backend');
const frontend = path.resolve('/w/group/feat-x/frontend');
const group = { id: 'g1', paths: [backend, frontend] };
const single = { id: 's1', paths: [path.resolve('/w/repo/feat-y')] };
const scopeOf = (paths: string[]) => scopeHashFor(paths.map((p) => path.resolve(p)));

describe('which stores a view lists', () => {
  it("a session's: its own, then the wd scopes over its worktree (the group, and each repo of it)", () => {
    expect(sessionLinkedStoreIds(group)).toEqual([
      'g1',
      `scope-${scopeOf([backend, frontend])}`,
      `scope-${scopeOf([backend])}`,
      `scope-${scopeOf([frontend])}`,
    ]);
  });

  it("a scope's: its own, then the session whose worktree it covers; nobody's for a wd outside every session", () => {
    expect(scopeLinkedStoreIds(scopeOf([frontend]), [single, group])).toEqual([`scope-${scopeOf([frontend])}`, 'g1']);
    expect(scopeLinkedStoreIds(scopeOf(single.paths), [single, group, single])).toEqual([`scope-${scopeOf(single.paths)}`, 's1']);
    expect(scopeLinkedStoreIds('elsewhere', [single, group])).toEqual(['scope-elsewhere']);
  });
});

describe('linkedComments', () => {
  const stores: Record<string, Comment[]> = {
    own: [comment('b', '2026-10-12T10:02:00Z'), comment('mine-draft', '2026-10-12T10:05:00Z', { status: 'draft' })],
    other: [
      comment('a', '2026-10-12T10:01:00Z'),
      comment('their-draft', '2026-10-12T10:03:00Z', { status: 'draft' }),
      comment('b', '2026-10-12T10:02:00Z'),
    ],
  };
  const read = (id: string) => stores[id] ?? [];

  it("lists both, oldest first, each once; the other view's unsent drafts left out (this view's Submit wouldn't send them)", () => {
    expect(linkedComments(['own', 'other', 'none'], read).map((c) => c.id)).toEqual(['a', 'b', 'mine-draft']);
  });

  it('finds the store a comment is in, so a delete or a resolve acts there', () => {
    expect(storeHolding(['own', 'other'], 'a', read)).toBe('other');
    expect(storeHolding(['own', 'other'], 'b', read)).toBe('own');
    expect(storeHolding(['own', 'other'], 'gone', read)).toBeNull();
  });
});

describe('viewersOf: who refetches when a store changed', () => {
  it("a scope's store: that scope's page and the sessions over it", () => {
    expect(viewersOf(`scope-${scopeOf([backend])}`, [single, group, group])).toEqual({
      sessionIds: ['g1'],
      scopeHashes: [scopeOf([backend])],
    });
  });

  it("a session's store: its Diff tab and every scope page over its worktree", () => {
    expect(viewersOf('s1', [single, group])).toEqual({ sessionIds: ['s1'], scopeHashes: [scopeOf(single.paths)] });
    expect(viewersOf('unknown', [single])).toEqual({ sessionIds: ['unknown'], scopeHashes: [] });
  });
});
