import { describe, it, expect } from 'vitest';
import { createCommentStore } from '../../src/core/comment-store.js';

describe('createCommentStore', () => {
  it('post() assigns an id, sets defaults, and appends to list', () => {
    const s = createCommentStore();
    const c = s.post({ body: 'hello' });
    expect(c.id).toMatch(/^[a-f0-9]+$/);
    expect(c.body).toBe('hello');
    expect(c.author).toBe('user');
    expect(c.status).toBe('published');
    expect(c.side).toBe('general');
    expect(c.repo).toBe('');
    expect(c.file).toBe('');
    expect(c.line).toBe(0);
    expect(c.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(s.snapshot()).toHaveLength(1);
  });

  it('post() trims body and rejects empty/whitespace bodies', () => {
    const s = createCommentStore();
    expect(s.post({ body: '  hi  ' }).body).toBe('hi');
    expect(() => s.post({ body: '' })).toThrow(/required/);
    expect(() => s.post({ body: '   ' })).toThrow(/required/);
  });

  it('post() validates side', () => {
    const s = createCommentStore();
    expect(() =>
      s.post({ body: 'x', side: 'bogus' as unknown as 'left' }),
    ).toThrow(/invalid side/);
  });

  it('replies inherit parent repo/file/line/side; explicit fields override', () => {
    const s = createCommentStore();
    const parent = s.post({
      body: 'top',
      repo: 'r',
      file: 'f.ts',
      line: 7,
      side: 'right',
    });
    const reply = s.post({ body: 'child', parentId: parent.id });
    expect(reply.parentId).toBe(parent.id);
    expect(reply.repo).toBe('r');
    expect(reply.file).toBe('f.ts');
    expect(reply.line).toBe(7);
    expect(reply.side).toBe('right');

    const override = s.post({
      body: 'override',
      parentId: parent.id,
      side: 'general',
    });
    expect(override.side).toBe('general');
  });

  it('post() throws if parentId is unknown', () => {
    const s = createCommentStore();
    expect(() => s.post({ body: 'x', parentId: 'nope' })).toThrow(
      /parent comment not found/,
    );
  });

  it('remove() returns false for unknown ids and true for hits', () => {
    const s = createCommentStore();
    const c = s.post({ body: 'x' });
    expect(s.remove('nope')).toBe(false);
    expect(s.remove(c.id)).toBe(true);
    expect(s.snapshot()).toHaveLength(0);
  });

  it("post() accepts a whole-file comment (side: 'file')", () => {
    const s = createCommentStore();
    const c = s.post({ body: 'file note', side: 'file', repo: 'r', file: 'f.ts' });
    expect(c.side).toBe('file');
    expect(c.file).toBe('f.ts');
    expect(c.line).toBe(0);
  });

  it('setResolved() toggles the flag and returns the updated comment', () => {
    const s = createCommentStore();
    const c = s.post({ body: 'x' });
    expect(c.resolved).toBeUndefined();
    const r = s.setResolved(c.id, true);
    expect(r?.id).toBe(c.id);
    expect(r?.resolved).toBe(true);
    // Unresolving drops the key (false is stored as undefined).
    expect(s.setResolved(c.id, false)?.resolved).toBeUndefined();
  });

  it('setResolved() returns null for unknown ids and no-op toggles', () => {
    const s = createCommentStore();
    const c = s.post({ body: 'x' });
    expect(s.setResolved('nope', true)).toBeNull();
    s.setResolved(c.id, true);
    // Already true → no change → null.
    expect(s.setResolved(c.id, true)).toBeNull();
  });

  it('submit() promotes drafts to published in chronological order and adds a summary', () => {
    const s = createCommentStore();
    const d1 = s.post({ body: 'd1', status: 'draft' });
    const d2 = s.post({ body: 'd2', status: 'draft' });
    const pub = s.post({ body: 'already published' });
    const result = s.submit('wrap-up note');
    expect(result.drafts).toHaveLength(2);
    expect(result.drafts.map((c) => c.id)).toEqual([d1.id, d2.id]);
    expect(result.summary?.body).toBe('wrap-up note');
    expect(result.summary?.side).toBe('general');
    // Drafts are now published.
    for (const c of s.snapshot()) {
      if (c.id === d1.id || c.id === d2.id) expect(c.status).toBe('published');
    }
    // Pre-published comment unchanged.
    expect(s.snapshot().find((c) => c.id === pub.id)?.status).toBe(
      'published',
    );
  });

  it('submit() with no summary text returns summary: null', () => {
    const s = createCommentStore();
    s.post({ body: 'd1', status: 'draft' });
    const result = s.submit(undefined);
    expect(result.summary).toBeNull();
    expect(result.drafts).toHaveLength(1);
  });

  it('discardDrafts() removes only drafts, returns count', () => {
    const s = createCommentStore();
    s.post({ body: 'd1', status: 'draft' });
    s.post({ body: 'p1' });
    s.post({ body: 'd2', status: 'draft' });
    expect(s.discardDrafts()).toBe(2);
    expect(s.snapshot()).toHaveLength(1);
    expect(s.snapshot()[0].body).toBe('p1');
    // Idempotent.
    expect(s.discardDrafts()).toBe(0);
  });

  it('snapshot() returns a copy — mutations do not leak back', () => {
    const s = createCommentStore();
    s.post({ body: 'a' });
    const snap = s.snapshot();
    snap.length = 0;
    expect(s.snapshot()).toHaveLength(1);
  });
});
