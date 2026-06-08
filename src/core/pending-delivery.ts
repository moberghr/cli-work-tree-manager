/**
 * Bridge between `work web` review comments and any live Claude session
 * running in the same worktree. Storage layout:
 *
 *   ~/.work/comments/<sessionId>.json          — full comment store (existing)
 *   ~/.work/comments/<sessionId>.delivered.json — array of comment ids that
 *                                                  have been surfaced to Claude
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
import {
  commentsDir,
  commentsFileFor,
  getCommentFileStore,
} from './comment-file-store.js';
import { scopeHashFor } from './repo-spec.js';
import type { Comment } from './comment-types.js';

function pathFor(sessionId: string): {
  comments: string;
  delivered: string;
} {
  return {
    comments: commentsFileFor(sessionId),
    delivered: path.join(commentsDir(), `${sessionId}.delivered.json`),
  };
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filePath);
}

/** Norm-path comparison that mirrors what we do server-side. */
function normalize(p: string): string {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

/** Map a Claude cwd back to a session. Tries direct-match against any
 *  session's path first, then ancestor match (so cwd inside a subdir of a
 *  worktree still resolves to the worktree's session). */
export function findSessionForCwd(cwd: string): WorktreeSession | null {
  const norm = normalize(cwd);
  const sessions = loadHistory();
  // Direct match: cwd == one of the session's paths.
  for (const s of sessions) {
    for (const p of s.paths) {
      if (normalize(p) === norm) return s;
    }
  }
  // Ancestor match: cwd starts with one of the session's paths + sep.
  // Pick the longest matching prefix so nested worktrees disambiguate.
  let best: { session: WorktreeSession; len: number } | null = null;
  for (const s of sessions) {
    for (const p of s.paths) {
      const np = normalize(p);
      if (norm.startsWith(np + '/') && (!best || np.length > best.len)) {
        best = { session: s, len: np.length };
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
  const paths = pathFor(sessionId);
  const comments = getCommentFileStore(sessionId).snapshot();
  const delivered = new Set(readJson<string[]>(paths.delivered, []));
  return comments.filter(isPendingFor(delivered));
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
  const delivered = new Set(
    readJson<string[]>(pathFor(sessionId).delivered, []),
  );
  const pending = isPendingFor(delivered);
  const seen = new Set<string>();
  const out: Comment[] = [];
  const collect = (storeId: string) => {
    for (const c of getCommentFileStore(storeId).snapshot()) {
      if (seen.has(c.id) || !pending(c)) continue;
      seen.add(c.id);
      out.push(c);
    }
  };
  collect(sessionId);
  for (const storeId of scopeStoreIdsForPaths(session.paths)) collect(storeId);
  return out;
}

/** Persist a delivery batch. Adds these ids to the delivered set so they
 *  never get re-surfaced. */
export function markDelivered(sessionId: string, ids: string[]): void {
  if (ids.length === 0) return;
  const paths = pathFor(sessionId);
  const delivered = new Set(readJson<string[]>(paths.delivered, []));
  for (const id of ids) delivered.add(id);
  writeAtomic(paths.delivered, JSON.stringify(Array.from(delivered), null, 2));
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
