# Configuration

Stored at `~/.work/config.json`. Schema in `core/platform/config.ts`:
- `worktreesRoot` — parent directory for all worktrees
- `repos` — map of alias → repo path
- `groups` — map of group name → array of repo aliases
- `scanRoots` — folders the Repos page scans for git repos (default: the folder holding `worktreesRoot`); `ignoredRepos` — repo folders it leaves out of New
- `copyFiles` — glob patterns for files to copy into new worktrees (e.g., local dev settings)
- `sessionFolders` — opt in (default off, experimental): every new session is a folder of repos, a single repo too (`<worktreesRoot>/<branch-dir>-<id6>/<repo-folder>/`, recorded as a folder session with `repos: [alias]`), so Add a repo works on it; its instructions file imports each repo's own (`core/worktree/session-instructions.ts`: a `<!-- work:repos -->` block, the rest of the file kept; a file that can't be read is never overwritten), and a group made with it on gets the same instead of the generated `~/.work/<group>.claude.md` — recorded on the session (`instructions: 'imports'`), so a Restore makes it the same way whatever the switch says then. Re-entry follows the session's row, not the switch: existing sessions keep their layout and their copied summary
- `reviews` — automatic PR reviews: `projects` (alias or group → `all` | `asked` | `off`), `maxPerDay`, `maxLines`, `rules` (see Reviews)
- `prWatch.requiredChecks` — per repo (by alias — a group session's folders matched to it — or the host's `owner/name`), the checks that count where the host requires none (see PR watch, Which failed checks count)
- `gitHosts` — an origin hostname → the git host it is, for an origin no adapter claims by its URL (see Git hosts; GitHub Enterprise needs no entry)
- `hostEnv` — environment variable names a restored PTY-host session keeps from the shell that started it (secret-looking names never)
- `agentsLowPriority` — start each session's agent below normal priority (default off): what it runs — builds, tests — inherits it, takes the idle cores and gives way to what you look at (`lowerPriority`, `pty-session.ts`: `os.setPriority` on the agent's pid right after the start; agents only, never a login terminal; a refusal is logged and the agent runs on). Read at each agent start (reported: two sessions' test runs and a compile filled a 15-watt CPU and typing froze)
- `useBundledConpty` — Windows: terminals start on node-pty's bundled ConPTY instead of Windows' own (see PTY host)
- `aiCommand` / `aiCommandFlags` — the agent new sessions run (Claude Code by default); `internalAgent` — the one that writes work's summaries; `assistantAgent` — the one the Ctrl+K assistant runs (both `claude` by default; see Agents)

- `reviews.focus` (a list) and `reviews.focusFor` (`{ "<repo alias>": [ … ] }`): what the Reviews AI step is told to pay attention to, for every review and for a repo's (see reviews.md, "What reviews pay attention to"). Your words are instructions to it, so they live in work's config, not in the repo.
