import crypto from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import spawn from 'cross-spawn';
import type { ChatPartial, ChatPermissionWire, ChatSnapshot, ChatState } from './api-types.js';
import type { ChatMessage, ChatRecord } from './chat-view.js';
import type { ChatLineRead, ChatPermissionDecision, ChatPermissionTool, ChatProtocol } from './agents/types.js';
import { report } from './report.js';

/**
 * One session's agent, headless, kept running between turns: JSON lines in
 * on its stdin, JSON lines out. What the lines are is its adapter's protocol
 * (agents/types.ts `ChatProtocol`; Claude's stream-json: agents/claude-chat.ts):
 * this runs the process and keeps what it said, in work's terms
 * (`ChatRecord`s), handing each line to listeners as it arrives; streamed
 * text only feeds the live `partial`.
 *
 * Permission prompts arrive at work's permission URL (an MCP tool served by
 * work web, chat-mcp-routes.ts → `requestPermission`) or in the agent's own
 * output (`ChatLineRead.permission`, answered with its `answerLine`); either
 * waits here until the user answers.
 *
 * An interrupt is the protocol's line, backed by a fallback: if it isn't
 * acknowledged in time (or the agent has none) the process is stopped, and
 * the next message resumes the conversation.
 */

export interface ChatSpawnSpec {
  cwd: string;
  cmd: string;
  baseArgs: string[];
  port?: number | null;
  /** Continue the folder's latest conversation on the first start. */
  continueExisting: boolean;
  /** The agent's environment clean-up (a parent session's variables: `launch.cleanEnv`). */
  cleanEnv?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
}

export type ChatEvent =
  | { type: 'message'; message: ChatMessage }
  | { type: 'partial'; partial: ChatPartial | null }
  | { type: 'state'; state: ChatState; error: string | null }
  | { type: 'permissions'; permissions: ChatPermissionWire[] };

export type PermissionDecision = ChatPermissionDecision;

const MAX_MESSAGES = 3000;
/** History kept for the view, by size too: tool results can be megabytes each. */
export const MAX_HISTORY_BYTES = 16 * 1024 * 1024;
const INTERRUPT_GRACE_MS = 4000;

/** The secret in the permission tool's URL (see chat-mcp-routes.ts). */
export const newChatToken = (): string => crypto.randomBytes(16).toString('hex');

