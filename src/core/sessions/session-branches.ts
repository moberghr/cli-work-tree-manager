import path from 'node:path';
import { json, tx, withDb } from '../platform/db.js';
import { checkedOutBranch, gitDirs } from '../git/git-head.js';
import { branchCreatedFrom, branchLogChangedSince, branchStart, checkoutBranchHistory } from '../git/reflog.js';
import type { WorktreeSession } from './session-types.js';
import { sessionIdFor } from './session-id.js';

/**
 * Every branch a session's repos have been on, recorded as it goes — so the
 * dashboard shows the work on all of them without asking git each time.
 * Claude often moves on in the same worktree: a PR merges, and the next fix
 * is a new branch made from origin/dev, then another. Only the checked-out
 * branch was ever looked at, so the earlier one's commits and PR (and the
 * first new one's, once a second came) vanished from the session.
 *
 * Per session in state.db `session_branches` (schema v12, gone with the
 * session: purgeSessionRows): each repo's branches with when they were first
 * and last checked out, and where they were made from when the reflog says.
 * Written at each turn's end (the turn-end hook reads HEAD files, no git),
 * when work checks a branch out (setupWorktree, Update), and once from the
 * reflog for a session recorded before (`backfilled`).
 */

export interface RecordedBranch {
  /** The repo, as the session names it (Ship and the PR watch): a group's folder, else the target. */
  repo: string;
  name: string;
  /** ISO. */
  firstSeen: string;
  lastSeen: string;
  /** The branch or ref it was made from (`origin/dev`), when known. */
  from?: string;
  /** When it was first seen deleted (the branch facts' look): a merged one stops showing after a while. */
  gone?: string;
  /** It was seen merged (its commits in main, or its PR merged): kept so a deleted one still reads merged. */
  merged?: true;
  /** It was seen on origin once: its PR is asked about even after origin's copy was deleted (a merge's tidy-up). */
  pushed?: true;
  /** The commit it was made at (its reflog's first line): its own work is what it has beyond it, merged or not. */
  start?: string;
  /** Its tip when last looked at (the branch facts): what the Diff tab shows of it once it is deleted. */
  tip?: string;
}

export interface SessionBranches {
  branches: RecordedBranch[];
  /** When its reflog was read for the branches before the record began (once per session). */
  backfilled?: string;
}

/** Most branches kept per repo: the ones last seen longest ago go. */
export const MAX_BRANCHES_PER_REPO = 30;

const isIso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const isSha = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{40,64}$/.test(v);

/** A stored record, shape-checked; entries that don't hold up are dropped, not the record. */
export function cleanBranches(raw: unknown): SessionBranches | null {
  const o = raw as { branches?: unknown; backfilled?: unknown } | null;
  if (!o || typeof o !== 'object' || !Array.isArray(o.branches)) return null;
  const branches: RecordedBranch[] = [];
  for (const b of o.branches as unknown[]) {
    const x = b as Partial<Record<keyof RecordedBranch, unknown>> | null;
    if (!x || typeof x !== 'object' || typeof x.repo !== 'string' || !x.repo || typeof x.name !== 'string' || !x.name) continue;
    if (!isIso(x.firstSeen) || !isIso(x.lastSeen)) continue;
    branches.push({
      repo: x.repo,
      name: x.name,
      firstSeen: x.firstSeen,
      lastSeen: x.lastSeen,
      ...(typeof x.from === 'string' && x.from ? { from: x.from } : {}),
      ...(isIso(x.gone) ? { gone: x.gone } : {}),
      ...(x.merged === true ? { merged: true as const } : {}),
      ...(x.pushed === true ? { pushed: true as const } : {}),
      ...(isSha(x.start) ? { start: x.start } : {}),
      ...(isSha(x.tip) ? { tip: x.tip } : {}),
    });
  }
  return { branches, ...(isIso(o.backfilled) ? { backfilled: o.backfilled } : {}) };
}

export function readSessionBranches(sessionId: string): SessionBranches | null {
  const row = withDb(
    (d) => d.prepare('SELECT data FROM session_branches WHERE session_id = ?').get(sessionId) as { data: string } | undefined,
  );
  return row ? cleanBranches(json.parse(row.data)) : null;
}

/** Every session's record, in one query (the sessions list reads them per build). */
export function allSessionBranches(): Map<string, SessionBranches> {
  const rows = withDb(
    (d) => d.prepare('SELECT session_id, data FROM session_branches').all() as Array<{ session_id: string; data: string }>,
  );
  const out = new Map<string, SessionBranches>();
  for (const r of rows) {
    const b = cleanBranches(json.parse(r.data));
    if (b) out.set(r.session_id, b);
  }
  return out;
}

/** A branch seen checked out (or found in the reflog): its repo, name, and when. */
export interface BranchSighting {
  repo: string;
  name: string;
  /** ISO; default now. */
  firstSeen?: string;
  lastSeen?: string;
  from?: string;
  /** The commit it was made at, when its reflog says. */
  start?: string;
}

