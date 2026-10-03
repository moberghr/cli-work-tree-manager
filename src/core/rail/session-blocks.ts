import { json, tx, withDb } from '../platform/db.js';
import { prUrl } from './blocks.js';
import { sessionIdFor } from '../sessions/session-id.js';
import { loadHistory } from '../sessions/history.js';
import { blockerDone, blockKey, MAX_BLOCKERS, type BlockRef, type SessionBlock } from './blocks.js';

export { blockerDone, blockKey, prUrl, unblockedPrompt, MAX_BLOCKERS, type BlockRef, type SessionBlock } from './blocks.js';

/**
 * "Blocked by": a session waiting on other work — another session (its
 * worktree), or a pull request by URL. While it waits it leaves the Inbox for
 * a "Waiting on others" section (a question from its Claude still shows:
 * that is never hidden). When everything it waits on is done — the session
 * archived or deleted, the PR merged or closed — the block clears itself,
 * you are told, and so is its Claude. state.db `session_blocks` (schema v7,
 * gone with the session).
 */

function isRef(v: unknown): v is BlockRef {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o.label !== 'string') return false;
  if (o.kind === 'session') return typeof o.id === 'string';
  return o.kind === 'pr' && typeof o.url === 'string';
}

function asBlock(v: unknown): SessionBlock | null {
  const o = v as SessionBlock | null;
  if (!o || typeof o !== 'object' || !Array.isArray(o.by) || typeof o.at !== 'string') return null;
  const by = o.by.filter(isRef);
  return by.length ? { by, at: o.at } : null;
}

export function readBlock(sessionId: string): SessionBlock | null {
  const row = withDb((d) => d.prepare('SELECT data FROM session_blocks WHERE session_id = ?').get(sessionId) as { data: string } | undefined);
  return row ? asBlock(json.parse(row.data)) : null;
}

/** Every session's block (the sessions list, the sweep: one query). */
export function allBlocks(): Map<string, SessionBlock> {
  const rows = withDb((d) => d.prepare('SELECT session_id, data FROM session_blocks').all() as Array<{ session_id: string; data: string }>);
  const out = new Map<string, SessionBlock>();
  for (const r of rows) {
    const b = asBlock(json.parse(r.data));
    if (b) out.set(r.session_id, b);
  }
  return out;
}

/** Add something it waits on (not itself; at most MAX_BLOCKERS; the same thing once). */
export function addBlocker(sessionId: string, ref: BlockRef, now = new Date()): { ok: true; block: SessionBlock } | { ok: false; error: string } {
  if (ref.kind === 'session' && ref.id === sessionId) return { ok: false, error: 'a session cannot wait on itself' };
  return tx((d) => {
    // Waiting on one that (perhaps through others) waits on this one: neither would ever be let go.
    if (ref.kind === 'session') {
      const waitsOn = (id: string): string[] => {
        const row = d.prepare('SELECT data FROM session_blocks WHERE session_id = ?').get(id) as { data: string } | undefined;
        const b = row ? asBlock(json.parse(row.data)) : null;
        return (b?.by ?? []).flatMap((x) => (x.kind === 'session' ? [x.id] : []));
      };
      const seen = new Set<string>();
      for (let todo = [ref.id]; todo.length; ) {
        const id = todo.pop()!;
        if (id === sessionId) return { ok: false as const, error: `${ref.label} already waits on this one: they would wait on each other for ever` };
        if (seen.has(id)) continue;
        seen.add(id);
        todo.push(...waitsOn(id));
      }
    }
    const row = d.prepare('SELECT data FROM session_blocks WHERE session_id = ?').get(sessionId) as { data: string } | undefined;
    const prev = row ? asBlock(json.parse(row.data)) : null;
    const by = (prev?.by ?? []).filter((b) => blockKey(b) !== blockKey(ref));
    if (by.length >= MAX_BLOCKERS) return { ok: false as const, error: `at most ${MAX_BLOCKERS} things to wait on` };
    const block = { by: [...by, ref], at: prev?.at ?? now.toISOString() };
    d.prepare('INSERT OR REPLACE INTO session_blocks (session_id, data) VALUES (?, ?)').run(sessionId, JSON.stringify(block));
    return { ok: true as const, block };
  });
}

