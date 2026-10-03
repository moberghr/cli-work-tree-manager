# 0007. Nothing reaches GitHub without the user's yes

- Status: Accepted
- Date: 2026 (recorded 2026-10-03)

## Context

The PR watch hands review feedback to a session's agent, which fixes the
code and could answer the reviewers. Anything posted on GitHub appears in the
user's name, and the agent acts on text other people wrote (reviews,
comments), which may try to steer it.

## Decision

- Review text reaches an agent only from reviewers with write access, or the
  review bots listed in `prWatch.trustedBots`; never for sessions launched
  `--unsafe`.
- The agent drafts replies (`work pr reply`); they show in the dashboard,
  editable. They are posted only by the user's Post click, or by the agent's
  `work pr post` after the user said yes in the conversation.
- `work pr post` — like `work answer`, `send`, `start`, `stop` — is never on
  an allow list, so the agent's own permission prompt is a second check.
- Internal agent runs that read untrusted text (checkpoint names, summaries,
  the Jira watch's choice) have no tools.

## Consequences

- A reply can't be posted by an injected instruction alone; the user sees
  and approves each.
- Answering reviews takes one more click (or one "yes") than it could.