/** lastSeen is written again only when it moved this much: a turn's end needn't write the row every time. */
export const LAST_SEEN_STEP_MS = 10 * 60_000;

/**
 * The record with these sightings: a new branch appended, a known one's first
 * and last sighting widened, its `from` filled in when it had none; a branch
 * seen again un-gone. Returns the record unchanged (the same object) when
 * nothing worth a write moved. Pure.
 */
export function withSightings(
  rec: SessionBranches | null,
  seen: BranchSighting[],
  now: Date,
  opts: { backfilled?: boolean } = {},
): SessionBranches {
  const base: SessionBranches = rec ?? { branches: [] };
  let changed = !rec || (opts.backfilled === true && !base.backfilled);
  const branches = base.branches.map((b) => ({ ...b }));
  const nowIso = now.toISOString();
  for (const s of seen) {
    const first = s.firstSeen ?? nowIso;
    const last = s.lastSeen ?? nowIso;
    const b = branches.find((x) => x.repo === s.repo && x.name === s.name);
    if (!b) {
      branches.push({
        repo: s.repo,
        name: s.name,
        firstSeen: first,
        lastSeen: last,
        ...(s.from ? { from: s.from } : {}),
        ...(s.start ? { start: s.start } : {}),
      });
      changed = true;
      continue;
    }
    if (Date.parse(first) < Date.parse(b.firstSeen)) {
      b.firstSeen = first;
      changed = true;
    }
    if (Date.parse(last) - Date.parse(b.lastSeen) >= LAST_SEEN_STEP_MS) {
      b.lastSeen = last;
      changed = true;
    }
    if (s.from && !b.from) {
      b.from = s.from;
      changed = true;
    }
    // Where its own work begins moves when it is rebased or fast-forwarded: the newest reading wins.
    if (s.start && b.start !== s.start) {
      b.start = s.start;
      changed = true;
    }
    if (b.gone && s.lastSeen === undefined) {
      // Checked out now: it exists again.
      delete b.gone;
      changed = true;
    }
  }
  if (!changed) return base;
  // Per repo, the most recent MAX_BRANCHES_PER_REPO.
  const kept: RecordedBranch[] = [];
  for (const repo of [...new Set(branches.map((b) => b.repo))]) {
    const mine = branches.filter((b) => b.repo === repo);
    const keep = new Set([...mine].sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen)).slice(0, MAX_BRANCHES_PER_REPO));
    kept.push(...mine.filter((b) => keep.has(b)));
  }
  return {
    branches: kept,
    ...(base.backfilled ? { backfilled: base.backfilled } : opts.backfilled ? { backfilled: nowIso } : {}),
  };
}

function write(sessionId: string, rec: SessionBranches): void {
  withDb((d) => d.prepare('INSERT OR REPLACE INTO session_branches (session_id, data) VALUES (?, ?)').run(sessionId, JSON.stringify(rec)));
}

/** Record sightings, in one transaction over the row as it is now. Returns the record after; writes only when something moved. */
export function noteBranches(
  sessionId: string,
  seen: BranchSighting[],
  now = new Date(),
  opts: { backfilled?: boolean } = {},
): SessionBranches {
  return tx((d) => {
    const row = d.prepare('SELECT data FROM session_branches WHERE session_id = ?').get(sessionId) as { data: string } | undefined;
    const old = row ? cleanBranches(json.parse(row.data)) : null;
    const next = withSightings(old, seen, now, opts);
    if (next !== old) write(sessionId, next);
    return next;
  });
}

/**
 * What the branch facts saw of recorded branches: deleted (gone, from when it
 * was first seen so), or merged. One transaction; writes only a change.
 */
export function noteBranchFacts(
  sessionId: string,
  facts: Array<{ repo: string; name: string; exists: boolean; merged: boolean; pushed?: boolean; sha?: string | null }>,
  now = new Date(),
): void {
  tx((d) => {
    const row = d.prepare('SELECT data FROM session_branches WHERE session_id = ?').get(sessionId) as { data: string } | undefined;
    const rec = row ? cleanBranches(json.parse(row.data)) : null;
    if (!rec) return;
    let changed = false;
    for (const f of facts) {
      const b = rec.branches.find((x) => x.repo === f.repo && x.name === f.name);
      if (!b) continue;
      if (!f.exists && !b.gone) {
        b.gone = now.toISOString();
        changed = true;
      } else if (f.exists && b.gone) {
        delete b.gone;
        changed = true;
      }
      if (f.merged && !b.merged) {
        b.merged = true;
        changed = true;
      }
      if (f.pushed && !b.pushed) {
        b.pushed = true;
        changed = true;
      }
      if (f.exists && f.sha && isSha(f.sha) && b.tip !== f.sha) {
        b.tip = f.sha;
        changed = true;
      }
    }
    if (changed) write(sessionId, rec);
  });
}

/** A session's repo as Ship and the PR watch name it: a group's folder, a single repo's target. */
export const repoNameOf = (s: Pick<WorktreeSession, 'isGroup' | 'target'>, checkout: string): string =>
  s.isGroup ? path.basename(checkout) : s.target;

