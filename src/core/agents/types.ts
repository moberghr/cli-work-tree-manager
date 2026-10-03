import type { WorktreeSession } from '../session-types.js';
import type { AiToolSpec } from '../ai-launcher.js';
import type { WorkConfig } from '../config.js';
import type { StatusEvent } from '../status-event.js';
import type { PermissionRequest } from '../api-types.js';

/**
 * What work needs from a coding agent (Claude Code today; Codex, Copilot CLI
 * or opencode later), so the rest of work asks the agent instead of reading
 * Claude Code's files itself. `launch` every agent has; every other
 * capability is optional, and a feature whose capability an agent lacks says
 * so instead of going quiet.
 */

/**
 * One line of a session's conversation, in work's own terms (not any agent's
 * file format). Every timestamped line of the agent's record becomes at
 * least one: `other` keeps the lines that aren't messages, because work time
 * measures the gaps between all of them.
 */
export interface ConversationEntry {
  /** When it was written (ISO); '' when the agent's line says no time. */
  at: string;
  /** You typed it; the agent wrote it (text may be empty: a line of only its thinking); a tool call it made; a tool's result coming back to it; anything else. */
  role: 'you' | 'agent' | 'tool' | 'tool-result' | 'other';
  /** The text; for a tool call, what it does ("npm test", a file path). */
  text: string;
  /** For a tool call: the tool's name (Bash, Edit, …). */
  tool?: string;
  /** The line's own id, when the agent gives one (the same line read twice counts once). */
  id?: string;
  /** A subagent's line: its own context, not the session's conversation. */
  sidechain?: true;
  /** On an agent message: the size of the request that produced it (prompt incl. cached) and of the reply, in tokens. */
  usage?: { prompt: number; reply: number };
  /** On an agent message: the model that wrote it. */
  model?: string;
  /** The agent's own bookkeeping (a meta line, a compaction summary): no message of yours or its, and no turn's work. */
  meta?: true;
  /** An `other` line that is still part of a turn's work: a shell command you ran through it and its output, a background task's result. */
  turn?: true;
}

/** A file of an agent's conversations. */
export interface ConversationFile {
  file: string;
  mtimeMs: number;
  size: number;
}

export interface AgentConversation {
  /** Where its conversations about this session are kept: one file per conversation, one JSON value per line. */
  files(session: WorktreeSession): ConversationFile[];
  /** A file's parsed lines (in order) as conversation entries. */
  entries(lines: readonly unknown[]): ConversationEntry[];
  /** Its context window for a model, given how much a request used (some models have a larger one). */
  contextWindow(model: string | undefined, used: number): number;
  /** The newest `last` messages — yours, its, its tool calls — oldest first. */
  read(session: WorktreeSession, opts: { last: number }): ConversationEntry[];
  /** Where to put an archived conversation's files back so the agent resumes it in the session's folder; absent: Restore starts fresh (the archive keeps them). */
  restoreDir?(session: WorktreeSession): string | null;
}

/** Starting it: every agent has this. */
export interface AgentLaunch {
  /** Its binary and flags: config `aiCommand` / `aiCommandFlags` when they name this agent, else its defaults. */
  tool(config: Pick<WorkConfig, 'aiCommand' | 'aiCommandFlags'> | null): AiToolSpec;
  /** Its resume flag finds a conversation in this folder. Passing it where there is none errors out (Claude Code: "No conversation found to continue"), so every launch path asks. */
  canResume(cwd: string): boolean;
  /** Where to start a session to pick up its conversation (a group may have worked in its root or a repo), and whether there is one. */
  resumeLaunch(session: WorktreeSession): { launchPath: string; hasConversation: boolean };
  /** The environment to start it with: what a parent session of this agent set (it would think it runs inside one) taken out. */
  cleanEnv(env: Record<string, string | undefined>): Record<string, string | undefined>;
}

/** Whether a keystroke may answer a permission request now (the dialog on its screen is that request's), and if not, why. */
export type DialogCheck = { ok: true } | { ok: false; reason: 'no-dialog' | 'other-request' | 'not-default' };

