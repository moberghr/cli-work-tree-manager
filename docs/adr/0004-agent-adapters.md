# 0004. Agents behind an adapter interface

- Status: Accepted
- Date: 2026-10 (recorded 2026-10-03)

## Context

Everything was written for Claude Code: its transcript format, its hooks
in `~/.claude/settings.json`, its process files, its permission dialog, its
`claude -p` runs, its headless chat protocol, its plugin. Other agents
(Codex, Copilot, opencode) were wanted as options, without implementing them
yet.

## Decision

`work` talks to an agent only through `AgentAdapter`
(`core/agents/types.ts`): launch and resume, conversation reading (in work's
own `ConversationEntry`), hooks at turn edges, running processes, typing and
the permission dialog, one-shot runs, the headless chat (work's own
`ChatRecord`s on the wire), a workspace (settings for a folder work runs it
in), and skills. Every part but launch and input is optional; the dashboard
is told which exist (`SessionWire.agent.can`) and hides the rest. A session
records the agent it was created with. Claude Code's adapter lives in
`core/agents/claude/`, and only the registry (`agents/index.ts`) imports it
(architecture test).

## Consequences

- A new agent is one adapter plus `registerAgent`;
  `tests/core/agents/echo-agent.test.ts` runs a made-up one through the
  real modules as the template.
- Features an agent's adapter lacks are absent for it, not broken (no
  context %, no inbox status from hooks, no Chat tab, …).
- Core can't take a shortcut through Claude's files; new readers go through
  `agentOf(session)`.
