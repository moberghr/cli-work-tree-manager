import type { WorktreeSession } from '../sessions/session-types.js';
import type { AiToolSpec } from '../platform/ai-launcher.js';
import type { WorkConfig } from '../platform/config.js';
import type { StatusEvent } from '../status/status-event.js';
import type { PermissionRequest } from '../api-types.js';
import type { UsageAccount } from '../usage/usage.js';
import type { EnvDelta } from '../platform/env-delta.js';

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
  /** On an agent message: the size of the request that produced it (prompt incl. cached) and of the reply, in tokens. `cached` is the cache-read part of `prompt`. */
  usage?: { prompt: number; reply: number; cached?: number };
  /** The agent's id for the message this line is part of: several lines (one per content block) repeat one message's usage, so a token count takes it once per id. */
  message?: string;
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
  /** The files whose token usage counts: its conversations and what they handed to subagents (kept apart, not in `files`). Absent: `files`. */
  usageFiles?(session: WorktreeSession): ConversationFile[];
  /** A file's parsed lines (in order) as conversation entries. */
  entries(lines: readonly unknown[]): ConversationEntry[];
  /** Its context window for a model, given how much a request used (some models have a larger one). */
  contextWindow(model: string | undefined, used: number): number;
  /** The newest `last` messages — yours, its, its tool calls — oldest first. */
  read(session: WorktreeSession, opts: { last: number }): ConversationEntry[];
  /** Where to put an archived conversation's files back so the agent resumes it in the session's folder; absent: Restore starts fresh (the archive keeps them). */
  restoreDir?(session: WorktreeSession): string | null;
  /** The newest write to its conversations for work in `cwd` (ms; 0: none): "is it busy in this folder right now?" without a session (a `wd` scope). */
  lastWriteMs?(cwd: string): number;
  /** A background agent its conversation started (one that runs on after the turn that started it ended) is still at it
   *  after `ms` (the turn's end): the session is still at work though its turn ended — and what that agent is, when it says. */
  backgroundWorkSince?(session: WorktreeSession, ms: number, now?: number): BackgroundWork | null;
  /** Background commands (a build, tests, a dev server) its conversation started since `sinceMs` — the agent
   *  process's start — and that haven't ended: stopping the agent would stop them (idle sleep keeps it awake). */
  backgroundCommands?(session: WorktreeSession, sinceMs: number): number;
  /** What those commands are, newest first, each in a line (the session list names what runs while its prompt is free). */
  backgroundCommandNames?(session: WorktreeSession, sinceMs: number): string[];
  /**
   * The pull requests a stretch of its conversation file names as the session's own (made or worked on by it), in
   * file order — Claude Code writes a line for each. `text`: whole lines of a conversation file; a line cut at either
   * end is skipped. Absent: the agent doesn't say, and a session's PRs come from its branches alone.
   */
  prLinks?(text: string): ConversationPrLink[];
}

/** A pull request a conversation says the session made or worked on (`AgentConversation.prLinks`). */
export interface ConversationPrLink {
  url: string;
  number: number;
  /** The host's name for its repo (`owner/name`), as the agent wrote it; '' when it didn't. */
  repo: string;
  /** ISO, when the line says. */
  at?: string;
}

/** Whose conversations a resume check looks in: a session's (its account), or the environment the agent will start with (`env` wins). */
export interface ResumeVia {
  session?: Pick<WorktreeSession, 'account'> | null;
  env?: Readonly<Record<string, string | undefined>>;
}

