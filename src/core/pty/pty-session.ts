import pty, { type IPty } from 'node-pty';
import { agentById } from '../agents/index.js';
import crossSpawn from 'cross-spawn';
import { debug } from '../platform/logger.js';
import { buildAiLaunchArgs, type AiToolSpec } from '../platform/ai-launcher.js';
import { batchArgProblem, programFor } from '../platform/batch-launch.js';
import { shellEnv } from '../platform/shell-env.js';
import childProcess from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { makeSpawnHelperExecutable } from './spawn-helper.js';
import { report } from '../platform/report.js';
import { loadConfig } from '../platform/config.js';
import { createMirror } from './create-mirror.js';
import type { SnapshotOptions, TerminalMirror } from './mirror.js';
import type { StreamSignal } from './stream-status.js';
import { windowsPtyFor, type WindowsPty } from './terminal-size.js';
import { SyncScanner, cutAtFrameEnds } from './sync-output.js';
import type { TerminalColors } from './terminal-colors.js';

type Fork = typeof childProcess.fork;
const HIDDEN = Symbol.for('work.forkHidesConsole');

/**
 * Make `fork()` hide the child's console window unless the caller says
 * otherwise. node-pty kills a Windows PTY by forking a helper
 * (conpty_console_list_agent) without `windowsHide`; from the PTY host —
 * detached, so it has no console of its own — Windows gave every such helper
 * a new, visible console: a window flashed on each Archive or stop.
 */
export function hideForkConsoles(cp: { fork: Fork }): void {
  if ((cp.fork as { [HIDDEN]?: true })[HIDDEN]) return;
  // windowsHide isn't in @types/node's ForkOptions, but fork passes its
  // options on to spawn, which honours it.
  const orig = cp.fork as unknown as (modulePath: string | URL, args: readonly string[], options: object) => ReturnType<Fork>;
  const wrapped = function (modulePath: string | URL, a?: unknown, b?: unknown) {
    const args = Array.isArray(a) ? (a as readonly string[]) : [];
    const options = (Array.isArray(a) || a == null ? b : a) ?? {};
    return orig.call(cp, modulePath, args, { windowsHide: true, ...(options as object) });
  } as unknown as Fork & { [HIDDEN]?: true };
  wrapped[HIDDEN] = true;
  cp.fork = wrapped;
}
if (process.platform === 'win32') hideForkConsoles(childProcess);

let spawnHelperChecked = false;
/**
 * Once per process, before the first terminal: node-pty's spawn-helper must
 * be executable on macOS and Linux, or every terminal fails with
 * "posix_spawnp failed" (spawn-helper.ts). Fixes an install that has it
 * wrong; says so when it can't.
 */
function ensureSpawnHelper(): void {
  if (spawnHelperChecked) return;
  spawnHelperChecked = true;
  try {
    const dir = path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
    const { fixed, failed } = makeSpawnHelperExecutable(dir);
    for (const file of fixed) debug('made node-pty spawn-helper executable', file);
    for (const { file, error } of failed)
      report(
        'warn',
        `node-pty's spawn-helper isn't executable and couldn't be made so (${error}): terminals can't start. Run: chmod +x "${file}"`,
      );
  } catch (err) {
    debug('spawn-helper check failed', (err as Error).message);
  }
}

export interface PtyAiOptions {
  /** Resolved AI tool spec (from `getAiTool(config)`). */
  tool: AiToolSpec;
  resume?: boolean;
  promptFile?: string;
  /** Initial prompt: on the command line as an argument of its own; for a batch-file agent on Windows that cmd.exe
   *  would parse (its `&`, `%`, quotes, line breaks), typed in once the agent is up instead (resolvePtyCommand). */
  initialPrompt?: string;
  /** Dev-server port exposed to the launched process as $PORT. */
  port?: number;
  /** Environment for the process instead of this process's own — the PTY
   *  host passes the launching shell's env so PATH, AWS_PROFILE, venvs,
   *  WT_SESSION etc. match where the user ran `work tree`. */
  env?: Record<string, string>;
}

type CrossSpawnParse = (
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string },
) => { command: string; args: string[]; file?: string; options: { windowsVerbatimArguments?: boolean } };

/** Whether `cmd` starts as a batch file on Windows — cmd.exe would parse its arguments (a Node or Python shim doesn't: it's skipped). */
export function startsAsBatch(
  cmd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  cwd?: string,
): boolean {
  return platform === 'win32' && programFor(cmd, { env, cwd })?.batch === true;
}

