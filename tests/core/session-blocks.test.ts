import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { blockerDone, blockKey, prUrl, unblockedPrompt } from '../../src/core/blocks.js';
import { addBlocker, allBlocks, readBlock, removeBlocker, sweepBlocks } from '../../src/core/session-blocks.js';
import { mountBlockRoutes } from '../../src/core/block-routes.js';
import { inboxRank } from '../../src/core/attention.js';
import { removeSession, saveHistory } from '../../src/core/history.js';
import { sessionIdFor } from '../../src/core/session-id.js';

const now = new Date().toISOString();
const a = { target: 'api', branch: 'feat/a', isGroup: false, paths: ['/wt/a'], createdAt: now, lastAccessedAt: now };
const b = { ...a, branch: 'feat/b', paths: ['/wt/b'] };
const ida = sessionIdFor(a);
const idb = sessionIdFor(b);
const PR = 'https://github.com/acme/api/pull/12';

describe('the rules (pure)', () => {
  it('a GitHub PR URL, normalized; anything else is none', () => {
    expect(prUrl(`${PR}/files?w=1#x`)).toEqual({ url: PR, label: 'api#12' });
    expect(prUrl('https://gitlab.com/acme/api/-/merge_requests/1')).toBeNull();
  });
  it('done: a session archived or gone; a PR merged or closed', () => {
    expect(blockerDone({ kind: 'session', id: 'x', label: 'x' }, (id) => id === 'x')).toBe(true);
    expect(blockerDone({ kind: 'pr', url: PR, label: 'p', state: 'OPEN' }, () => false)).toBe(false);
    expect(blockerDone({ kind: 'pr', url: PR, label: 'p', state: 'CLOSED' }, () => false)).toBe(true);
    expect(unblockedPrompt([{ kind: 'pr', url: PR, label: 'api#12', state: 'CLOSED' }])).toContain('api#12 (closed, not merged)');
  });
  it('out of the Inbox while waiting — a question from its Claude still shows', () => {
    expect(inboxRank({ attention: { state: 'idle', seen: false, since: now }, blockedBy: [{}] })).toBe(7);
    expect(inboxRank({ attention: { state: 'needs_input', seen: false, since: now }, blockedBy: [{}] })).toBe(0);
    expect(inboxRank({ attention: { state: 'idle', seen: false, since: now } })).toBe(1);
  });
});

describe('the store and the sweep', () => {
  it('waits on several things, each once; not on itself; removed one by one or all', () => {
    expect(addBlocker(ida, { kind: 'session', id: ida, label: 'me' })).toMatchObject({ ok: false });
    addBlocker(ida, { kind: 'session', id: idb, label: 'feat/b' });
    addBlocker(ida, { kind: 'pr', url: PR, label: 'api#12' });
    addBlocker(ida, { kind: 'pr', url: PR, label: 'api#12' });
    expect(readBlock(ida)?.by).toHaveLength(2);
    removeBlocker(ida, blockKey({ kind: 'pr', url: PR }));
    expect(readBlock(ida)?.by.map((x) => x.label)).toEqual(['feat/b']);
    removeBlocker(ida);
    expect(readBlock(ida)).toBeNull();
  });

  it('the sweep asks about the PRs, lets go of a session when everything is done, and says so', async () => {
    addBlocker(ida, { kind: 'pr', url: PR, label: 'api#12' });
    addBlocker(ida, { kind: 'session', id: idb, label: 'feat/b' });
    let prState: 'OPEN' | 'MERGED' = 'OPEN';
    let bGone = false;
    const unblocked = vi.fn(async () => {});
    const deps = { blocks: allBlocks, sessionGone: (id: string) => id === idb && bGone, prState: async () => prState, unblocked };
    expect(await sweepBlocks(deps)).toEqual([]);
    prState = 'MERGED';
    expect(await sweepBlocks(deps)).toEqual([]); // feat/b still going
    expect(readBlock(ida)?.by.find((x) => x.kind === 'pr')).toMatchObject({ state: 'MERGED' }); // remembered
    bGone = true;
    expect(await sweepBlocks(deps)).toEqual([ida]);
    expect(unblocked).toHaveBeenCalledWith(ida, expect.arrayContaining([expect.objectContaining({ label: 'feat/b' })]));
    expect(readBlock(ida)).toBeNull();
  });

  it('routes: a live session or a PR URL; refusals; deleted with the session', async () => {
    saveHistory([a, b]);
    const changed = vi.fn();
    const app = new Hono();
    mountBlockRoutes(app, { broadcast: () => {}, changed });
    const post = (body: unknown) => app.request(`/api/sessions/${ida}/blocks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post({ kind: 'session', id: idb })).status).toBe(200);
    expect((await post({ kind: 'pr', url: PR })).status).toBe(200);
    expect(changed).toHaveBeenCalledTimes(2); // a look straight away
    expect((await post({ kind: 'session', id: 'nope' })).status).toBe(400);
    expect((await post({ kind: 'pr', url: 'https://example.com/x' })).status).toBe(400);
    expect((await app.request(`/api/sessions/${ida}/blocks?key=${encodeURIComponent(`pr:${PR}`)}`, { method: 'DELETE' })).status).toBe(200);
    expect(readBlock(ida)?.by.map((x) => x.kind)).toEqual(['session']);
    await removeSession(a.target, a.branch);
    expect(readBlock(ida)).toBeNull();
  });
});
