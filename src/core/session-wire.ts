import fs from 'node:fs';
import { readStatus } from './session-status.js';
import { snoozeActive, type Snooze } from './snooze.js';
import { withLiveClaude } from './session-status.js';
import path from 'node:path';
import { readSessionMeta } from './session-meta.js';
import { checkedOutBranch } from './git-head.js';
import { sessionIdFor } from './web-state.js';
import { readContextUsage } from './context-usage.js';
import { bestEffort } from './best-effort.js';
import type { WorktreeSession } from './history.js';
import type { DiffStat, SessionArchiveInfo, SessionAttention, SessionClaudes, SessionWire, BlockerWire } from './api-types.js';
import { readArchive } from './session-archive.js';
import { sessionTitle } from './session-title.js';

/**
 * One session as every client sees it — the dashboard's /api/sessions rows
 * and `work sessions --json` alike: identity, status, activity, comments,
 * context, archive state. Built in one place so the two can't drift.
 */
export interface SessionWireOptions {
  /** The session's `+N −M`, when the caller has one (the web cache). */
  diffStatFor?: (id: string, s: WorktreeSession, hasStatus: boolean) => DiffStat | null;
  /** Whether its Claude runs in the PTY host (the CLI asks the host; the
   *  web server's pool knows it already). */
  ptyLive?: (id: string) => boolean;
  /** Its running Claudes, wherever they were started (live-claudes.ts). */
  claudesFor?: (id: string) => SessionClaudes | null;
  /** It shares its folder with another session that owns it
   *  (shared-folders.ts): the folder's activity isn't this one's. */
  shadowed?: (id: string) => boolean;
  /** Unresolved review threads on its open PRs (the PR watch's last check). */
  reviewThreadsFor?: (id: string) => number;
  /** Reply drafts its Claude wrote for you to post (pr-replies.ts). */
  replyDraftsFor?: (id: string) => number;
  /** You have notes on it (session-notes.ts). */
  hasNote?: (id: string) => boolean;
  /** What it waits on that isn't done yet (session-blocks.ts). */
  blockedByFor?: (id: string) => BlockerWire[];
  /** The running Claudes were read against a real process list, so "none" means none. */
  liveKnown?: boolean;
  /** A Claude of ours runs for it (PTY host, chat), whether or not Claude Code's file shows it yet. */
  hostedLive?: (id: string) => boolean;
  /** A status read from its terminal output, for a tool with no hooks (output-status.ts). */
  outputStatusFor?: (id: string) => SessionAttention | null;
  /** Its snooze, if any (snooze-store.ts); shown only while it holds. */
  snoozeFor?: (id: string) => Snooze | null;
  /** How far behind main — or the session it is stacked on — it is (behind-main.ts's cache). */
  behindFor?: (id: string, s: WorktreeSession) => { base: string; commits: number; conflicts: boolean; stacked?: true } | null;
  /** Where it sits in a stack (stack-sessions.ts). */
  stackFor?: (id: string) => { parent: { id: string; branch: string; title?: string } | null; children: number; merged?: { id: string; branch: string } | null };
}

