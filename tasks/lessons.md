# Lessons

> Team-wide lessons captured during /mtk workflows.

## Don't gate an action on a state transition you read from a field with a non-obvious default
- **What happened:** Idle notifications were gated on `!pty.idle` read before `setIdle(true)`. `PtySession._idle` defaults to `true`, so a session whose first hook event was `Stop` (no preceding `prompt_submit`) had `wasIdle === true` and the first notification was silently dropped.
- **Rule:** When firing on a transition, track the decision in state you own (here a per-session `Set` cleared on the opposite event) rather than inferring it from another component's field whose initial value you don't control.
- **Why it matters:** The feature's whole purpose (alert when a background session finishes) failed exactly in the common "started already running" path.
- **When it applies:** Any "notify/act once per edge" logic layered on top of pre-existing status state.

## Worktree dev setup: `npm ci`, don't symlink node_modules across diverged branches
- **What happened:** Symlinking the parent checkout's `node_modules` into a fresh worktree produced phantom `tsc` errors (`Cannot find module 'hono'/'zod'`) because the parent predated deps added by a newer merged PR.
- **Rule:** Run `npm ci` inside a new worktree instead of symlinking, unless you've confirmed `package.json` is identical to the source of the linked `node_modules`.
- **When it applies:** Any background-session worktree isolation where the base branch is ahead of the working checkout.

## Control-char regexes: write `\uXXXX`, not raw bytes
- **What happened:** Typing a literal control-character range into a regex via the editor embedded raw bytes, making the line un-matchable for later edits and unclear in review.
- **Rule:** Always express control-character classes as explicit escapes, e.g. `/[\u0000-\u001f\u007f]/g`.