/** Starting it: every agent has this. */
export interface AgentLaunch {
  /** Its binary and flags: config `aiCommand` / `aiCommandFlags` when they name this agent, else its defaults. */
  tool(config: Pick<WorkConfig, 'aiCommand' | 'aiCommandFlags'> | null): AiToolSpec;
  /**
   * Its resume flag finds a conversation in this folder. Passing it where there is none errors out (Claude Code: "No conversation found to continue"), so every launch path asks.
   * `via` says whose conversations: the session (its account's folder) or the environment it will run with (what the PTY host restores from).
   */
  canResume(cwd: string, via?: ResumeVia): boolean;
  /** Where to start a session to pick up its conversation (a group may have worked in its root or a repo), and whether there is one. */
  resumeLaunch(session: WorktreeSession): { launchPath: string; hasConversation: boolean };
  /** The environment to start it with: what a parent session of this agent set (it would think it runs inside one) taken out. */
  cleanEnv(env: Record<string, string | undefined>): Record<string, string | undefined>;
  /**
   * What the agent's environment must differ by for this session (Claude: its account's `CLAUDE_CONFIG_DIR`), applied
   * OVER whatever environment it would inherit — a name set to a value, or `null` to take it out. `null` session: work's
   * own runs (the assistant, one-shot summaries), on the configured default. Absent: nothing to change.
   */
  env?(session: Pick<WorktreeSession, 'account'> | null): EnvDelta;
  /**
   * The tool as work starts it for a session, its hooks (session-hooks.ts) given to this process alone — never written
   * into the user's settings, where every other agent run on the machine would fire them (Claude: `--settings` with
   * work's own file, claude/session-settings.ts). Applied at every spawn, restore and restart, so a stored tool from
   * before gets it too. Absent: started as `tool` says (no hooks).
   */
  sessionTool?(tool: AiToolSpec, o?: { write?: boolean }): AiToolSpec;
  /**
   * A running process of it, by its command line, was started with `sessionTool`'s hooks. One that wasn't — started
   * before this build, by an older work — still needs the hooks older builds put in its own settings (`AgentEvents.bridge`).
   */
  startedWithSessionHooks?(commandLine: string): boolean;
}

/** Whether a keystroke may answer a permission request now (the dialog on its screen is that request's), and if not, why. */
export type DialogCheck = { ok: true } | { ok: false; reason: 'no-dialog' | 'other-request' | 'not-default' };

/** Typing into its terminal. */
export interface AgentInput {
  /** Type `text` into its prompt and submit it (`write`: the PTY; `wait`: a pause, for tests). */
  submit(write: (data: string) => Promise<boolean>, text: string, wait?: (ms: number) => Promise<void>): Promise<boolean>;
  /**
   * A question it is stopped at before its first turn, read from its terminal's screen ("do you trust this
   * folder?"): what it asks in a line, or null. Absent: it has none work knows. Never answered by work.
   */
  startupQuestion?(screen: string): string | null;
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
  /**
   * Optional: a one-shot run that may READ a folder — a pull request's temporary checkout, for the Reviews AI step
   * (review-tree.ts). Read-only file tools only, confined to `cwd`; nothing that runs a command, writes, or reaches
   * the network; none of the folder's own settings, hooks or MCP servers (they are the PR author's), but its
   * instructions file (the repo's conventions); the env tagged internal like `command`. Absent: the agent has no
   * such mode, and callers use the text-only `command` with the diff alone.
   */
  readOnly?: AgentReadOnly;
}

/** The agent's read-only one-shot in a folder (`AgentOneShot.readOnly`), and what only the agent knows about it. */
export interface AgentReadOnly {
  command(opts: { small?: boolean; cwd: string; deny?: string[] }): { cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv };
  /**
   * A file of the folder (its path relative to it, `/` or `\`) the agent would read as its own settings — hooks, env,
   * permissions, tool servers: deleted from the copy before the run (the folder is someone else's). Whatever case it's
   * written in: a case-blind file system opens `.Claude/settings.json` as the settings file.
   */
  isSettingsFile(relPath: string): boolean;
  /** What the run's prompt says of the folder in the agent's own words: its tools, and which of its files it was given. */
  promptLines: string[];
  /**
   * The same for a run in YOUR folder (a session's own changes, core/review/local-review-tree.ts): nothing is
   * deleted there. Absent: the agent's read-only run is for a temporary checkout only.
   */
  localLines?: string[];
  /**
   * The files the repos' own settings forbid reading, as rules for `command`'s `deny` (the run loads none of the
   * folder's settings, so they wouldn't hold otherwise). `sub`: the repo's folder under where the run starts.
   */
  denyRules?(repos: ReadonlyArray<{ dir: string; sub: string | null }>): string[];
  /**
   * Whether the installed agent can run it as it was measured (Claude: its version, at least the one its flags were
   * measured on). Not ok: no checkout run, and `why` says so. Absent: always.
   */
  available?(): Promise<{ ok: boolean; why?: string }>;
}

