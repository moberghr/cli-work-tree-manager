import pty, { type IPty } from 'node-pty';
import xtermHeadless from '@xterm/headless';

const { Terminal } = xtermHeadless;

export type SessionStatus = 'stopped' | 'running' | 'idle';

export class PtySession {
  readonly pty: IPty;
  readonly terminal: InstanceType<typeof Terminal>;
  readonly cwd: string;
  private outputHandler?: (data: string) => void;
  private _exited = false;
  private _idle = true;
  onExit?: (code: number) => void;
  onStatusChange?: () => void;

  constructor(cwd: string, cols: number, rows: number, unsafe: boolean) {
    this.cwd = cwd;
    this.terminal = new Terminal({
      cols,
      rows,
      scrollback: 1000,
      allowProposedApi: true,
    });

    const isWindows = process.platform === 'win32';
    const args = unsafe ? ['--dangerously-skip-permissions'] : [];

    // On Windows, claude is a .cmd shim — spawn via cmd.exe
    this.pty = pty.spawn(
      isWindows ? 'cmd.exe' : 'claude',
      isWindows ? ['/c', 'claude', ...args] : args,
      {
        name: 'xterm-256color',
        cwd,
        cols,
        rows,
        env: Object.fromEntries(
          Object.entries(process.env).filter((e): e is [string, string] => e[1] != null),
        ),
      },
    );

    this.pty.onData((data) => {
      this.terminal.write(data);
      this.outputHandler?.(data);
    });

    this.pty.onExit(({ exitCode }) => {
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
    if (!this._exited) this.pty.write(data);
  }

  resize(cols: number, rows: number) {
    if (!this._exited) {
      this.pty.resize(cols, rows);
      this.terminal.resize(cols, rows);
    }
  }

  setOutputHandler(handler?: (data: string) => void) {
    this.outputHandler = handler;
  }

  dispose() {
    this.setOutputHandler(undefined);
    if (!this._exited) this.pty.kill();
    this.terminal.dispose();
  }
}
