---
name: wd-review
description: Open an interactive diff review in the user's browser via `wd -c`, stream each comment back as the user writes it, and react to it (make the change, answer the question, or reply via the comment API). Use when the user says "review my changes", "open a wd review", "let me review with wd", "review with wd", or similar.
---

The `wd` CLI on this machine (a global npm bin) ships an interactive review mode. `wd -c` opens a side-by-side diff in the user's browser, lets them click any line number to leave an inline comment, and **streams each comment to stdout as it is saved**. You start the session, react to each comment as it arrives, and the session stays alive until the user clicks "End review" (or the process is killed).

## Lifecycle markers on stdout

Each line on `wd -c` stdout is one of these self-describing chunks:

```
--- review started ---
repos: <repo names>
files: <total file count>
url: http://127.0.0.1:<port>/

--- comment ---
**<repo>/<path>** : line <N> (<left|right>)
id: <hex> [· author: claude] [· reply-to: <hex>]
> <body line 1>
> <body line 2>

--- comment ---
**General review comment**
id: <hex>
> ...

--- comment deleted ---
id: <hex>

--- review submitted ---
count: <N>
[summary-id: <hex>]

  (followed by `--- comment ---` chunks for each newly-published draft, in order, then:)

--- review batch end ---

--- review done ---
total: <N>

--- review aborted (signal) ---
```

The user can either post comments one-at-a-time ("Add single comment" — streams immediately) or batch them via "Start review" (drafts stay invisible until they click Submit, then everything arrives between `--- review submitted ---` and `--- review batch end ---` markers, optionally preceded by a general summary comment).

Anything on `stderr` is just status logging — ignore it.

## How to drive the session

1. **Start `wd -c` in the background** using Bash with `run_in_background: true`. The command blocks until the user clicks "End review", so it must not be foreground.

   Before starting, check `~/.work/diffs/latest-review.url`. If it exists, another `wd -c` is already running. Also walk any background tasks from earlier in this session that match `wd -c` or the marker-tailing Monitor (anything you yourself started for a prior review) and `TaskStop` them. Leaving stale `wd -c` shells around creates confusion: they hold ports, their monitors fire spurious events, and the user has to find them in Task Manager.

2. **Tail the output with Monitor**, filtering only for marker lines. The exact output file path is reported by the Bash tool when you start the job (`Output is being written to: <path>`). Use a filter like:

   ```bash
   tail -F -n +1 "<output-file>" 2>&1 \
     | grep -E --line-buffered "^--- (comment|comment deleted|review started|review done|review aborted)"
   ```

   Set `persistent: true` and `timeout_ms: 3600000`. Reviews can take a while.

3. **On `--- review started ---`**: confirm the session is live to the user, then sit and wait. Do not act until comments arrive.

4. **On each `--- comment ---` event**: read the last ~30 lines of the output file to get the *body* of the freshly-arrived comment (the Monitor only signals which marker fired, it does not deliver the body). Look at the *most recent* `--- comment ---` block.

   - The server suppresses claude-authored echoes, so every event you see is a real user comment. (If the meta line says `author: claude`, ignore — that's a defensive fallback.)
   - **Save the `id:` value** — you need it to post replies.
   - **Decide intent**: is it a question, a code-change request, an observation, or a nit?
   - **Take the smallest reasonable action**:
     - Code change → make the edit. Live reload will refresh the user's tab automatically.
     - Question → reply via the API (see below). Don't pollute the conversation with a long-form answer; the reply lands inline in the browser.
     - Observation / acknowledgement → reply briefly so the user sees you noticed.
     - Nit you disagree with → reply explaining why, don't change the code.
   - **Acknowledge per comment in chat** in one short line too, so the user reading Claude Code also sees your reaction.

5. **On `--- comment deleted ---`**: the user removed a comment they no longer cared about. Don't undo any work that's already shipped, just acknowledge.

6. **On `--- review done ---`**: the user closed the session. Summarise what you did in the chat (which comments triggered code changes, which got reply-only). Stop the Monitor with TaskStop.

7. **On `--- review aborted (signal) ---`**: same as done — wrap up and stop monitoring.

## Replying to a comment

The live server URL is written to `~/.work/diffs/latest-review.url` at session start (and deleted on exit). **Write the JSON body to a temp file** and post via `--data-binary "@file"` — inline `-d '...'` will explode the moment your reply contains an apostrophe or a quote:

```bash
cat > "$CLAUDE_JOB_DIR/reply.json" <<'EOF'
{"parentId":"<comment-id>","author":"claude","body":"<your reply, can contain ' and \" freely>"}
EOF
URL=$(cat ~/.work/diffs/latest-review.url)
curl -s -X POST -H "Content-Type: application/json" \
  --data-binary "@$CLAUDE_JOB_DIR/reply.json" "${URL}api/comments"
```

The reply renders threaded under the original comment in the user's browser. Set `author: "claude"` so the UI distinguishes it visually.

## Comment anchor mechanics

- `side: left` = old/deleted line, `side: right` = new/added line. Same convention as GitHub.
- `side: general` = a top-level review note, no anchor.
- If the user edits a file after commenting, the comment shows up with an "outdated" badge in the browser. You can still address it normally — the original `lineContent` is implied by the body.

## Behavior notes

- **One review at a time.** If a `wd -c` is already running for this scope, starting another would fail. If unsure, check `~/.work/diffs/latest-review.url` — its existence implies a session is live.
- **Don't restart `wd -c` on file edits.** The watcher inside the running session reloads the browser automatically when you edit files.
- **Live reload is deferred while composing.** If the user is mid-comment when you save a file, their reload is queued and applied as soon as they save/cancel the composer. You don't need to handle this.
- **Don't open the browser yourself.** `wd -c` opens it. You only start the process.

## What "done" looks like for this skill

You stop monitoring when `--- review done ---` (or aborted) fires, and you have:

- Made all code changes the user requested
- Replied to all questions and disagreements via the comment API
- Posted a short summary in chat: which comments you actioned, which you replied to, which you skipped and why
