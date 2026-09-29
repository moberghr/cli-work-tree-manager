import { readSessionMeta } from './session-meta.js';
import { sessionIdFor } from './web-state.js';
import { readContextUsage } from './context-usage.js';
import { bestEffort } from './best-effort.js';
import type { WorktreeSession } from './history.js';
import type { DiffStat, SessionWire } from './api-types.js';

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
}

export function sessionWire(s: WorktreeSession, opts: SessionWireOptions = {}): SessionWire {
  const id = sessionIdFor(s);
  const meta = readSessionMeta(id, s);
  return {
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
    lastActivity: meta.lastActivity,
    activityState: meta.activityState,
    pendingForClaudeCount: meta.pendingForClaudeCount,
    attention: meta.attention,
    diffStat: opts.diffStatFor ? opts.diffStatFor(id, s, meta.attention !== null) : null,
    archivedAt: s.archivedAt ?? null,
    port: s.port ?? null,
    context: s.archivedAt ? null : bestEffort(`context usage for ${s.target}:${s.branch}`, () => readContextUsage(s), null),
  };
}

/** Newest sign of life (ms): the hook update, Claude's last write, the
 *  `work tree` entry — the same rule as the dashboard's "Last active". */
export function lastActiveMs(w: Pick<SessionWire, 'lastAccessedAt' | 'lastActivity' | 'attention'>): number {
  return Math.max(Date.parse(w.lastAccessedAt) || 0, w.lastActivity ?? 0, w.attention ? Date.parse(w.attention.updatedAt) || 0 : 0);
}
