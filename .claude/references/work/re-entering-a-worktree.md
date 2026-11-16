# Re-entering a worktree (pull + resume)

`work tree` is both "create" and "switch back", and switching back is the common case. Whenever the target checkout already exists — an existing worktree, or the base repo when the branch positional is omitted — two things happen before the AI tool launches:

- **Pull.** `pullLatestForBranch()` (`core/worktree/worktree.ts`) runs fetch + pull in that directory. Best-effort by design: a branch with no upstream returns early (a bare `git pull` there prints a "no tracking information" error that reads as a failure), and a pull blocked by a dirty tree or conflicts only warns. It must never block getting into the worktree. Threaded through `setupWorktree(..., { pull })` → `createSingleWorktree(..., pull)`; `--no-pull` sets it false. A freshly created worktree skips this — it is already at the branch tip.
- **Resume.** `launchTool()` in `commands/tree.ts` passes `resume: true` so the tool gets its resume flag (`--continue` for Claude Code). Gated on `hasClaudeConversation(dir)` (`agents/claude/activity.ts`, a transcript-exists check over `~/.claude/projects/<encoded-cwd>/*.jsonl`) because `--continue` hard-errors with "No conversation found to continue" in a directory Claude has never run in — the same gate `work resume` and the PTY host use. `--fresh` opts out.

§ WHEN adding another launch path, resolve the resume flag through `hasClaudeConversation` rather than passing `--continue` unconditionally.

**A repo's own checkout stays on its branch.** Branches are work's: new work gets a worktree. A session on a repo's own folder (`work tree <repo>`, no branch; `isOwnCheckout`, `core/worktree/own-checkout.ts`) gets `ownCheckoutNote` on every turn start (`runTurnHook`): stay on its branch, don't create, switch or check out branches, don't open PRs from it, ask for a worktree instead. The PR watch never archives one (`ownCheckout`).
