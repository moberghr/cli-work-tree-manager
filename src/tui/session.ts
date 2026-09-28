import pty, { type IPty } from 'node-pty';
import crossSpawn from 'cross-spawn';
import xtermHeadless from '@xterm/headless';
import xtermSerialize from '@xterm/addon-serialize';
import { debug } from '../core/logger.js';
import { buildAiLaunchArgs, type AiToolSpec } from '../core/ai-launcher.js';

const { Terminal } = xtermHeadless;
const { SerializeAddon } = xtermSerialize;

export interface PtyAiOptions {
  /** Resolved AI tool spec (from `getAiTool(config)`). */
  tool: AiToolSpec;
  unsafe?: boolean;
  resume?: boolean;
  promptFile?: string;
  /** Initial prompt passed on the command line (escaped — see
   *  resolvePtyCommand). */
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

/**
 * Turn `cmd args` into what node-pty should spawn, safely.
 *
 * Windows: resolved the way cross-spawn (used by `work tree`'s direct
 * launch) resolves it — a real .exe is spawned directly with normal argv
 * quoting; a .cmd/.bat shim goes through `cmd.exe /d /s /c "…"` with
 * cmd-metacharacters caret-escaped, handed to node-pty as a verbatim
 * command line. Never a bare `cmd.exe /c cmd args`: that lets `&`, `|`, `%`
 * in an argument (a prompt, a path) run as commands (§1.1).
 */
export function resolvePtyCommand(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): { file: string; args: string[] | string } {
  if (process.platform !== 'win32') return { file: cmd, args };
  const parse = (crossSpawn as unknown as { _parse: CrossSpawnParse })._parse;
  const parsed = parse(cmd, args, opts);
  if (parsed.options.windowsVerbatimArguments) {
    return { file: parsed.command, args: parsed.args.join(' ') };
  }
  return { file: parsed.file ?? parsed.command, args: parsed.args };
}

export class PtySession {
  readonly pty: IPty;
  readonly terminal: InstanceType<typeof Terminal>;
  private readonly serializer = new SerializeAddon();
  readonly cwd: string;
  private outputHandler?: (data: string) => void;
  private _exited = false;
  private _outputBuffer = '';
  private _loggedOutput = false;
  onExit?: (code: number) => void;

  constructor(
    cwd: string,
    cols: number,
    rows: number,
    command?: { cmd: string; args: string[] },
    aiOptions?: PtyAiOptions,
  ) {
    this.cwd = cwd;
    this.terminal = new Terminal({
      cols,
      rows,
      scrollback: 200,
      allowProposedApi: true,
    });
    this.terminal.loadAddon(this.serializer);

    let rawCmd: string;
    let rawArgs: string[];

    if (command) {
      // Custom command (e.g. work tree)
      rawCmd = command.cmd;
      rawArgs = command.args;
    } else if (aiOptions) {
      // Launch configured AI tool (default: claude)
      ({ cmd: rawCmd, args: rawArgs } = buildAiLaunchArgs(aiOptions.tool, {
        unsafe: aiOptions.unsafe,
        resume: aiOptions.resume,
        promptFile: aiOptions.promptFile,
        initialPrompt: aiOptions.initialPrompt,
      }));
    } else {
      throw new Error('PtySession requires either a custom command or aiOptions');
    }

    const env: Record<string, string> = Object.fromEntries(
      Object.entries(aiOptions?.env ?? process.env).filter(
        (e): e is [string, string] => e[1] != null,
      ),
    );
    if (aiOptions?.port !== undefined) {
      env.PORT = String(aiOptions.port);
    }
    const { file: spawnCmd, args: spawnArgs } = resolvePtyCommand(rawCmd, rawArgs, { env, cwd });

    debug('PtySession spawn', { spawnCmd, spawnArgs, cwd, cols, rows });
    this.pty = pty.spawn(spawnCmd, spawnArgs, {
      name: 'xterm-256color',
      cwd,
      cols,
      rows,
      env,
    });
    debug('PtySession spawned pid=', this.pty.pid);

    this.pty.onData((data) => {
      this.terminal.write(data);
      this.outputHandler?.(data);
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
      try { this.pty.write(data); } catch { /* PTY already exited */ }
    }
  }

  resize(cols: number, rows: number) {
    if (!this._exited) {
      try {
        this.pty.resize(cols, rows);
      } catch {
        // PTY already exited natively before our flag was set — ignore
      }
      this.terminal.resize(cols, rows);
    }
  }

  /**
   * The current screen + scrollback as escape sequences that redraw it
   * exactly (colors, cursor, modes, alt screen). What a late attacher is
   * sent instead of raw output history — raw bytes can start mid-sequence
   * and were drawn for another client's grid (VS Code does the same).
   */
  serialize(): string {
    try {
      return this.serializer.serialize();
    } catch {
      return '';
    }
  }

  setOutputHandler(handler?: (data: string) => void) {
    this.outputHandler = handler;
  }

  dispose() {
    this.setOutputHandler(undefined);
    if (!this._exited) {
      try { this.pty.kill(); } catch { /* PTY already exited */ }
    }
    this.terminal.dispose();
  }
}