/**
 * Turn `cmd args` into what node-pty should spawn, safely.
 *
 * Windows: the program is the absolute file PATH gives it, never one in the working folder (`programFor`,
 * batch-launch.ts: a worktree's own `claude.cmd` doesn't run); a missing one throws. A path is the file Windows
 * would start for it (`C:\npm\claude` is `claude.cmd` beside it: that is what's started, and judged). A real .exe is spawned
 * directly with normal argv quoting. A batch file that starts a Node script — npm's `claude.cmd` — or a Python
 * module is skipped: its interpreter is spawned on the script, the arguments as argv, no cmd.exe. Any other batch
 * file goes through `cmd.exe /d /s /c "…"` (cross-spawn's escaping, a verbatim command line), and only with
 * arguments free of cmd's special characters: cmd.exe parses them twice, so `"&echo X&"` would run and a line break
 * cut the rest; such arguments throw (the caller types a prompt in after the start instead). Never a bare
 * `cmd.exe /c cmd args` (§1.1). Elsewhere: as given.
 */
export function resolvePtyCommand(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): { file: string; args: string[] | string; env?: NodeJS.ProcessEnv } {
  if (process.platform !== 'win32') return { file: cmd, args };
  const program = programFor(cmd, { env: opts.env ?? process.env, cwd: opts.cwd });
  if (!program) throw new Error(`${cmd} not found on PATH`);
  if (!program.batch) return { file: program.file, args: [...program.pre, ...args] };
  const why = batchArgProblem(args);
  if (why) throw new Error(`${cmd}: ${why}`);
  const parse = (crossSpawn as unknown as { _parse: CrossSpawnParse })._parse;
  const parsed = parse(program.file, args, opts);
  // cmd.exe runs the batch file in the worktree: a bare name inside it must not find a file of the branch (shellEnv).
  const env = shellEnv(opts.env ?? process.env);
  if (parsed.options.windowsVerbatimArguments) {
    return { file: parsed.command, args: parsed.args.join(' '), env };
  }
  return { file: parsed.file ?? parsed.command, args: parsed.args, env };
}

/**
 * The environment as the terminal the agent draws into says it: xterm.js (the Terminal tab, and the PTY host's own copy
 * of the screen) shows 24-bit colour, so `COLORTERM=truecolor` unless the environment says something itself. Without
 * it Claude Code, under `TERM=xterm-256color`, draws its truecolor theme in 256 colours (and suggests setting it).
 * The launching terminal's identity (TERM_PROGRAM, WT_SESSION …) is kept: terminal-rendering.md, "Terminal identity".
 */
export function terminalEnv(env: Record<string, string>): Record<string, string> {
  return env.COLORTERM ? env : { ...env, COLORTERM: 'truecolor' };
}

/** How long a terminal must have been quiet after its first output before a prompt is typed into it. */
export const PROMPT_SETTLE_MS = 800;
/** The longest a prompt waits for that quiet before it is typed anyway. */
export const PROMPT_WAIT_MS = 20_000;

/** What `typeWhenSettled` watches: a terminal's output and its end (node-pty's `IPty`, or a stand-in in tests). */
export interface SettleTarget {
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: () => void): unknown;
}

/**
 * Type `text` into the agent's prompt once it is up: after its first output and `settleMs` of quiet (at most
 * `waitMs` in all), through `submit` (the agent's own, agents/: the whole text, line breaks and all, then Enter).
 * Once only; never after the terminal ended. For a prompt that can't go on its command line (a batch-file agent).
 */
export function typeWhenSettled(
  target: SettleTarget,
  text: string,
  opts: { exited: () => boolean; submit: (text: string) => Promise<unknown>; settleMs?: number; waitMs?: number },
): void {
  let quiet: ReturnType<typeof setTimeout> | undefined;
  let typed = false;
  const stop = () => {
    typed = true;
    clearTimeout(quiet);
    clearTimeout(cap);
    sub.dispose();
  };
  const type = () => {
    if (typed) return;
    stop();
    if (opts.exited()) return;
    opts.submit(text).catch((err: unknown) => debug('PtySession: typing the first prompt failed', (err as Error).message));
  };
  const cap = setTimeout(type, opts.waitMs ?? PROMPT_WAIT_MS);
  cap.unref?.();
  const sub = target.onData(() => {
    if (typed) return;
    clearTimeout(quiet);
    quiet = setTimeout(type, opts.settleMs ?? PROMPT_SETTLE_MS);
  });
  target.onExit(() => {
    if (!typed) stop();
  });
}

