/**
 * The session record kept in ~/.work/history.json. Its own module (types
 * only, no imports) so low-level modules — port allocation, Claude activity
 * — can use it without importing history.ts, which imports them.
 */
export interface WorktreeSession {
  target: string;
  isGroup: boolean;
  branch: string;
  paths: string[];
  createdAt: string;
  lastAccessedAt: string;
  jiraKey?: string;
  /** Branch this worktree was forked from. Recorded when known at creation time.
   *  For groups with a single shared base this is that base; with per-repo bases
   *  it's the representative/default (see `baseBranches` for the per-repo map). */
  baseBranch?: string;
  /** Per-repo fork point, keyed by worktree path (same strings as `paths`).
   *  Set when `work tree --base alias=branch` gives repos different bases.
   *  Diff routes prefer this over `baseBranch` for a given repo. */
  baseBranches?: Record<string, string>;
  /** Stable dev-server port allocated to this worktree, exposed as $PORT. */
  port?: number;
  /** Set when archived (session-archive.ts): its conversation and a summary
   *  are kept under ~/.work/archive, its worktree removed when nothing would
   *  be lost, its branch kept. Re-entering it with `work tree` (or Restore)
   *  recreates the worktree and clears it. */
  archivedAt?: string;
  /** The AI tool was last launched with `--unsafe` (skip-permissions).
   *  Untrusted text (PR review comments) is never auto-delivered to it. */
  launchedUnsafe?: boolean;
}
