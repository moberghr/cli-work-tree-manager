import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import spawn from 'cross-spawn';
import type { ChatPartial, ChatPermissionWire, ChatSnapshot, ChatState } from './api-types.js';
import type { ChatMessage } from './chat-view.js';
import { report } from './report.js';
import { withoutParentSession } from './claude-env.js';

/**
 * One session's Claude, headless: `claude -p` with stream-json in and out,
 * kept running between turns. Messages go in as JSON lines on stdin; every
 * line Claude prints is kept (except streaming deltas, which only feed the
 * live `partial`) and handed to listeners as it arrives.
 *
 * Permission prompts reach us through Claude's documented
 * --permission-prompt-tool: an MCP tool served by work web
 * (chat-mcp-routes.ts) that waits here until the user answers.
 *
 * Interrupt is a control_request on stdin — the SDK's protocol, not a CLI
 * flag — so it is backed by a fallback: if it isn't acknowledged in time
 * the process is stopped, and the next message resumes the conversation.
 */

export interface ChatSpawnSpec {
  cwd: string;
  cmd: string;
  baseArgs: string[];
  port?: number | null;
  /** Continue the folder's latest conversation on the first start. */
  continueExisting: boolean;
}

export type ChatEvent =
  | { type: 'message'; message: ChatMessage }
  | { type: 'partial'; partial: ChatPartial | null }
  | { type: 'state'; state: ChatState; error: string | null }
  | { type: 'permissions'; permissions: ChatPermissionWire[] };

export interface PermissionDecision {
  behavior: 'allow' | 'deny';
  message?: string;
  updatedInput?: unknown;
}

const MAX_MESSAGES = 3000;
const INTERRUPT_GRACE_MS = 4000;
export const PERMISSION_TOOL = 'mcp__work_chat__approve';

/** The secret in the permission tool's URL (see chat-mcp-routes.ts). */
export const newChatToken = (): string => crypto.randomBytes(16).toString('hex');