/** Stop waiting on one thing (`key`), or on everything (no key). */
export function removeBlocker(sessionId: string, key?: string): SessionBlock | null {
  return tx((d) => {
    const row = d.prepare('SELECT data FROM session_blocks WHERE session_id = ?').get(sessionId) as { data: string } | undefined;
    const prev = row ? asBlock(json.parse(row.data)) : null;
    const by = key ? (prev?.by ?? []).filter((b) => blockKey(b) !== key) : [];
    if (by.length === 0) {
      d.prepare('DELETE FROM session_blocks WHERE session_id = ?').run(sessionId);
      return null;
    }
    const block = { by, at: prev!.at };
    d.prepare('INSERT OR REPLACE INTO session_blocks (session_id, data) VALUES (?, ?)').run(sessionId, JSON.stringify(block));
    return block;
  });
}

/** Record what a PR blocker's state is now (the sweep asks gh). */
export function setPrState(sessionId: string, url: string, state: 'OPEN' | 'MERGED' | 'CLOSED'): void {
  tx((d) => {
    const row = d.prepare('SELECT data FROM session_blocks WHERE session_id = ?').get(sessionId) as { data: string } | undefined;
    const prev = row ? asBlock(json.parse(row.data)) : null;
    if (!prev) return;
    const by = prev.by.map((b) => (b.kind === 'pr' && b.url === url ? { ...b, state } : b));
    d.prepare('INSERT OR REPLACE INTO session_blocks (session_id, data) VALUES (?, ?)').run(sessionId, JSON.stringify({ ...prev, by }));
  });
}

export interface UnblockDeps {
  blocks: () => Map<string, SessionBlock>;
  /** Archived, or no longer a session. */
  sessionGone: (id: string) => boolean;
  /** A PR's state (gh pr view), null when gh can't say. */
  prState: (url: string) => Promise<'OPEN' | 'MERGED' | 'CLOSED' | null>;
  /** A session whose wait is over: told, and its Claude told. */
  unblocked: (sessionId: string, done: BlockRef[]) => Promise<void>;
}

/**
 * The sweep: ask about each PR waited on, and clear the blocks whose every
 * blocker is done. Returns the sessions unblocked.
 */
export async function sweepBlocks(deps: UnblockDeps): Promise<string[]> {
  const out: string[] = [];
  for (const [sessionId, block] of deps.blocks()) {
    if (deps.sessionGone(sessionId)) continue;
    for (const b of block.by) {
      if (b.kind !== 'pr' || b.state === 'MERGED' || b.state === 'CLOSED') continue;
      const st = await deps.prState(b.url).catch(() => null);
      if (st && st !== b.state) {
        setPrState(sessionId, b.url, st);
        b.state = st;
      }
    }
    if (block.by.every((b) => blockerDone(b, deps.sessionGone))) {
      // Only what this look found done: a blocker added meanwhile stays (and
      // the session with it), until a look finds that one done too.
      for (const b of block.by) removeBlocker(sessionId, blockKey(b));
      if (readBlock(sessionId)) continue;
      out.push(sessionId);
      await deps.unblocked(sessionId, block.by).catch(() => undefined);
    }
  }
  return out;
}

/** A request's blocker, checked: a live session (by id), or a GitHub PR URL. */
export function blockRefFrom(body: { kind?: unknown; id?: unknown; url?: unknown } | null): BlockRef | null {
  if (body?.kind === 'session' && typeof body.id === 'string') {
    const s = loadHistory().find((x) => sessionIdFor(x) === body.id && !x.archivedAt);
    return s ? { kind: 'session', id: body.id, label: s.title && s.title.trim() ? s.title : s.branch } : null;
  }
  if (body?.kind === 'pr' && typeof body.url === 'string') {
    const pr = prUrl(body.url);
    return pr ? { kind: 'pr', url: pr.url, label: pr.label } : null;
  }
  return null;
}