/** One running agent process, as its adapter reads it (Claude: ~/.claude/sessions/<pid>.json). */
export interface LiveAgent {
  pid: number;
  /** Its conversation's id (two on one conversation would both write to it). */
  conversationId: string;
  cwd: string;
  busy: boolean;
  /** What the agent says it is doing: mid-turn, at its prompt, or waiting on you (a permission, a dialog). */
  state: 'busy' | 'idle' | 'waiting' | 'shell' | null;
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

/** One of work's hooks in a folder's own settings (the Ctrl+K assistant's): the command an agent runs at a turn edge, under an owner. */
export interface WorkHook {
  owner: string;
  edge: TurnEdge;
  command: string;
  timeoutSec?: number;
}

/**
 * How work hears an agent's turns: hooks the agent runs at each edge (given to the processes work starts,
 * `AgentLaunch.sessionTool`), and what it sends them.
 */
export interface AgentEvents {
  /**
   * Take hooks of these owners out of the agent's own settings (every account's): work once installed them there, and
   * every agent run on the machine fired them (session-hooks.ts `RETIRED_HOOK_OWNERS`). Settings already without them
   * aren't written.
   */
  removeInstalled(hooks: ReadonlyArray<{ owner: string; edge: TurnEdge }>): Promise<void>;
  /**
   * While agents started before the update still run (they have no `sessionTool` hooks of their own, and the agent
   * reads its settings live), put work's hooks in its own settings — the very commands `sessionTool` gives, so an agent
   * that has both runs each once — under owners `removeInstalled` takes out once those agents are gone.
   */
  bridge(): Promise<void>;
  /** What a hook was sent (its stdin, parsed): the folder it fired in, and the status event it means. */
  read(edge: TurnEdge, payload: unknown): { cwd?: string; status: StatusEvent | null };
  /** The hook output that hands `text` (pending notes) to the agent: at a turn's start as more context, at its end as "go on with this". */
  handOver(edge: 'turn-start' | 'turn-end', text: string): string;
}

/** A command the agent may run without asking: exactly this, or (`prefix`) this and anything after it. */
export interface AllowRule {
  command: string;
  prefix?: boolean;
}

/** Setting up a folder work runs the agent in (the Ctrl+K assistant's, ~/.work/assistant). */
export interface AgentWorkspace {
  /** Write the agent's own settings for `dir`: what it may run without asking, and work's hooks there. Never the user's own local settings. Returns the files it wrote (relative to `dir`), so another agent's can be removed later. */
  write(dir: string, o: { allow: AllowRule[]; hooks: WorkHook[] }): string[];
}

/** Giving the agent work's skills (how to use `work` and `wd -c`): SKILL.md folders, the Agent Skills format. */
export interface AgentSkills {
  /** Make work's skills available to it, user-wide: from `skillsDir` (null: not found next to work — one that needs the files says so). Its outcome in a line; never throws for a missing agent. */
  install(o: { skillsDir: string | null }): Promise<{ ok: boolean; message: string }>;
}

/** Its plan limits (5-hour, weekly), as the last readings work recorded per account. */
export interface AgentUsageSource {
  read(): UsageAccount[];
  /**
   * Work web's start: put in place (or, `enabled: false`, take away) what records the readings (Claude: its status line).
   * A lean server passes `lean` and expects nothing changed. Loaded lazily: the hook processes import the adapter too.
   */
  setup?(o: { enabled: boolean; lean: boolean }): Promise<string>;
  /** `work usage --restore`: give the agent's own setting back now. */
  restore?(): Promise<{ ok: boolean; message: string }>;
  /**
   * Ask the agent for what its readings can't carry (Claude: a model's own weekly window, as Fable's, `usage-ask.ts`)
   * and record it; throttled by the agent, so it may be called on every request. Never throws.
   */
  refresh?(): Promise<void>;
  /**
   * Whether the user has a status line of their own for this agent (Claude: one in any account's settings that isn't
   * work's). The dashboard asks about work's own line only when they don't: theirs stays theirs.
   */
  ownStatusLine?(): boolean;
}

/** One of an agent's accounts (Claude: a config folder with its own login). */
export interface AccountInfo {
  name: string;
  /** Where its login, settings and conversations live. */
  dir: string;
  /** The one new sessions use. */
  isDefault: boolean;
  /** Logged in; null: can't tell (macOS keeps Claude's credentials in the keychain). */
  loggedIn: boolean | null;
}

/** The sessions on an account, as "target · branch": the live ones, and the archived ones (whose Restore would need it). */
export interface AccountUsers {
  live: string[];
  archived: string[];
}

/**
 * A refusal of an account change the user can act on (an unknown name, a folder that can't be one, sessions still on it).
 * `sessions` names the sessions that stopped a removal; `kind` says whether they are live ones (always a refusal) or
 * archived ones (a refusal unless forced).
 */
export class AccountAdminError extends Error {
  constructor(
    message: string,
    readonly sessions: string[] = [],
    readonly kind?: 'live' | 'archived',
  ) {
    super(message);
  }
}

/** One thing a copy of an account's setup to another does (`AgentAccountAdmin.setupPlan`). */
export interface AccountSetupItem {
  /** What kind of thing it is, in the agent's own words (Claude: file, folder, settings, mcp, marketplace, plugin). */
  kind: string;
  name: string;
  does: 'adds' | 'replaces' | 'merges into';
  /** Something to know of it (a sign-in it needs on the other account, where it comes from). */
  note?: string;
}

export interface AccountSetupResult extends AccountSetupItem {
  ok: boolean;
  error?: string;
}

/** Adding, choosing and forgetting an agent's accounts (`work account`). Never deletes an account's folder: its login and conversations are the user's. */
export interface AgentAccountAdmin {
  /** Record a new account (its folder: `dir`, else the agent's default place for it), made when missing. Returns the folder. */
  add(name: string, dir?: string): Promise<string>;
  /** New sessions use this account. */
  setDefault(name: string): Promise<void>;
  /**
   * Forget an account (its folder stays). `usedBy` is asked under the config's lock, right before the write: live
   * sessions on it are always a refusal, archived ones too (their Restore would start on another account) — a caller
   * that was told to go ahead anyway passes none.
   */
  remove(name: string, usedBy: () => AccountUsers): Promise<void>;
  /** Start the agent's own CLI in this terminal on the account, so the user logs in (blocks until it exits). */
  login(name: string): void;
  /**
   * The same CLI as `login` starts, for a terminal work starts itself (the dashboard's login terminal, in the PTY host):
   * its command and how its environment differs for the account. In the agent's own permission mode, as every start.
   * Throws an AccountAdminError for an unknown account.
   */
  loginLaunch(name: string): { tool: AiToolSpec; agentEnv: EnvDelta };
  /** Give the account work's skills (the install at setup reaches only the accounts there were then). */
  installSkills(name: string): { ok: boolean; message: string };
  /**
   * What copying `from`'s setup to `to` would do (its instructions, agents, commands, settings, tool servers,
   * plugins — never a login, a token or a conversation): a read. Empty: `to` is set up the same already. Throws an
   * AccountAdminError for an unknown account, or one copied to itself. Absent: the agent has no setup to copy.
   */
  setupPlan?(from: string, to: string): AccountSetupItem[];
  /** Do it, each thing reported; one that fails is said and the rest still go. Nothing on `to` is deleted. */
  copySetup?(from: string, to: string): Promise<AccountSetupResult[]>;
}

/** Running a session on one of several logins of the agent, and moving it from one to another. */
export interface AgentAccounts {
  list(): AccountInfo[];
  /** The account new sessions use. */
  defaultName(): string;
  /** An account of that name exists. */
  has(name: string): boolean;
  /** The name of the account a session runs on. */
  current(session: Pick<WorktreeSession, 'account'>): string;
  /**
   * Move the session's conversations (whatever the agent keeps per folder it runs in) from its account to `to`, merging;
   * puts back what it moved and throws when it fails. It records nothing and starts nothing: the caller stops the agent
   * first, records the account, and starts it again.
   */
  switchFiles(session: WorktreeSession, to: string): Promise<{ moved: string[] }>;
  /** The folders whose conversations a switch moves (where its agent runs for the session): another agent running in one
   *  of them would have its files moved from under it, so the switch is refused while one does. */
  folders(session: Pick<WorktreeSession, 'paths' | 'isGroup'>): string[];
  /** Managing the accounts themselves; absent: they are set up some other way. */
  admin?: AgentAccountAdmin;
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
  /** The line in an instructions file that makes it read another (Claude's `@api/CLAUDE.md`), for a
   *  session folder's file (session-instructions.ts); absent: it can't import, and a group's combined file is copied instead. */
  instructionsImport?(relPath: string): string;
  /** Folders whose changes mean it did something (its conversations, its process state): work web watches them to refresh the dashboard at once. */
  activityRoots?(): string[];
  /** Installing work's skills for it (skills.ts); absent: it isn't told about `work`'s commands. */
  skills?: AgentSkills;
  /** Its settings in a folder work runs it in (the Ctrl+K assistant); absent: only the instructions file is written, and it asks before every command. */
  workspace?: AgentWorkspace;
  /** Its usage limits; absent: the meter has nothing for this agent. */
  usage?: AgentUsageSource;
  /** Several logins to run sessions on, and moving a session between them; absent: one login. */
  accounts?: AgentAccounts;
}

/** A background agent at work after its turn ended: what it is, in its own words (its description), when it says. */
export interface BackgroundWork {
  what: string | null;
}
