# CLI Commands

```
work init                                          # Interactive first-time setup: the worktrees and repos folders (suggested), then the repos found there to tick (the Repos page's scan and alias rules)
work tree|t <target> [branch] [--base <branch>|--base <alias>=<branch> ...] [--here] [--open] [--no-pull] [--fresh] [--prompt "..."] [--prompt-file <path>] [--issue-key <KEY>] [--name "..."] [--pr <link|#>] [--setup-only] [--host|--no-host] [--account <name>]  # Create/switch to worktree (--here infers target+branch from cwd; omit branch to work on the base repo; --pr: a PR's repo and its own branch — someone else's too, never a fork's — with a first prompt saying whose branch it is). --base is repeatable: a bare branch forks every repo, alias=branch sets per-repo bases for a group (e.g. --base backend=dev --base frontend=feat/x). --account: the Claude account a NEW session runs on (see `work account`; an existing session keeps its own). Switching into an existing checkout pulls + resumes the prior AI conversation; --no-pull / --fresh opt out. The AI session runs in the PTY host by default, with this terminal attached to it (like `work attach`; Ctrl+] detaches), forwarding this shell's env and --fresh/--prompt, so `work web` shows the same screen; --no-host (or config `launchViaHost: false`) launches directly in this terminal instead, invisible to the dashboard. The agent always starts in its own permission mode (`--unsafe` is retired: still accepted by `work tree` / `resume` / `recent` for one release, hidden, it only warns — `commands/shared/retired-unsafe.ts`; use Claude Code's own modes, e.g. auto mode); nothing work ships names a skip-permissions flag (`tests/architecture/no-skip-permissions.test.ts`)
work remove <target> <branch> [--force]            # Remove worktree
work add-repo <alias> [target] [branch] [--base <branch>]  # Check another repo out into a session folder on the session's branch (default: the session for this folder) — the dashboard's Add a repo… (core/worktree/add-repo.ts); through a running work web, else in-process (the note to its Claude then waits in its comments for the next turn)
work fork <branch> [--target <t> --from <branch>] [--prompt "..."] [--name "..."] [--no-attach]  # Fork a session (default: the one for this folder): a new branch + worktree from where it is, its Claude started with a summary of this conversation — the dashboard's Fork… (core/sessions/fork.ts); attaches this terminal to it like `work tree`
work list [target]                                 # List worktrees
work status [target] [branch] [--prune]            # Show worktree status (and every branch a session worked on, when more than one)
work recent [count]                                # List recent sessions
work resume                                        # Resume a recent session
work prune [--force]                               # Remove merged worktrees (pick from a list; squash merges offered). Same cleanup as the web view (core/cleanup/cleanup.ts); skips anything used in the last day
work sync [--dry-run] [--force] [--include-squash] # Fetch all repos + remove merged worktrees (non-interactive; skips dirty ones unless --force, never one with commits the main branch lacks; skips repos whose fetch failed)
work sessions [target] [--json] [--all] [--changes] # Every session with its status, as the dashboard shows it (--json = the /api/sessions rows + a `view` block: label, age, lastActive). --changes adds +N −M and same-file overlaps (runs git)
work digest [--since today|yesterday|week|<date>] [--json] # What each session did (Markdown standup note, or JSON). Asks a running work web (PR states, diff stats), else builds it from disk
work overlaps [--json]                             # Live sessions changing the same files of a repo
work search <query..> [--json]                     # Every session's conversation, live and archived, where all the words appear in one message (work's own copy: outlives Claude Code's 30 days)
work cleanup [--json] [--no-fetch]                 # Which worktrees can go, and why (the Clean up view's scan)
work cleanup --apply <id...> [--action delete|archive|forget] [--force] [--json] # Act on them, each re-checked first; exit 1 if any was refused
work cleanup --build-folders [--apply [<id>...]] [--json] # Build output git ignores (node_modules, bin/obj, .next, target…) in worktrees idle a week+ with no Claude running, never inside a nested repo/worktree; --apply clears it (idle + no Claude checked again first). Also in the Clean up view
work cleanup --branches [--apply] [--json]          # Local branches already in main: `git branch --merged`, or upstream gone + a MERGED PR whose head is exactly the tip (squash). Never a checked-out, long-lived (main/dev/…) or current session's branch; an archived session's is listed but not deleted by --apply (Restore needs it). --apply re-checks, then `git branch -D`. Also in the Clean up view (core/cleanup/branch-tidy.ts)
work pr reply <thread> "<text>" [--body-file f]   # For a session's Claude: draft the reply to a PR review thread it was handed (the feedback note names each [thread PRRT_…]). The session header shows it, editable
work pr post <thread...> [--all] [--no-resolve]   # For a session's Claude, once the user said yes in the conversation: post the drafts as they stand (dashboard edits included) and resolve each thread (--no-resolve: left open for a person's answer). A posted reply takes its thread out of the PR watch's last check at once (`markPostedAnswered`), so the session stops saying it waits on you
work review list [--json]                          # The Reviews tab's prepared PR reviews, newest first (read from state.db: no work web needed). Read only (pre-allowed for the Ctrl+K assistant)
work review show <repo> <number> [--json]          # One review in full: its stories, what changed in each file, the PR's discussion, each draft comment (core/review/review-text.ts). Read only (pre-allowed)
work review session [--json]                       # This folder's session's own review (its Review tab), read from state.db: for its agent, when asked about "the review"
work review prepare <repo> <number>                # Prepare one now, whatever its size — through a running work web (its queue), minutes; never pre-allowed. Nothing in `work review` posts on the host: that is the tab's Submit
work pr replies [--json]                           # The review threads handed to this session, and their drafts
work update [target] [branch]                      # Bring a session's branch up to date: from main, from the session it is stacked on, or onto main once that one merged (core/stacks/session-update.ts, the dashboard's buttons)
work catchup [target] [branch]                     # A few sentences on where a session stands (core/conversations/catch-up.ts)
work snooze [target] [branch] [--for 2h|tomorrow|change] [--until <time>] [--off]  # Out of the Inbox (core/rail/snooze.ts; --until 14:00 | fri | "fri 14:00" | +3h | 2026-10-03 14:00)
work pin [target] [branch] [--off]                 # Pin to the top of the dashboard's rail
work color [target] [branch] [--set red|orange|yellow|green|blue|purple] [--off]  # Mark a session with a color: a bar down its rail row's edge, a square in the Sessions table, Ctrl+P and the Inbox (prints it with no option)
work keep [target] [branch] [--off]                # Keep it once its PR merges, instead of archiving it (the rail menu's Keep after its PR merges)
work note [target] [branch] [--set "…"|--set-file f|--append "…"|--clear]  # Your notes on a session (prints them with no option)
work block [target] [branch] --on <alias> --on-branch <branch> | --pr <url> | --off  # It waits on another session or a PR: out of the Inbox until that is done (no option: lists it)
work time [target] [branch] [--all [--days N]] [--log [--day YYYY-MM-DD]]  # How long sessions' Claude worked: one session per day, every session over the last N days (a weekly report), or write a day to the session's Jira issue as a worklog
work section [target] [branch] --to <name> | --none | --list  # Under one of the rail's sections (made when new)
work usage [--json] [--restore]                    # Each agent's plan limits (5-hour, weekly, spend) as its status line last reported them, and the tokens used today and this week, per model and per session (the top bar's Usage meter; core/usage/). --restore gives each agent back the setting work reads them from (`AgentUsageSource.restore`, `restoreAgentUsage`; Claude Code: its own status line; `--restore-statusline` is its hidden old name)
work account add <name> [folder] [--no-login] | list [--json] | default <name> | remove <name> | switch [target] [branch] --to <name> | skills <name>  # Claude accounts (agents/claude/accounts.ts; config `claudeAccounts` name → folder, `claudeAccount` the default for new sessions): add records one (folder default `~/.claude-<name>`) and starts `claude` here on it so you /login once; list [--json] shows folder, logged in (credentials present; unknown on macOS's keychain) and the last usage reading (each window's percent and its age, from the agent's `usage.read()` by account name); default sets the one new sessions use; remove [--force] is refused while a live session uses it, and while an archived one does unless --force (never deletes the folder); switch moves a session (default: this folder's) to another account — through a running work web, else in-process when its Claude doesn't run in the PTY host; skills puts work's skills into one account's folder. Add, log in, default and remove are also the dashboard's Accounts page (#/accounts, with a login terminal in the app)
work timesheet show [day] [--json]                 # The Time tab's day (today|yesterday|YYYY-MM-DD): hours per ticket, and why. Read only (pre-allowed for the Ctrl+K assistant)
work timesheet month [YYYY-MM] [--json]            # A month: each day's rows and how each got its hours, the month's tickets, what posting it would do (describeTimeMonth). Read only (pre-allowed)
work timesheet set <day> KEY=HOURS… | reset <day> | off <day> [--undo] | gather <day|YYYY-MM> | post <day>  # Change a day (all its rows / back to the suggestion / a day off / its evidence again; a month: its days not gathered yet) or post it to Tempo; through a running work web, else in-process. Never pre-allowed
work read [target] [branch] [--last N] [--json]    # A session's latest messages — yours, its agent's, its tool calls (agents/: read through the agent interface)
work screen [target] [branch]                      # Its terminal as plain text, as it is now (PTY host; starts nothing)
work send [target] [branch] -m "…"|--file f [--wait] [--timeout 15m]  # A message to its agent now: typed in when idle in the host, its Claude started when not running, its next turn otherwise; --wait prints the reply
work wait [target] [branch] [--timeout 15m] [--json]  # Until it finishes its turn or asks you something (exit 2 on timeout)
work start|stop [target] [branch]                  # Start its agent in the PTY host (resuming its conversation) / stop it
work restart [target] [branch] [--outdated|--all]  # Restart agents in place (conversation resumed, terminals kept): now when idle, after its turn when working or waiting on you; --outdated = the ones running a version from before their tool updated. Never pre-allowed
work answer [target] [branch] [--allow|--deny]     # The permission prompt it waits on (no flag: shows it); --allow/--deny answers that exact request — never pre-allowed
work completion [--install]                        # Shell completions

work run <cmd...> [--target <a>] [--branch <b>] [--all] [--parallel] [--jobs N] [--halt-on-error]  # Run a shell command across worktrees (bare run needs --all; Ctrl-C kills the whole fleet)
work broadcast <prompt|-> [--target <a>] [--branch <b>] [--all]  # Queue a prompt to every live session; delivered on each session's next turn via UserPromptSubmit hook (bare broadcast needs --all)

work todo                                          # List open tasks
work todo add <text>                               # Add a task
work todo done <id>                                # Mark task complete
work todo undo <id>                                # Mark task incomplete
work todo edit <id> <text>                         # Edit task text
work todo rm <id>                                  # Remove a task
work todo --all                                    # Show completed tasks too

work config add <alias> <path>                     # Add a repository (the Repos page's rules: a free alias, the repo's top folder, a folder name no other repo has)
work config scan [folder] [--json]                 # The git repos in your scanned folders (or <folder>) that aren't enrolled, with the add command for each — the Repos page's list
work config remove <alias>                         # Remove a repository
work config list                                   # List repos and groups
work config group add <name> <alias1> <alias2> ... # Create a group
work config group remove <name>                    # Remove a group
work config group regen <name>                     # Regenerate group CLAUDE.md
work config show                                   # Show raw config JSON
work config edit                                   # Open config in editor

wd                                                 # DEFAULT: opens a diff route on the singleton `work web` server. Registers as a scope (POST /api/scopes), opens <webUrl>/diff/<hash>. Auto-starts a lean work web in the background if none is running.
wd <base>                                          # Diff vs an explicit ref
wd --branch                                        # Open "Since branch" tab by default (Uncommitted tab is also present — toggle in browser)
wd --static                                        # Write a self-contained HTML file (no server, no live reload). Survives the CLI.
wd --stop                                          # De-register this scope from work web. (Use `work web --stop` to terminate the server itself.)
wd -c                                              # Interactive review. Same single-server flow: registers a scope, opens /review/<hash>, polls /api/scopes/<hash>/comments, proxies marker stream to stdout. Falls back to a foreground standalone comment-server only if work web autostart fails entirely.

work web                                           # Browser dashboard: every session in one tab, with PTY terminal. SINGLETON — one process per user; `work web --stop` to terminate, second `work web` re-uses the running one. Stopping it does NOT kill Claudes (they live in the PTY host).
work web --autostart on|off                        # Windows: start work web at login (Startup-folder .vbs) so sessions restore after a reboot
work web --demo                                    # The real dashboard SPA against a simulated, in-memory API (server/demo/) — no repos, agents, PTY host or ~/.work. For screenshots, UI work and demos; runs beside a real work web. `npm run demo` builds + starts it.
work web --dev [--stop]                            # The dev server: this checkout's build beside the real work web, on the same state.db and PTY host — your real sessions with the latest code. Not the singleton: its own discovery files (web-dev.url, only the dev app reads them), no Claude hooks, no notifications, none of the jobs that act (`startWebServer({dev})`: a look-only PR watch, every 10 min; no idle sleep, archive upkeep, conversation sync, Jira watch, block sweep, stack sync, update lookups). Refuses a build that would migrate state.db (`pendingMigration`). The dashboard shows DEV beside "work"
work attach|a [target] [branch]                    # Attach THIS terminal to a session's Claude in the PTY host (default: session for cwd). Ctrl+] detaches; Claude keeps running. Same PTY as the web Terminal tab.
work pty-host [--status|--stop|--restart] [--force] # Internal/hidden — the long-lived process that owns every Claude PTY. --restart after upgrading (sessions come back via --continue). --force: a host that doesn't answer is killed too, only when its pid still runs `work pty-host` (`looksLikeHost`, `core/pty/host-control.ts`)
work state [--export <dir>]                        # What ~/.work/state.db holds; --export writes it back as the pre-SQLite JSON files (rollback / inspection)
work move export <dir> [--force]                   # A bundle to take work to another computer (core/move/move.ts): refuses while anything is uncommitted or unpushed (worktrees come back from origin)
work move import <dir> [--repos-root p] [--worktrees-root p] [--clone] [--force]  # On the other computer, with work web and the PTY host stopped: paths moved, missing repos cloned, worktrees recreated, conversations put back
work hook <event>                                  # Internal — run by the Claudes work starts, from work's own settings file (`--settings ~/.work/claude-settings.json`; hidden)
work install-skills                                # Internal — give each agent work's skills its own way (hidden; npm's postinstall and the desktop app run the same as dist/install-skills-bin.js, never the whole CLI, so an install writes nothing to ~/.work)
```

- `work show <file>` / `work show --close`: show a file of this folder's session beside its terminal in the dashboard (see session-navigation.md, "A file beside the terminal"). Reads only; needs work web running.
