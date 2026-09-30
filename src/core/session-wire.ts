import { readSessionMeta } from './session-meta.js';
import { sessionIdFor } from './web-state.js';
import { readContextUsage } from './context-usage.js';
import { bestEffort } from './best-effort.js';
import type { WorktreeSession } from './history.js';
import type { DiffStat, SessionArchiveInfo, SessionClaudes, SessionWire } from './api-types.js';
import { readArchive } from './session-archive.js';

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
}

export function sessionWire(s: WorktreeSession, opts: SessionWireOptions = {}): SessionWire {
  const id = sessionIdFor(s);
  const meta = readSessionMeta(id, s);
  const shadowed = opts.shadowed?.(id) ?? false;
  const claudes = shadowed ? null : (opts.claudesFor?.(id) ?? null);
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
    lastActivity: shadowed ? null : meta.lastActivity,
    // A running Claude is open even when it writes nothing (idle at its prompt).
    activityState: shadowed ? 'stale' : claudes ? (claudes.busy ? 'active' : meta.activityState === 'active' ? 'active' : 'open') : meta.activityState,
    ...(claudes ? { claudes } : {}),
    ...(s.archivedAt ? archiveInfo(id) : {}),
    pendingForClaudeCount: meta.pendingForClaudeCount,
    attention: meta.attention,
    diffStat: opts.diffStatFor ? opts.diffStatFor(id, s, meta.attention !== null) : null,
    archivedAt: s.archivedAt ?? null,
    port: s.port ?? null,
    context: s.archivedAt ? null : bestEffort(`context usage for ${s.target}:${s.branch}`, () => readContextUsage(s), null),
  };
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
    },
  };
}

/** Newest sign of life (ms): the hook update, Claude's last write, the
 *  `work tree` entry — the same rule as the dashboard's "Last active". */
export function lastActiveMs(w: Pick<SessionWire, 'lastAccessedAt' | 'lastActivity' | 'attention'>): number {
  return Math.max(Date.parse(w.lastAccessedAt) || 0, w.lastActivity ?? 0, w.attention ? Date.parse(w.attention.updatedAt) || 0 : 0);
}