/** Config `useBundledConpty`, read at each start (off when config can't be read). */
function readUseBundledConpty(): boolean {
  try {
    return loadConfig()?.useBundledConpty === true;
  } catch {
    return false;
  }
}

/** node-pty's ConPTY choice: on Windows, the bundled one when asked for; nothing elsewhere (it's Windows-only). Pure. */
export function conptyOptions(platform: NodeJS.Platform, useBundled: boolean): { useConptyDll?: boolean } {
  return platform === 'win32' && useBundled ? { useConptyDll: true } : {};
}

/**
 * The ConPTY a PTY starts on (`options`, node-pty's) and the `windowsPty` its screens say (terminal-size.ts), decided
 * together so they can't disagree: the bundled one behaves as a newer Windows than `release` says. Pure.
 */
export function conptyFor(
  platform: NodeJS.Platform,
  release: string,
  useBundled: boolean,
): { options: { useConptyDll?: boolean }; windowsPty?: WindowsPty } {
  const options = conptyOptions(platform, useBundled);
  const windowsPty = windowsPtyFor(platform, release, options.useConptyDll === true);
  return windowsPty ? { options, windowsPty } : { options };
}

/** Config `agentsLowPriority`, read at each start (off when config can't be read). */
function readAgentsLowPriority(): boolean {
  try {
    return loadConfig()?.agentsLowPriority === true;
  } catch {
    return false;
  }
}

/**
 * Put a just-started agent below normal priority (config `agentsLowPriority`; reported: two sessions' test runs and a
 * compile filled a 15-watt CPU, and the window you type in froze). What it starts inherits it — Windows hands a
 * below-normal parent's class to its children, POSIX the nice value — so its builds and tests take the idle cores and
 * give way to what you look at. Null when done, else why not (the agent runs on at normal priority).
 */