export class ChatSession {
  state: ChatState = 'stopped';
  error: string | null = null;
  /** When anything last happened (a message, a state change): idle sleep reads it. */
  lastActivityAt = Date.now();
  private historyBytes = 0;
  private sizes: number[] = [];
  /** The conversation the agent runs (from its first line): resumed after a restart. */
  conversationId: string | null = null;
  private messages: ChatMessage[] = [];
  private seq = 0;
  private partial: ChatPartial | null = null;
  private child: ChildProcess | null = null;
  private stopping = false;
  private stderrTail = '';
  private readonly listeners = new Set<(e: ChatEvent) => void>();
  private readonly pending = new Map<string, { wire: ChatPermissionWire; resolve: (d: PermissionDecision) => void }>();
  private interruptTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly sessionId: string,
    private readonly spec: ChatSpawnSpec,
    private readonly protocol: ChatProtocol,
    history: ChatRecord[][],
    readonly token: string = newChatToken(),
  ) {
    for (const records of history) this.push(records, false);
  }

  subscribe(fn: (e: ChatEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snapshot(): ChatSnapshot {
    return {
      sessionId: this.sessionId,
      state: this.state,
      error: this.error,
      conversationId: this.conversationId,
      messages: this.messages,
      partial: this.partial,
      permissions: [...this.pending.values()].map((p) => p.wire),
    };
  }

  private emit(e: ChatEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* a broken listener must not stop the others */
      }
    }
  }

  private setState(state: ChatState, error: string | null = null): void {
    if (this.state === state && this.error === error) return;
    this.state = state;
    this.error = error;
    this.lastActivityAt = Date.now();
    this.emit({ type: 'state', state, error });
  }

  private push(records: ChatRecord[], live = true): void {
    const message = { seq: this.seq++, records };
    const size = approxBytes(records);
    this.messages.push(message);
    this.sizes.push(size);
    this.historyBytes += size;
    this.lastActivityAt = Date.now();
    // Oldest first, but never below the last 50 messages.
    while (this.messages.length > 50 && (this.messages.length > MAX_MESSAGES || this.historyBytes > MAX_HISTORY_BYTES)) {
      this.messages.shift();
      this.historyBytes -= this.sizes.shift() ?? 0;
    }
    if (live) this.emit({ type: 'message', message });
  }

  // ------------------------------------------------------------- process

  private start(): void {
    const args = [...this.spec.baseArgs, ...this.protocol.args({ resumeId: this.conversationId, continueLatest: this.spec.continueExisting })];
    const clean = this.spec.cleanEnv ?? ((e: NodeJS.ProcessEnv) => e);
    const env = { ...clean(process.env), ...(this.spec.port ? { PORT: String(this.spec.port) } : {}) };
    this.stopping = false;
    this.stderrTail = '';
    this.setState('starting');
    // argv array, no shell (§1.1): nothing from the user reaches a command line.
    const child = spawn(this.spec.cmd, args, { cwd: this.spec.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    // A write racing its exit (EPIPE, write after end) is an 'error' on stdin: unheard, it would take work web down.
    child.stdin?.on('error', (err) => report('detail', `[chat] ${this.sessionId}: stdin: ${err.message}`));

    let buf = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      if (this.child !== child) return; // let go of (a stop, then a new message): its last words aren't this chat's
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.onLine(line);
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => {
      if (this.child === child) this.stderrTail = (this.stderrTail + d).slice(-2000);
    });
    child.on('error', (err) => {
      report('warn', `[chat] ${this.sessionId}: could not start ${this.spec.cmd}: ${err.message}`);
      this.onExit(child, null, err.message);
    });
    child.on('exit', (code) => this.onExit(child, code, null));
  }

  /** Stop listening to this process: what it held (a partial, open permission prompts) ends with it. */
  private release(child: ChildProcess): boolean {
    if (this.child !== child) return false;
    this.child = null;
    this.clearInterruptTimer();
    this.partial = null;
    this.emit({ type: 'partial', partial: null });
    for (const [, p] of this.pending) p.resolve({ allow: false, message: 'The session stopped.' });
    this.pending.clear();
    this.emit({ type: 'permissions', permissions: [] });
    return true;
  }

  private onExit(child: ChildProcess, code: number | null, spawnError: string | null): void {
    if (!this.release(child)) return; // one we let go of already
    if (this.stopping || code === 0) this.setState('stopped');
    else this.setState('exited', spawnError ?? (this.stderrTail.trim().split('\n').slice(-3).join('\n') || `exited with code ${code}`));
  }

  private onLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return; // not a protocol line (a stray print): ignore
    }
    if (!raw || typeof raw !== 'object') return;
    const r = this.protocol.read(raw);
    if (r.stream) this.onStream(r.stream);
    if (r.acknowledged) this.clearInterruptTimer();
    if (r.conversationId) this.conversationId = r.conversationId;
    if (r.ready && this.state === 'starting') this.setState(this.turnPending ? 'working' : 'idle');
    if (r.turnEnded) {
      this.turnPending = false;
      this.clearInterruptTimer();
      this.setState(this.pending.size ? 'needs_input' : 'idle');
    } else if (r.activity && this.state !== 'needs_input') this.setState('working');
    if (r.records.length) this.push(r.records);
    if (r.permission) this.askInBand(r.permission);
  }

  private turnPending = false;
  private lastPartialEmit = 0;
  private partialTimer: NodeJS.Timeout | null = null;

  /** Only the block being written right now is kept; finished blocks arrive as records. */
  private onStream(st: NonNullable<ChatLineRead['stream']>): void {
    if ('start' in st) {
      this.partial = st.start ? { kind: st.start, text: '' } : null;
      this.emitPartial(true);
    } else if ('delta' in st) {
      if (!this.partial) return;
      this.partial = { ...this.partial, text: this.partial.text + st.delta };
      this.emitPartial(false);
    } else {
      this.partial = null;
      this.emitPartial(true);
    }
  }

  /**
   * A permission the agent asked in its own output: held like any other,
   * answered on its stdin — that process's, never one started since. A
   * protocol that can't answer one says so in the chat instead of leaving
   * the agent waiting on a prompt nobody sees.
   */
  private askInBand(p: NonNullable<ChatLineRead['permission']>): void {
    const answerLine = this.protocol.answerLine?.bind(this.protocol);
    if (!answerLine) {
      report('warn', `[chat] ${this.sessionId}: the agent asked permission for ${p.toolName}, which its chat protocol can't answer`);
      this.push([{ kind: 'notice', text: `It asked permission to use ${p.toolName}, which this chat can't answer: stop it, and answer in its terminal.` }]);
      return;
    }
    const child = this.child;
    void this.requestPermission(p.toolName, p.input, p.toolUseId).then((d) => {
      if (this.child === child) this.write(answerLine(p.requestId, d));
    });
  }

  /** At most ~20 updates a second while text streams. */
  private emitPartial(now: boolean): void {
    const send = () => {
      this.partialTimer = null;
      this.lastPartialEmit = Date.now();
      this.emit({ type: 'partial', partial: this.partial });
    };
    if (now) {
      if (this.partialTimer) clearTimeout(this.partialTimer);
      send();
      return;
    }
    if (this.partialTimer) return;
    const wait = Math.max(0, 50 - (Date.now() - this.lastPartialEmit));
    this.partialTimer = setTimeout(send, wait);
  }

  /** A line to its stdin, unless that is closed or closing (a stop ended it): never a write after end. */
  private write(obj: unknown): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) return false;
    stdin.write(JSON.stringify(obj) + '\n');
    return true;
  }

  // -------------------------------------------------------------- actions

  /** Send the user's message; starts (or resumes) the process when needed — also right after a stop, while the old one exits. */
  send(text: string): void {
    if (this.child && this.stopping) this.release(this.child); // on its way out (the stop kills it): a fresh one takes the message
    if (!this.child) this.start();
    this.turnPending = true;
    this.write(this.protocol.userLine(text));
    if (this.state !== 'starting' && this.state !== 'needs_input') this.setState('working');
  }

  interrupt(): void {
    if (!this.child || this.state === 'idle') return;
    for (const [, p] of this.pending) p.resolve({ allow: false, message: 'The user interrupted.' });
    this.pending.clear();
    this.emit({ type: 'permissions', permissions: [] });
    const line = this.protocol.interruptLine();
    this.clearInterruptTimer();
    if (line === null) {
      // No interrupt in its protocol: stop it; the next message resumes the conversation.
      this.stop();
      return;
    }
    this.write(line);
    this.interruptTimer = setTimeout(() => {
      // Not acknowledged: stop it; the next message resumes the conversation.
      report('detail', `[chat] ${this.sessionId}: interrupt not acknowledged, stopping the process`);
      this.stop();
    }, INTERRUPT_GRACE_MS);
  }

  private clearInterruptTimer(): void {
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    this.interruptTimer = null;
  }

  stop(): void {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    try {
      child.stdin?.end();
    } catch {
      /* already closed */
    }
    const pid = child.pid;
    // Still running 1.5 s later (whether or not a new message has started another since): kill it.
    setTimeout(() => {
      if (!pid || child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (process.platform === 'win32') spawn.sync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        else process.kill(pid);
      } catch {
        /* gone */
      }
    }, 1500);
  }

  /** The tool the agent asks permission through at work's permission URL (its protocol's; none: it doesn't). */
  get permissionTool(): ChatPermissionTool | undefined {
    return this.protocol.permissionTool;
  }

  /** Called by the permission MCP tool (or for one the agent asked in its output): waits until the user answers. */
  requestPermission(toolName: string, input: unknown, toolUseId: string | null): Promise<PermissionDecision> {
    const id = crypto.randomBytes(6).toString('hex');
    const wire: ChatPermissionWire = { id, toolName, input, toolUseId, at: Date.now() };
    return new Promise((resolve) => {
      this.pending.set(id, { wire, resolve });
      this.emit({ type: 'permissions', permissions: [...this.pending.values()].map((p) => p.wire) });
      this.setState('needs_input');
    });
  }

  answer(permissionId: string, allow: boolean, message?: string): boolean {
    const p = this.pending.get(permissionId);
    if (!p) return false;
    this.pending.delete(permissionId);
    p.resolve(allow ? { allow: true, input: p.wire.input } : { allow: false, message: message?.trim() || 'The user denied this.' });
    this.emit({ type: 'permissions', permissions: [...this.pending.values()].map((q) => q.wire) });
    if (this.pending.size === 0 && this.child) this.setState('working');
    return true;
  }

  get running(): boolean {
    return this.child !== null;
  }

  /** The agent process's pid while it runs. */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }
}

/** About how many bytes a message's records hold (their JSON length). */
function approxBytes(raw: unknown): number {
  try {
    return JSON.stringify(raw)?.length ?? 0;
  } catch {
    return 0;
  }
}
