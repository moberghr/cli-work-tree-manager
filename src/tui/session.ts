import pty, { type IPty } from 'node-pty';
import xtermHeadless from '@xterm/headless';
import { debug } from '../core/logger.js';

const { Terminal } = xtermHeadless;

export type SessionStatus = 'stopped' | 'running' | 'idle';

export class PtySession {
  readonly pty: IPty;
  terminal: InstanceType<typeof Terminal>;
  readonly cwd: string;
  private outputHandler?: (data: string) => void;
  private _exited = false;
  private _idle = true;
  private _outputBuffer = '';
  private _loggedOutput = false;
  onExit?: (code: number) => void;
  onStatusChange?: () => void;

  constructor(cwd: string, cols: number, rows: number, unsafe: boolean, command?: { cmd: string; args: string[] }, aiCommand?: string, resume?: boolean) {
    this.cwd = cwd;
    this.terminal = new Terminal({
      cols,
      rows,
      scrollback: 200,
      allowProposedApi: true,
    });

    const isWindows = process.platform === 'win32';

    let spawnCmd: string;
    let spawnArgs: string[];

    if (command) {
      // Custom command (e.g. work2 tree)
      spawnCmd = isWindows ? 'cmd.exe' : command.cmd;
      spawnArgs = isWindows ? ['/c', command.cmd, ...command.args] : command.args;
    } else {
      // Launch configured AI tool (default: claude)
      const tool = aiCommand ?? 'claude';
      const parts = tool.split(/\s+/);
      const toolCmd = parts[0];
      const toolArgs = parts.slice(1);
      if (unsafe) toolArgs.push('--dangerously-skip-permissions');
      if (resume) toolArgs.push('--continue');
      spawnCmd = isWindows ? 'cmd.exe' : toolCmd;
      spawnArgs = isWindows ? ['/c', toolCmd, ...toolArgs] : toolArgs;
    }

    debug('PtySession spawn', { spawnCmd, spawnArgs, cwd, cols, rows, resume });
    this.pty = pty.spawn(spawnCmd, spawnArgs, {
      name: 'xterm-256color',
      cwd,
      cols,
      rows,
      env: Object.fromEntries(
        Object.entries(process.env).filter((e): e is [string, string] => e[1] != null),
      ),
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

  get idle() {
    return this._idle;
  }

  /** Called by the dashboard when a hook event indicates idle state change. */
  setIdle(idle: boolean) {
    if (this._exited || this._idle === idle) return;
    this._idle = idle;
    this.onStatusChange?.();
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

  /** Clear scrollback buffer to free memory. */
  clearScrollback() {
    if (!this._exited) {
      this.terminal.clear();
    }
  }

  /**
   * Dispose the xterm Terminal and create a fresh one to fully release
   * internal parser/buffer memory.  The visible viewport content is
   * captured first and replayed into the new terminal so nothing looks
   * different when the user switches back.
   */
  resetTerminal() {
    if (this._exited) return;

    const { cols, rows } = this.terminal;
    const buf = this.terminal.buffer.active;

    // Capture visible viewport lines as plain text
    const viewportLines: string[] = [];
    for (let y = 0; y < rows; y++) {
      const line = buf.getLine(buf.baseY + y);
      viewportLines.push(line ? line.translateToString(true) : '');
    }

    this.terminal.dispose();

    this.terminal = new Terminal({
      cols,
      rows,
      scrollback: 200,
      allowProposedApi: true,
    });

    // Replay viewport content (skip trailing empty lines)
    let lastNonEmpty = viewportLines.length - 1;
    while (lastNonEmpty >= 0 && viewportLines[lastNonEmpty].trim() === '') lastNonEmpty--;
    for (let i = 0; i <= lastNonEmpty; i++) {
      this.terminal.write(viewportLines[i] + (i < lastNonEmpty ? '\r\n' : ''));
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