/**
 * Record the branch each of the session's repos has checked out now (HEAD
 * files: no git), and for a branch new to the record, where it was made from
 * (its reflog's first line). The turn-end hook's step; cheap. Returns the
 * record after, or null when nothing is checked out on a branch.
 */
export function recordCheckedOutBranches(
  s: Pick<WorktreeSession, 'target' | 'branch' | 'isGroup' | 'paths' | 'archivedAt'>,
  now = new Date(),
): SessionBranches | null {
  if (s.archivedAt) return null;
  const id = sessionIdFor(s);
  const seen: BranchSighting[] = [];
  const known = readSessionBranches(id);
  for (const p of s.paths) {
    const name = checkedOutBranch(p);
    if (!name) continue;
    const repo = repoNameOf(s, p);
    const had = known?.branches.find((b) => b.repo === repo && b.name === name);
    const dirs = gitDirs(p);
    // A new branch: where it came from. Every turn: where its own work begins (a rebase or fast-forward moves it),
    // kept so the Diff tab still has it once the branch — and its reflog — are deleted.
    const from = (!had && dirs && branchCreatedFrom(dirs.commonDir, name)) || undefined;
    // Read only when its reflog was written since the record last saw it (a stat): a repo's own main has a reflog
    // of thousands of lines, and this runs at every turn's end of every Claude.
    const stale = !had?.start || (dirs ? branchLogChangedSince(dirs.commonDir, name, had.lastSeen) : false);
    const start = stale ? (dirs && branchStart(dirs.commonDir, name)) || undefined : had?.start;
    seen.push({ repo, name, ...(from && from !== name ? { from } : {}), ...(start ? { start } : {}) });
  }
  if (!seen.length) return null;
  // Nothing moved (the usual turn end): no write transaction at all.
  if (known && withSightings(known, seen, now) === known) return known;
  return noteBranches(id, seen, now);
}

/**
 * Once per session recorded before the list began: the branches its repos'
 * reflogs show they were on (the session's own branch included), merged into
 * the record and marked backfilled. File reads only; run it in the
 * background, never on a request's path. Returns the record after.
 */
export function backfillSessionBranches(
  s: Pick<WorktreeSession, 'target' | 'branch' | 'isGroup' | 'paths' | 'createdAt'>,
  now = new Date(),
): SessionBranches {
  const id = sessionIdFor(s);
  const seen: BranchSighting[] = [];
  for (const p of s.paths) {
    const repo = repoNameOf(s, p);
    const history = checkoutBranchHistory(p, s.branch);
    if (!history.some((b) => b.name === s.branch) && s.createdAt) {
      // The session's own branch, even when its reflog is gone or cut short.
      seen.push({ repo, name: s.branch, firstSeen: s.createdAt, lastSeen: s.createdAt });
    }
    for (const b of history) {
      seen.push({
        repo,
        name: b.name,
        firstSeen: new Date(b.firstSeen || Date.parse(s.createdAt) || now.getTime()).toISOString(),
        lastSeen: new Date(b.lastSeen || b.firstSeen || now.getTime()).toISOString(),
        ...(b.from ? { from: b.from } : {}),
        ...(b.start ? { start: b.start } : {}),
      });
    }
  }
  return noteBranches(id, seen, now, { backfilled: true });
}

/** A recorded branch that was seen on origin once (its PR is worth asking about even with origin's copy gone). */
export function wasPushed(rec: SessionBranches | null | undefined, repo: string, name: string): boolean {
  return !!rec?.branches.some((b) => b.repo === repo && b.name === name && b.pushed);
}

/** How long a merged branch that was deleted goes on showing. */
export const GONE_SHOWN_MS = 3 * 24 * 3600_000;

/** A recorded branch no longer worth showing: deleted, merged, and that a while ago (kept in the record). */
export function branchHidden(b: Pick<RecordedBranch, 'gone' | 'merged'>, now: number, prMerged = false): boolean {
  if (!b.gone || !(b.merged || prMerged)) return false;
  return now - Date.parse(b.gone) >= GONE_SHOWN_MS;
}

/** How long after it was last checked out another branch is still looked at (the PR watch's window). */
export const BRANCH_WATCH_MS = 30 * 24 * 3600_000;

/** At most this many other branches per repo are asked about (git facts, the host's PR). */
export const MAX_WATCHED_BRANCHES = 5;

/**
 * A repo's recorded branches other than the one checked out that are worth a
 * look: seen within `withinMs`, not hidden, newest first, at most
 * MAX_WATCHED_BRANCHES. Pure.
 */
export function otherBranchesToWatch(
  rec: SessionBranches | null | undefined,
  repo: string,
  current: string | null,
  now: number,
  withinMs: number,
): string[] {
  return (rec?.branches ?? [])
    .filter((b) => b.repo === repo && b.name !== current && now - Date.parse(b.lastSeen) <= withinMs && !branchHidden(b, now))
    .sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen))
    .slice(0, MAX_WATCHED_BRANCHES)
    .map((b) => b.name);
}
