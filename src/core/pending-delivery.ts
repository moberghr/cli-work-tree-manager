/**
 * Bridge between `work web` review comments and any live Claude session
 * running in the same worktree. Storage (state.db, see db.ts):
 *
 *   comments            the comment stores (comment-file-store.ts)
 *   comment_deliveries  (session, comment id) pairs surfaced to Claude
 *
 * "Pending" = published, user-authored, not in the delivered list. Replies
 * authored by Claude (author === 'claude') are excluded — Claude wrote
 * them; we don't need to echo them back.
 *
 * Delivery is lazy: when a Claude in the matching worktree submits a
 * prompt, the hook reads pending comments via this module, prints them as
 * a system-reminder block to stdout (which Claude Code injects into the
 * conversation), and marks them delivered.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadHistory, type WorktreeSession } from './history.js';
import { sessionIdFor } from './web-state.js';
import { readStoreComments } from './comment-file-store.js';
import { scopeHashFor } from './repo-spec.js';
import { tx, withDb, type Db } from './db.js';
import type { Comment } from './comment-types.js';

function deliveredIds(d: Db, sessionId: string): Set<string> {
  return new Set(
    (d.prepare('SELECT comment_id FROM comment_deliveries WHERE session_id = ?').all(sessionId) as Array<{ comment_id: string }>)
      .map((r) => r.comment_id),
  );
}

/** Norm-path comparison that mirrors what we do server-side. */
function normalize(p: string): string {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

/** Map a Claude cwd back to a session. Tries direct-match against any
 *  session's path first, then ancestor match (so cwd inside a subdir of a
 *  worktree still resolves to the worktree's session). */
export function findSessionForCwd(
  cwd: string,
  sessions: WorktreeSession[] = loadHistory(),
): WorktreeSession | null {
  const here = normalize(cwd);
  // Deepest root containing cwd wins, so nested worktrees disambiguate. A
  // group's roots include the group root (the sub-repos' parent) — that's
  // where `work tree` launches Claude for a group, so hooks fire from there.
  let best: { session: WorktreeSession; len: number } | null = null;
  for (const s of sessions) {
    const roots = s.isGroup && s.paths[0] ? [...s.paths, path.dirname(s.paths[0])] : s.paths;
    for (const root of roots) {
      const r = normalize(root);
      if ((here === r || here.startsWith(r + '/')) && (!best || r.length > best.len)) {
        best = { session: s, len: r.length };
      }
    }
  }
  return best?.session ?? null;
}

function isPendingFor(delivered: Set<string>) {
  return (c: Comment) =>
    c.status === 'published' && c.author === 'user' && !delivered.has(c.id);
}

/** Returns published user comments that haven't been delivered yet.
 *  Reads through the file-store cache so we see in-flight writes
 *  (`session-meta.ts` and other readers couldn't, when they re-read the
 *  disk directly). */
export function readPendingForSession(sessionId: string): Comment[] {
  const delivered = withDb((d) => deliveredIds(d, sessionId));
  return readStoreComments(sessionId).filter(isPendingFor(delivered));
}

/** Comment-store ids for every `wd` scope that could cover this worktree.
 *  A scope is keyed by `sha1` of its sorted repo roots (see
 *  `repo-spec.scopeHashFor`), so from a session's paths we can rebuild the
 *  exact ids without consulting `work web`'s in-memory scope registry:
 *    - the whole-set hash → a group `wd` opened at the group root, or the
 *      single-repo `wd` (one path);
 *    - each individual path's hash → a `wd` opened inside one sub-repo of a
 *      group worktree.
 *  `registerScope` hashes `path.resolve()`d roots, so we resolve here too or
 *  the hashes won't line up. Mirrors `scope-manager.commentStoreIdForScope`
 *  (`scope-<hash>`). */
function scopeStoreIdsForPaths(paths: string[]): string[] {
  const resolved = paths.map((p) => path.resolve(p));
  const ids = new Set<string>();
  ids.add(`scope-${scopeHashFor(resolved)}`);
  for (const p of resolved) ids.add(`scope-${scopeHashFor([p])}`);
  return [...ids];
}

/**
 * Pending comments for a whole worktree: the session's own comment store
 * PLUS any `wd` / `wd -c` scope review store covering the same paths.
 *
 * `wd` registers its review under a scope-hash comment store, not the
 * session store the hook reads — without this merge, comments left in the
 * `wd` review UI would never reach the Claude running in that worktree.
 * Delivered-tracking stays per-session (one `<sessionId>.delivered.json`),
 * so a comment surfaced here won't be re-delivered regardless of which
 * store it came from.
 */
export function readPendingForWorktree(session: WorktreeSession): Comment[] {
  const sessionId = sessionIdFor(session);
  const delivered = withDb((d) => deliveredIds(d, sessionId));
  const pending = isPendingFor(delivered);
  const seen = new Set<string>();
  const out: Comment[] = [];
  const collect = (storeId: string) => {
    for (const c of readStoreComments(storeId)) {
      if (seen.has(c.id) || !pending(c)) continue;
      seen.add(c.id);
      out.push(c);
    }
  };
  collect(sessionId);
  for (const storeId of scopeStoreIdsForPaths(session.paths)) collect(storeId);
  return out;
}

/** Persist a delivery batch, so these ids are never surfaced again. */
export function markDelivered(sessionId: string, ids: string[]): void {
  if (ids.length === 0) return;
  tx((d) => {
    const ins = d.prepare('INSERT OR IGNORE INTO comment_deliveries (session_id, comment_id) VALUES (?, ?)');
    for (const id of ids) ins.run(sessionId, id);
  });
}

/**
 * Claim comments for delivery: of `ids`, return the ones nobody has
 * delivered yet, and mark them delivered — atomically. Two deliverers
 * racing (a Stop hook and the PTY push for the same comment) then can't
 * both send it: only the one that claimed it does. A deliverer whose send
 * fails gives the ids back with `releaseClaim`.
 */
export function claimForDelivery(sessionId: string, ids: string[]): string[] {
  if (ids.length === 0) return [];
  // INSERT OR IGNORE in one write transaction: a row inserted here is our
  // claim; one that already existed was someone else's.
  return tx((d) => {
    const ins = d.prepare('INSERT OR IGNORE INTO comment_deliveries (session_id, comment_id) VALUES (?, ?)');
    return ids.filter((id) => ins.run(sessionId, id).changes > 0);
  });
}

/** Undo a claim whose delivery failed, so the next hook picks them up. */
export function releaseClaim(sessionId: string, ids: string[]): void {
  if (ids.length === 0) return;
  tx((d) => {
    const del = d.prepare('DELETE FROM comment_deliveries WHERE session_id = ? AND comment_id = ?');
    for (const id of ids) del.run(sessionId, id);
  });
}

/** Cap the size of one comment body we surface to Claude. A pathologically
 *  long comment shouldn't blow out Claude's context — we truncate, then
 *  hint at the rest via "(truncated)". 4 KB is generous for a code-review
 *  note while leaving headroom for batches. */
const MAX_BODY_BYTES = 4 * 1024;
/** Overall cap on the whole system-reminder payload. Multiple long
 *  comments at once still get bounded. */
const MAX_TOTAL_BYTES = 32 * 1024;

/**
 * Format pending comments as a system-reminder block suitable for stdout.
 * Returns empty string when there's nothing pending — the caller (the
 * `work hook` CLI) just exits silently in that case.
 *
 * Truncates pathologically long bodies and caps the overall payload so
 * one runaway comment can't displace the rest of Claude's context.
 */
export function formatPendingForPrompt(pending: Comment[]): string {
  if (pending.length === 0) return '';

  const sorted = [...pending].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );

  const general = sorted.filter((c) => c.side === 'general' && !c.parentId);
  const inline = sorted.filter((c) => c.side !== 'general' && !c.parentId);
  const replies = sorted.filter((c) => c.parentId);

  const lines: string[] = [];
  lines.push('<system-reminder>');
  lines.push(
    `New review comments from \`work web\` (${pending.length} item${pending.length === 1 ? '' : 's'}):`,
  );
  lines.push('');

  if (general.length > 0) {
    lines.push('## General notes');
    for (const c of general) {
      // General notes (this is where `work broadcast` lands) may be multi-line
      // prompts — deliver the whole body, not just line 1. Only the byte cap
      // applies. Inline/reply comments still use the one-line `formatBody`.
      lines.push(formatFullBody('-', c));
    }
    lines.push('');
  }

  if (inline.length > 0) {
    lines.push('## Inline comments');
    for (const c of inline) {
      const where = `${c.repo}/${c.file}:${c.line} (${c.side})`;
      lines.push(formatBody(`- ${where}`, c));
    }
    lines.push('');
  }

  if (replies.length > 0) {
    lines.push('## Replies');
    for (const c of replies) {
      lines.push(formatBody(`- (reply to ${c.parentId})`, c));
    }
    lines.push('');
  }

  lines.push(
    'Address them as part of your next response. You can reply via the same review UI by posting back to the latest review URL at `~/.work/web.url` + `/api/sessions/<id>/comments` with `author: "claude"`.',
  );
  lines.push('</system-reminder>');
  const out = lines.join('\n');
  if (out.length <= MAX_TOTAL_BYTES) return out;
  const trimmed = out.slice(0, MAX_TOTAL_BYTES - 200);
  return (
    trimmed +
    '\n\n(…review payload truncated for context-window safety; ' +
    `${pending.length} comment(s) total — open work web for the full list.)\n` +
    '</system-reminder>'
  );
}

function formatBody(prefix: string, c: Comment): string {
  const lead = c.body.split('\n')[0].trim();
  const capped =
    lead.length > MAX_BODY_BYTES ? `${lead.slice(0, MAX_BODY_BYTES)}…` : lead;
  return `${prefix}: ${capped}${c.body.includes('\n') ? ' …' : ''}`;
}

/** Like `formatBody` but preserves the full multi-line body (only the byte
 *  cap applies). Multi-line bodies are emitted under the bullet, indented, so
 *  a broadcast prompt arrives intact rather than truncated to its first line. */
function formatFullBody(prefix: string, c: Comment): string {
  const body = c.body.trim();
  const capped =
    body.length > MAX_BODY_BYTES ? `${body.slice(0, MAX_BODY_BYTES)}…` : body;
  const bodyLines = capped.split('\n');
  if (bodyLines.length === 1) return `${prefix}: ${bodyLines[0]}`;
  const [first, ...rest] = bodyLines;
  return [`${prefix}: ${first}`, ...rest.map((l) => `  ${l}`)].join('\n');
}

/** Re-export so consumers don't have to know which module owns it. */
export { sessionIdFor };
