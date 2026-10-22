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
  /** The repo alias each of `paths` is a checkout of: same order and length.
   *  The session owns this list (a group's may differ from the group's config
   *  now). Absent on rows from before it was recorded: read it through
   *  `sessionRepos` / `sessionAliases` (session-repos.ts), which derive those. */
  repos?: string[];
  /** How its folder's instructions file is made, recorded so a Restore (whose
   *  worktree, file and all, was removed) makes it the same way whatever config
   *  says now: `imports` = a work block importing each repo's own
   *  (session-instructions.ts); `summary+imports` = the group's copied summary
   *  with that block after it (a group session a repo was added to). Absent: the
   *  group's copied summary (`~/.work/<group>.claude.md`), as before. */
  instructions?: SessionInstructions;
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
  /** The agent it runs (`claude`, `codex`, …: agents/), recorded when it was
   *  created — when work has an adapter for it — so changing the default
   *  (config `aiCommand`) doesn't change what an existing session runs.
   *  Absent: from before, or an unknown command; it follows `aiCommand`. */
  agent?: string;
  /** The name you gave it (the dashboard's rename); otherwise it is named
   *  after its first prompt (session-title.ts). */
  title?: string;
}

/** How a session folder's instructions file is made (WorktreeSession.instructions). */
export type SessionInstructions = 'imports' | 'summary+imports';