export function sessionWire(s: WorktreeSession, opts: SessionWireOptions = {}): SessionWire {
  const id = sessionIdFor(s);
  const meta = readSessionMeta(id, s);
  const shadowed = opts.shadowed?.(id) ?? false;
  const claudes = shadowed ? null : (opts.claudesFor?.(id) ?? null);
  const reviewThreads = s.archivedAt ? 0 : (opts.reviewThreadsFor?.(id) ?? 0);
  const replyDrafts = s.archivedAt ? 0 : (opts.replyDraftsFor?.(id) ?? 0);
  const wire: SessionWire = {
    id,
    target: s.target,
    branch: s.branch,
    isGroup: s.isGroup,
    paths: s.paths,
    baseBranch: s.baseBranch,
    jiraKey: s.jiraKey,
    createdAt: s.createdAt,
    lastAccessedAt: s.lastAccessedAt,
    draftCount: meta.draftCount,
    commentCount: meta.commentCount,
    claudeCount: meta.claudeCount,
    ptyStatus: opts.ptyLive ? (opts.ptyLive(id) ? 'running' : 'idle') : meta.ptyStatus,
    lastActivity: shadowed ? null : meta.lastActivity,
    // A running Claude is open even when it writes nothing (idle at its prompt).
    activityState: shadowed ? 'stale' : claudes ? (claudes.busy ? 'active' : meta.activityState === 'active' ? 'active' : 'open') : meta.activityState,
    ...(claudes ? { claudes } : {}),
    ...(s.archivedAt ? archiveInfo(id) : {}),
    title: bestEffort(`title of ${s.target}:${s.branch}`, () => sessionTitle(s, s.archivedAt ? readArchive(id)?.summary.prompts[0]?.text : null), null),
    ...(s.title ? { titleIsYours: true } : {}),
    pendingForClaudeCount: meta.pendingForClaudeCount,
    // Claude Code's own state file over what the hooks recorded, when newer.
    attention: meta.attention && !shadowed && opts.claudesFor
      ? withLiveClaude(meta.attention, claudes, { known: opts.liveKnown === true, hosted: opts.hostedLive?.(id) ?? true })
      : (meta.attention ?? (shadowed || s.archivedAt ? null : (opts.outputStatusFor?.(id) ?? null))),
    diffStat: opts.diffStatFor ? opts.diffStatFor(id, s, meta.attention !== null) : null,
    archivedAt: s.archivedAt ?? null,
    port: s.port ?? null,
    context: s.archivedAt ? null : bestEffort(`context usage for ${s.target}:${s.branch}`, () => readContextUsage(s), null),
    ...(reviewThreads > 0 ? { openReviewThreads: reviewThreads } : {}),
    ...(replyDrafts > 0 ? { replyDrafts } : {}),
    ...otherBranches(s),
  };
  // Snoozed: only while it holds (a time not yet reached, or the status it
  // was snoozed in). "Its status" is what the hooks recorded — the same the
  // snooze was taken against — not the shown one, which a live Claude's state
  // file can override (that would end a snooze the moment it was set).
  const snooze = s.archivedAt ? null : (opts.snoozeFor?.(id) ?? null);
  if (snooze && snoozeActive(snooze, { attention: readStatus(id), openReviewThreads: wire.openReviewThreads })) wire.snoozed = { until: snooze.until };
  const behind = s.archivedAt ? null : (opts.behindFor?.(id, s) ?? null);
  if (behind && behind.commits > 0) wire.behind = behind;
  const stack = s.archivedAt ? null : (opts.stackFor?.(id) ?? null);
  if (stack?.parent) wire.stackedOn = stack.parent;
  if (stack?.children) wire.stackedChildren = stack.children;
  if (stack?.merged) wire.stackParentMerged = stack.merged;
  if (opts.hasNote?.(id)) wire.hasNote = true;
  const blockers = s.archivedAt ? [] : (opts.blockedByFor?.(id) ?? []);
  if (blockers.length) wire.blockedBy = blockers;
  return wire;
}

/**
 * Repos of the session checked out on another branch than the session's
 * (read from HEAD files, no git). Ship and the PR watch follow the real
 * branch already; this is so the dashboard says so.
 */
export function otherBranches(s: Pick<WorktreeSession, 'branch' | 'paths' | 'target' | 'isGroup' | 'archivedAt'>): { onOtherBranch?: Array<{ repo: string; branch: string | null }> } {
  if (s.archivedAt || !s.branch) return {};
  const out: Array<{ repo: string; branch: string | null }> = [];
  for (const p of s.paths) {
    if (!fs.existsSync(p)) continue;
    const branch = checkedOutBranch(p);
    if (branch !== s.branch) out.push({ repo: s.isGroup ? path.basename(p) : s.target, branch });
  }
  return out.length ? { onOtherBranch: out } : {};
}

/** A session's unresolved review threads, from the PR watch's per-repo counts (open PRs only). */
export function reviewThreadsOf(ci: { repos: Array<{ pr: { state: string } | null; openThreads?: number }> } | null | undefined): number {
  return (ci?.repos ?? []).reduce((n, r) => n + (r.pr?.state === 'OPEN' ? (r.openThreads ?? 0) : 0), 0);
}

function archiveInfo(id: string): { archive?: SessionArchiveInfo } {
  const rec = readArchive(id);
  if (!rec) return {};
  return {
    archive: {
      worktreeRemoved: rec.worktreeRemoved,
      keptBecause: rec.keptBecause,
      promptCount: rec.summary.promptCount,
      prompts: rec.summary.prompts.map((p) => p.text),
      lastSummary: rec.summary.lastSummary,
      ...(rec.summary.written ? { written: rec.summary.written } : {}),
      ...(rec.buildFolders ? { buildFolders: rec.buildFolders } : {}),
    },
  };
}

/** Newest sign of life (ms): the hook update, Claude's last write, the
 *  `work tree` entry — the same rule as the dashboard's "Last active". */
export function lastActiveMs(w: Pick<SessionWire, 'lastAccessedAt' | 'lastActivity' | 'attention'>): number {
  return Math.max(Date.parse(w.lastAccessedAt) || 0, w.lastActivity ?? 0, w.attention ? Date.parse(w.attention.updatedAt) || 0 : 0);
}