export class ChatSession {
  state: ChatState = 'stopped';
  error: string | null = null;
  claudeSessionId: string | null = null;
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
    private readonly mcpConfigFile: string,
    history: unknown[],
    readonly token: string = newChatToken(),
  ) {
    for (const raw of history) this.push(raw, false);
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
      claudeSessionId: this.claudeSessionId,
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
    this.emit({ type: 'state', state, error });
  }

  private push(raw: unknown, live = true): void {
    const message = { seq: this.seq++, raw };
    this.messages.push(message);
    if (this.messages.length > MAX_MESSAGES) this.messages.splice(0, this.messages.length - MAX_MESSAGES);
    if (live) this.emit({ type: 'message', message });
  }

  // ------------------------------------------------------------- process

  private start(): void {
    const args = [
      ...this.spec.baseArgs,
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--replay-user-messages',
      '--permission-prompts', 'host',
      '--permission-prompt-tool', PERMISSION_TOOL,
      '--mcp-config', this.mcpConfigFile,
    ];
    if (this.claudeSessionId) args.push('--resume', this.claudeSessionId);
    else if (this.spec.continueExisting) args.push('--continue');

    const env = { ...withoutParentSession(process.env), ...(this.spec.port ? { PORT: String(this.spec.port) } : {}) };
    this.stopping = false;
    this.stderrTail = '';
    this.setState('starting');
    // argv array, no shell (§1.1): nothing from the user reaches a command line.
    const child = spawn(this.spec.cmd, args, { cwd: this.spec.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;

    let buf = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
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
      this.stderrTail = (this.stderrTail + d).slice(-2000);
    });
    child.on('error', (err) => {
      report('warn', `[chat] ${this.sessionId}: could not start ${this.spec.cmd}: ${err.message}`);
      this.onExit(null, err.message);
    });
    child.on('exit', (code) => this.onExit(code, null));
  }

  private onExit(code: number | null, spawnError: string | null): void {
    if (!this.child) return;
    this.child = null;
    this.clearInterruptTimer();
    this.partial = null;
    this.emit({ type: 'partial', partial: null });
    for (const [, p] of this.pending) p.resolve({ behavior: 'deny', message: 'The session stopped.' });
    this.pending.clear();
    this.emit({ type: 'permissions', permissions: [] });
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
    const m = raw as Record<string, unknown>;
    switch (m.type) {
      case 'stream_event':
        this.onStreamEvent(m.event);
        return;
      case 'control_response':
        this.clearInterruptTimer();
        return;
      case 'system':
        if (m.subtype === 'init' && typeof m.session_id === 'string') this.claudeSessionId = m.session_id;
        if (this.state === 'starting') this.setState(this.turnPending ? 'working' : 'idle');
        break;
      case 'result':
        this.turnPending = false;
        this.clearInterruptTimer();
        this.setState(this.pending.size ? 'needs_input' : 'idle');
        break;
      case 'assistant':
      case 'user':
        if (this.state !== 'needs_input') this.setState('working');
        break;
    }
    this.push(raw);
  }

  private turnPending = false;
  private lastPartialEmit = 0;
  private partialTimer: NodeJS.Timeout | null = null;

  /** Only the block being written right now is kept; finished blocks arrive as messages. */
  private onStreamEvent(ev: unknown): void {
    if (!ev || typeof ev !== 'object') return;
    const e = ev as Record<string, unknown>;
    if (e.type === 'content_block_start') {
      const block = e.content_block as Record<string, unknown> | undefined;
      const kind = typeof block?.type === 'string' ? block.type : 'text';
      this.partial = kind === 'text' || kind === 'thinking' ? { kind, text: '' } : null;
      this.emitPartial(true);
    } else if (e.type === 'content_block_delta' && this.partial) {
      const d = e.delta as Record<string, unknown> | undefined;
      const add = typeof d?.text === 'string' ? d.text : typeof d?.thinking === 'string' ? d.thinking : '';
      if (add) {
        this.partial = { ...this.partial, text: this.partial.text + add };
        this.emitPartial(false);
      }
    } else if (e.type === 'content_block_stop' || e.type === 'message_stop') {
      this.partial = null;
      this.emitPartial(true);
    }
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

  private write(obj: unknown): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) return false;
    stdin.write(JSON.stringify(obj) + '\n');
    return true;
  }

  // -------------------------------------------------------------- actions

  /** Send the user's message; starts (or resumes) the process when needed. */
  send(text: string): void {
    if (!this.child) this.start();
    this.turnPending = true;
    this.write({ type: 'user', message: { role: 'user', content: text } });
    if (this.state !== 'starting' && this.state !== 'needs_input') this.setState('working');
  }

  interrupt(): void {
    if (!this.child || this.state === 'idle') return;
    for (const [, p] of this.pending) p.resolve({ behavior: 'deny', message: 'The user interrupted.' });
    this.pending.clear();
    this.emit({ type: 'permissions', permissions: [] });
    this.write({ type: 'control_request', request_id: `int-${Date.now()}`, request: { subtype: 'interrupt' } });
    this.clearInterruptTimer();
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
    setTimeout(() => {
      if (this.child !== child || !pid) return;
      try {
        if (process.platform === 'win32') spawn.sync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        else process.kill(pid);
      } catch {
        /* gone */
      }
    }, 1500);
  }

  /** Called by the permission MCP tool: waits until the user answers. */
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
    p.resolve(
      allow
        ? { behavior: 'allow', updatedInput: p.wire.input }
        : { behavior: 'deny', message: message?.trim() || 'The user denied this.' },
    );
    this.emit({ type: 'permissions', permissions: [...this.pending.values()].map((q) => q.wire) });
    if (this.pending.size === 0 && this.child) this.setState('working');
    return true;
  }

  get running(): boolean {
    return this.child !== null;
  }

  /** The Claude process's pid while it runs. */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }
}

/** The MCP config file pointing Claude at our permission tool (under ~/.work/chat). */
export function writeMcpConfig(dir: string, sessionId: string, url: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.mcp.json`);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { work_chat: { type: 'http', url } } }, null, 2));
  return file;
}