/** Typing into its terminal. */
export interface AgentInput {
  /** Type `text` into its prompt and submit it (`write`: the PTY; `wait`: a pause, for tests). */
  submit(write: (data: string) => Promise<boolean>, text: string, wait?: (ms: number) => Promise<void>): Promise<boolean>;
  /** Its permission dialog on a terminal screen; absent: work can't answer its prompts by keystroke. */
  permissionDialog?: {
    check(screen: string, req: PermissionRequest): DialogCheck;
    keys: { allow: string; deny: string };
  };
}

/**
 * A text-only, one-shot run of the agent, for work's own summaries (checkpoint
 * names, catch-up, archive summaries, the Jira watch's choice, a group's
 * instructions file): the prompt on stdin, the answer on stdout. The prompt
 * carries text work doesn't control (diffs, transcripts, issues), so: no
 * tools, none of the user's MCP servers, a neutral folder, and the env tagged
 * so the agent's own hooks don't fire into work (internal-claude.ts).
 */
export interface AgentOneShot {
  /** How to start one; `small`: a few words are wanted (a smaller, cheaper model). */
  command(opts: { small?: boolean }): { cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv };
}

/** One running agent process, as its adapter reads it (Claude: ~/.claude/sessions/<pid>.json). */
export interface LiveAgent {
  pid: number;
  /** Its conversation's id (two on one conversation would both write to it). */
  conversationId: string;
  cwd: string;
  busy: boolean;
  /** What the agent says it is doing: mid-turn, at its prompt, or waiting on you (a permission, a dialog). */
  state: 'busy' | 'idle' | 'waiting' | null;
  /** When that last changed (ms). */
  stateAt: number | null;
  /** While waiting: what for ("input needed", "dialog open"). */
  waitingFor: string | null;
  startedAt: number | null;
}

/** Which of its processes run now, wherever they were started (a terminal of yours included). */
export interface AgentLive {
  /** `table`: a process table the caller already has (pid → executable). */
  running(table?: ReadonlyMap<number, string>): LiveAgent[];
}

/** A point in an agent's turn work hooks into: a prompt arrives, the turn ends, the agent notifies (a permission prompt, idle). */
export type TurnEdge = 'turn-start' | 'turn-end' | 'notify';

/** One of work's hooks: the command (`work hook <edge>`) an agent runs at a turn edge, under an owner (which work web installed it). */
export interface WorkHook {
  owner: string;
  edge: TurnEdge;
  command: string;
  timeoutSec?: number;
}

/** How work hears an agent's turns: hooks the agent runs at each edge, and what it sends them. */
export interface AgentEvents {
  /** Install these hooks in the agent's settings in one write, replacing those owners' earlier ones, and removing `remove`. */
  install(hooks: WorkHook[], remove?: Array<{ owner: string; edge: TurnEdge }>): Promise<void>;
  /** Remove hooks synchronously (a shutdown handler can't wait). */
  removeSync(hooks: Array<{ owner: string; edge: TurnEdge }>): void;
  /** What a hook was sent (its stdin, parsed): the folder it fired in, and the status event it means. */
  read(edge: TurnEdge, payload: unknown): { cwd?: string; status: StatusEvent | null };
  /** The hook output that hands `text` (pending notes) to the agent: at a turn's start as more context, at its end as "go on with this". */
  handOver(edge: 'turn-start' | 'turn-end', text: string): string;
}

export interface AgentAdapter {
  /** The agent's binary name (`claude`, `codex`, …). */
  id: string;
  /** How work names it to you ("Claude Code"). */
  name: string;
  launch: AgentLaunch;
  /** Reading its conversations; absent: work can't for this agent. */
  conversation?: AgentConversation;
  /** Hearing its turns through hooks; absent: no hook status (the PTY host's output stands in). */
  events?: AgentEvents;
  /** Its running processes; absent: work sees only the ones the PTY host runs. */
  live?: AgentLive;
  /** Typing into its terminal (every agent: at least text, a pause, Enter). */
  input: AgentInput;
  /** Text-only one-shot runs for work's summaries; absent: work writes none with this agent. */
  oneShot?: AgentOneShot;
  /** The project instructions file it reads (CLAUDE.md; Codex, Copilot and opencode read AGENTS.md): a group's combined one is written under this name. */
  instructionsFile: string;
  /** It can run as the dashboard's headless chat (Claude's stream-json protocol: chat-session.ts); absent: the Terminal tab only. */
  chat?: true;
}