export function lowerPriority(pid: number, set: (pid: number, priority: number) => void = os.setPriority): string | null {
  try {
    set(pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * What a terminal start that took `ms` is worth saying (node-pty's start is synchronous, so the host answered nothing
 * meanwhile): a note in the debug line from 1 s, a warning from 5 s. Pure.
 */
export function slowStart(ms: number): { note: string; warn: string | null } {
  return {
    note: ms > 1000 ? `(the start took ${ms} ms)` : '',
    warn: ms > 5000 ? `[pty] starting a terminal took ${Math.round(ms / 1000)} s: the PTY host answered nothing meanwhile` : null,
  };
}

/**
 * Whether a PTY's output may be paused for a client to catch up (output-pacer.ts). Not on Windows: node-pty reads
 * ConPTY's output through a worker thread so that ClosePseudoConsole, which before Windows 11 24H2 waits for that
 * output to be drained, can't block the host; paused, nothing drains it, and killing the agent could hang the whole
 * host. There a client too far behind is sent a fresh screen instead (as any other is). Pure.
 */
export function canPauseOutput(platform: NodeJS.Platform): boolean {
  return platform !== 'win32';
}

/**
 * Calls `exiting` the moment node-pty learns its child exited, before it waits for its socket to close. node-pty 1.1.0
 * (lib/unixTerminal.js, `onexit`) arms `setTimeout(() => socket.destroy(), DESTROY_SOCKET_TIMEOUT_MS = 200)` and then
 * registers `this.once('close', …)`. What was not read from the PTY by the time that timer fires is lost: a paused PTY
 * (flow control) must read again before then. That `once('close')` is the only one it makes on itself (its other
 * waits are on its socket), so it marks the exit. A test pins that against node-pty's source, so an upgrade that
 * changes it fails there. False when there is nothing to hook (no `once`).
 */
export function onChildExit(pty: object, exiting: () => void): boolean {
  const target = pty as { once?: (event: string, listener: (...args: unknown[]) => void) => unknown };
  const once = target.once;
  if (typeof once !== 'function') return false;
  target.once = function (this: unknown, event, listener) {
    if (event === 'close') exiting();
    return once.call(this, event, listener);
  };
  return true;
}

export class PtySession {
  readonly pty: IPty;
  /**
   * Stop reading the agent's output, and start again (flow control, output-pacer.ts): paused, its writes block once
   * the PTY's buffer is full. Undefined where that isn't safe (`canPauseOutput`).
   */
  readonly pause?: () => void;
  readonly resume?: () => void;
  private paused = false;
  /** The PTY host's copy of the screen (mirror.ts: xterm's or libghostty's): what a client attaching is sent first. */
  private readonly mirror: TerminalMirror;
  /** The ConPTY it runs on, as xterm.js's `windowsPty` (its screens say it, pty-registry.ts); undefined off Windows. */
  readonly windowsPty?: WindowsPty;
  /** Where its output is in synchronized frames (sync-output.ts): it is cut at each frame's end. */
  private readonly frames = new SyncScanner();
  readonly cwd: string;
  private outputHandler?: (data: string) => void;
  private _exited = false;
  private _outputBuffer = '';
  private _loggedOutput = false;
  onExit?: (code: number) => void;

  constructor(cwd: string, cols: number, rows: number, command?: { cmd: string; args: string[] }, aiOptions?: PtyAiOptions) {
    this.cwd = cwd;
    // Which ConPTY, read once: node-pty starts on it, and the screens say how it reflows (config useBundledConpty).
    const conpty = conptyFor(process.platform, os.release(), readUseBundledConpty());
    if (conpty.windowsPty) this.windowsPty = conpty.windowsPty;
    // ConPTY reflows lines itself on a resize: the copy is told so, as the Terminal tab is (the replay frame). Its
    // engine (config terminalEngine, WORK_TERMINAL_ENGINE) is read here, once.
    this.mirror = createMirror(cols, rows, { windowsPty: conpty.windowsPty });

    let rawCmd: string;
    let rawArgs: string[];
    let typeLater: string | undefined;

    if (command) {
      // Custom command (e.g. work tree)
      rawCmd = command.cmd;
      rawArgs = command.args;
    } else if (aiOptions) {
      // Launch configured AI tool (default: claude)
      const launchOpts = { resume: aiOptions.resume, promptFile: aiOptions.promptFile };
      ({ cmd: rawCmd, args: rawArgs } = buildAiLaunchArgs(aiOptions.tool, { ...launchOpts, initialPrompt: aiOptions.initialPrompt }));
      // A batch-file agent (not a Node or Python shim) on Windows: cmd.exe would parse the prompt — its `&` runs,
      // a line break cuts it. Never on its command line: typed in once it's up, as any note to a session is.
      if (
        aiOptions.initialPrompt &&
        batchArgProblem([aiOptions.initialPrompt]) &&
        startsAsBatch(aiOptions.tool.cmd, aiOptions.env, process.platform, cwd)
      ) {
        ({ cmd: rawCmd, args: rawArgs } = buildAiLaunchArgs(aiOptions.tool, launchOpts));
        typeLater = aiOptions.initialPrompt;
      }
    } else {
      throw new Error('PtySession requires either a custom command or aiOptions');
    }

    // A session of its own: never another agent's child (its adapter knows what a parent sets).
    const env: Record<string, string> = terminalEnv(
      Object.fromEntries(
        Object.entries(agentById(aiOptions?.tool.cmd ?? 'claude').launch.cleanEnv(aiOptions?.env ?? process.env)).filter(
          (e): e is [string, string] => e[1] != null,
        ),
      ),
    );
    if (aiOptions?.port !== undefined) {
      env.PORT = String(aiOptions.port);
    }
    const { file: spawnCmd, args: spawnArgs, env: batchEnv } = resolvePtyCommand(rawCmd, rawArgs, { env, cwd });

    debug('PtySession spawn', { spawnCmd, spawnArgs, cwd, cols, rows });
    ensureSpawnHelper();
    const started = Date.now();
    this.pty = pty.spawn(spawnCmd, spawnArgs, {
      name: 'xterm-256color',
      cwd,
      cols,
      rows,
      env: (batchEnv as Record<string, string> | undefined) ?? env,
      ...conpty.options,
    });
    // node-pty's start is synchronous (Windows: creating the pseudo-console): a slow one holds up the whole host.
    const slow = slowStart(Date.now() - started);
    debug('PtySession spawned pid=', this.pty.pid, slow.note);
    if (slow.warn) report('warn', slow.warn);
    // An agent only: a login terminal or another custom command is yours to type in.
    if (aiOptions && readAgentsLowPriority()) {
      const why = lowerPriority(this.pty.pid);
      debug(why ? `PtySession: couldn't lower the agent's priority (${why})` : 'PtySession: agent started below normal priority');
    }

    if (canPauseOutput(process.platform)) {
      // Its child exited: what it wrote last is read now (node-pty drops it 200 ms later), and nothing pauses it again.
      // On Linux the child exits with its output unread; on macOS its exit waits for that output to be read.
      let ending = false;
      onChildExit(this.pty, () => {
        ending = true;
        this.resume?.();
      });
      this.pause = () => {
        if (this._exited || ending || this.paused) return;
        this.paused = true;
        try {
          this.pty.pause();
        } catch {
          /* PTY already exited */
        }
      };
      this.resume = () => {
        if (!this.paused) return;
        this.paused = false;
        try {
          this.pty.resume();
        } catch {
          /* PTY already exited */
        }
      };
    }

    this.pty.onData((data) => {
      // Cut at each synchronized frame's end, the screen copy written and the output passed on piece by piece: a client
      // joining (or caught up) at a frame's end is sent a screen of exactly what came before it (pty-registry.ts).
      for (const piece of cutAtFrameEnds(this.frames, data)) {
        this.mirror.write(piece);
        this.outputHandler?.(piece);
      }
      // Log first 500 chars of PTY output for debugging early exits
      if (!this._loggedOutput) {
        this._outputBuffer = (this._outputBuffer || '') + data;
        if (this._outputBuffer.length > 500) {
          debug('PtySession first output', { cwd, output: this._outputBuffer.slice(0, 500) });
          this._loggedOutput = true;
          this._outputBuffer = '';
        }
      }
    });

    if (typeLater !== undefined) {
      const agent = agentById(aiOptions?.tool.cmd ?? 'claude');
      typeWhenSettled(this.pty, typeLater, {
        exited: () => this._exited,
        submit: (text) =>
          agent.input.submit((d) => {
            this.write(d);
            return Promise.resolve(!this._exited);
          }, text),
      });
    }

    this.pty.onExit(({ exitCode }) => {
      if (!this._loggedOutput && this._outputBuffer) {
        debug('PtySession output before exit', { cwd, output: this._outputBuffer.slice(0, 500) });
      }
      this._outputBuffer = '';
      debug('PtySession exited', { cwd, exitCode });
      this._exited = true;
      this.onExit?.(exitCode);
    });
  }

  get exited() {
    return this._exited;
  }

  write(data: string) {
    if (!this._exited) {
      try {
        this.pty.write(data);
      } catch {
        /* PTY already exited */
      }
    }
  }

  resize(cols: number, rows: number) {
    if (!this._exited) {
      try {
        this.pty.resize(cols, rows);
      } catch {
        // PTY already exited natively before our flag was set — ignore
      }
      this.mirror.resize(cols, rows);
    }
  }

  /**
   * The agent's queries in output that arrives while `now()` says so (no client attached: pty-registry.ts) are answered
   * by the screen's copy, colour queries from `colors` (ScreenMirror.answerQueries).
   */
  answerQueries(now: () => boolean, colors: Pick<TerminalColors, 'reply'>): void {
    this.mirror.answerQueries({ now, colors, send: (reply) => this.write(reply) });
  }

  /**
   * The current screen + scrollback as escape sequences that redraw it
   * exactly (colors, cursor, modes, alt screen — ScreenMirror.snapshot). What a late attacher is
   * sent instead of raw output history — raw bytes can start mid-sequence
   * and were drawn for another client's grid (VS Code does the same).
   */
  serialize(opts?: SnapshotOptions): string | null {
    return this.mirror.snapshot(opts);
  }

  /**
   * serialize(), once the screen has parsed everything written to it so far:
   * xterm queues writes, and a write's callback runs right after that write
   * is parsed — before any written later. What a new client is sent first.
   */
  serializeSettled(opts?: SnapshotOptions): Promise<string | null> {
    return this.mirror.snapshotSettled(opts);
  }

  /** The visible screen as plain text, one line per row (no colors).
   *  What the dashboard checks before answering a prompt by keystroke. */
  screenText(): string {
    return this.mirror.screenText();
  }

  /** What the agent last said about itself in its output: OSC 7501 program status, else OSC 9;4 progress (stream-status.ts). */
  streamSignal(): StreamSignal | null {
    return this.mirror.streamSignal();
  }

  setOutputHandler(handler?: (data: string) => void) {
    this.outputHandler = handler;
  }

  dispose() {
    this.setOutputHandler(undefined);
    // Reading again first: a paused PTY's end waits for its output to be read (node-pty emits exit once it is).
    this.resume?.();
    if (!this._exited) {
      try {
        this.pty.kill();
      } catch {
        /* PTY already exited */
      }
    }
    this.mirror.dispose();
  }
}
