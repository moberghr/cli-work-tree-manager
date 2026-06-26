---
name: wd-review
description: Open the `wd` browser diff viewer so the USER can review changes themselves. Trigger ONLY when the user explicitly references wd or asks to look at the diff themselves — "open wd", "open a wd review", "review with wd", "let me review with wd", "let me look at the diff", "show me the diff". DEFAULT is read-only — run plain `wd` and stop. Drive the interactive `wd -c` loop ONLY when the user explicitly asks for it ("review with wd interactively", "stream my comments back", "wd -c", "drive the review"). Do NOT trigger on a bare "review my changes"/"review the diff" with no mention of wd — that means the user wants Claude to perform a code review (use the code-review skill), not the wd viewer. If the user runs `wd` themselves, do nothing.
---

## Pick the mode first — read-only is the default

This skill is ONLY for opening the `wd` browser diff viewer for the user. It is NOT for Claude reviewing code.

**First, check this isn't a request for Claude to review.** A bare "review my changes", "review the diff", "review the PR", or "can you review this" with **no mention of wd** means the user wants *Claude* to perform a code review — that is the **code-review** skill, not this one. Do not open `wd` for those; let the code-review skill handle them. This skill triggers only when the user explicitly references `wd` or clearly says they want to look at the diff *themselves* ("open wd", "let me review with wd", "show me the diff", "let me look at it").

Once you know it's a `wd` request, pick the mode. **Default to read-only.**

- **User already ran `wd` themselves (e.g. `!wd`, or a `wd`/`wd -c` command in the transcript) → do NOTHING.** Seeing the user run `wd` is NOT a request for you to start a review. Do not launch your own `wd`, do not launch `wd -c`, do not start a background task or Monitor. The diff is theirs to review on their own. At most acknowledge in one line and wait for them to ask for a change. Never run a review process in parallel with one the user started.
- **Read-only (DEFAULT).** Triggered when the user asks you to open the wd viewer — "open wd", "open a wd review", "let me review with wd", "review with wd" — without explicitly asking for the interactive loop. Just run plain **`wd`** (NOT `wd -c`) — it opens the read-only diff in the browser. Tell the user it's open and **STOP**: do not start a background task, do not tail output with Monitor, do not edit any files. They review on their own and will come back to you if they want changes. The rest of this document does not apply in this mode.
- **Interactive (`wd -c`) — only on explicit request.** Triggered only when the user clearly wants Claude in the loop: "interactively", "stream my comments", "react to my comments as I write them", "drive the review", "wd -c", or similar. Only then follow the lifecycle/driving instructions below.

If you are unsure which one they mean, default to read-only and ask whether they want the interactive mode.

---

## Interactive mode (`wd -c`)

Everything below applies **only** in interactive mode (see above). `wd -c` opens a side-by-side diff in the user's browser, lets them click any line number to leave an inline comment, and **streams each comment to stdout as it is saved**. You start the session, react to each comment as it arrives, and the session stays alive until the user clicks "End review" (or the process is killed).

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

   Before starting, walk any background tasks from earlier in this session that match `wd -c` or the marker-tailing Monitor (anything you yourself started for a prior review) and `TaskStop` them. Leaving stale `wd -c` shells around creates confusion: they hold ports, their monitors fire spurious events, and the user has to find them in Task Manager.

   The URL for this session is announced on the FIRST `--- review started ---` marker (the `url:` line); read it from the Bash tool's output file the moment Monitor fires that marker, and keep it in conversation context. There's no on-disk URL file to cat — capturing it from the stream is the only way to learn it, which means you can never accidentally post to a review in a different worktree or a stale daemon.

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

**Pick the reply endpoint from the shape of the `url:` line** you captured at the `--- review started ---` marker. `wd -c` runs in one of two modes and they post to different routes:

| `url:` shape | Mode | Reply endpoint |
|---|---|---|
| `http://host:port/review/<hash>` | **work web scope** (the normal case — `wd -c` registered a review scope on the singleton `work web`) | `http://host:port/api/scopes/<hash>/comments` |
| `http://host:port/` (no `/review/` segment) | **standalone server** (fallback when work-web autostart failed) | `http://host:port/api/comments` |

Do NOT just append `api/comments` to the `url:` value — in scope mode that yields `…/review/<hash>api/comments`, which 404s. Parse the URL: if the path is `/review/<hash>`, the base is everything before `/review/`, and `<hash>` is that last segment.

**Write the JSON body to a temp file** and post via `--data-binary "@file"` — inline `-d '...'` will explode the moment your reply contains an apostrophe or a quote:

```bash
# Derive BASE + ENDPOINT from the captured url: line.
URL="<the url: value from the --- review started --- marker>"
if [[ "$URL" == */review/* ]]; then
  BASE="${URL%/review/*}"
  HASH="${URL##*/review/}"; HASH="${HASH%%/*}"
  ENDPOINT="$BASE/api/scopes/$HASH/comments"   # work web scope mode
else
  ENDPOINT="${URL%/}/api/comments"             # standalone server mode
fi

# Use mktemp, NOT $CLAUDE_JOB_DIR — that var isn't reliably set, and an empty
# value resolves to /reply.json → "Permission denied".
REPLY_JSON="$(mktemp)"
cat > "$REPLY_JSON" <<'EOF'
{"parentId":"<comment-id>","author":"claude","body":"<your reply, can contain ' and \" freely>"}
EOF
curl -s -X POST -H "Content-Type: application/json" \
  --data-binary "@$REPLY_JSON" "$ENDPOINT"
rm -f "$REPLY_JSON"
```

If you forget the URL mid-conversation, re-scan the Bash output file from the `wd -c` background task — the `url:` line is at the top, in the first `--- review started ---` block.

The reply renders threaded under the original comment in the user's browser. Set `author: "claude"` so the UI distinguishes it visually.

## Comment anchor mechanics

- `side: left` = old/deleted line, `side: right` = new/added line. Same convention as GitHub.
- `side: general` = a top-level review note, no anchor.
- If the user edits a file after commenting, the comment shows up with an "outdated" badge in the browser. You can still address it normally — the original `lineContent` is implied by the body.

## Behavior notes

- **Reviews are per-scope, not global.** In the normal (work-web) mode every `wd -c` registers a distinct scope `<hash>` on the one shared `work web` server, so its URL is `…/review/<hash>` — the *hash* is what's unique per worktree, not a per-review port. Two `wd -c` instances in different worktrees coexist as two scopes on the same server. The URL/hash flows only through the stream you spawned, so post replies to the `<hash>` from *your* `--- review started ---` marker and you can't hit someone else's review. (In the standalone-server fallback each `wd -c` binds its own port instead.)
- **Don't restart `wd -c` on file edits.** The watcher inside the running session reloads the browser automatically when you edit files.
- **Live reload is deferred while composing.** If the user is mid-comment when you save a file, their reload is queued and applied as soon as they save/cancel the composer. You don't need to handle this.
- **Don't open the browser yourself.** `wd -c` opens it. You only start the process.

## What "done" looks like for this skill

You stop monitoring when `--- review done ---` (or aborted) fires, and you have:

- Made all code changes the user requested
- Replied to all questions and disagreements via the comment API
- Posted a short summary in chat: which comments you actioned, which you replied to, which you skipped and why
