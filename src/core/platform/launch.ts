import path from 'node:path';
import spawn from './spawn.js';
import { detachHere } from './process.js';
import { loadConfig } from './config.js';
import { applyEnvDelta, hasEnvDelta, type EnvDelta } from './env-delta.js';
import { buildAiLaunchArgs, type AiLaunchOpts, type AiToolSpec } from './ai-launcher.js';
import { launchFor } from './batch-launch.js';

/** Get the platform-appropriate default editor. */
export function getEditor(): string {
  return process.env.EDITOR ?? process.env.VISUAL ?? (process.platform === 'win32' ? 'notepad' : 'vi');
}

/** Open a file in the user's editor. */
export function openInEditor(filePath: string): void {
  const editor = getEditor();
  // This terminal's (vi) or a window of its own (notepad): to be seen.
  // Not a tool run: the editor keeps cmd.exe's usual lookup for its own terminals (spawn.ts `keepCwdLookup`).
  spawn.sync(editor, [filePath], { stdio: 'inherit', windowsHide: false, keepCwdLookup: true });
}

/** Open a URL in the default browser. */
export function openUrl(url: string): void {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  // `cmd /c start` is a console program: hidden, or a window flashes before the browser opens.
  spawn(cmd, args, { stdio: 'ignore', detached: detachHere(), windowsHide: true, keepCwdLookup: true }).unref();
}

/** VS Code and the editors built on it: the folder, then `--goto file:line`, opens the file at its line in that folder's window. */
const VSCODE_LIKE = /^(code|code-insiders|codium|vscodium|cursor|windsurf)$/i;
/** JetBrains' launchers: `--line N file`. */
const JETBRAINS = /^(idea|rider|webstorm|pycharm|goland|clion|phpstorm|rubymine|datagrip)(64)?$/i;
/** Sublime Text: `file:line`. */
const SUBLIME = /^(subl|sublime_text)$/i;

/**
 * The arguments that open `folder` in `editor`, or a file in it at a line. An editor work doesn't know how to send
 * to a line gets the file alone (it opens at the top); with no file, the folder, as before.
 */
export function editorArgs(editor: string, folder: string, file?: { path: string; line?: number }): string[] {
  if (!file) return [folder];
  // Either separator, whatever this platform's: a config written on Windows names `C:\…\code.cmd`.
  const name = (editor.trim().split(/[\\/]/).pop() ?? '').replace(/\.(cmd|bat|exe|sh)$/i, '');
  const line = file.line && file.line > 0 ? Math.floor(file.line) : undefined;
  if (VSCODE_LIKE.test(name)) return [folder, '--goto', line ? `${file.path}:${line}` : file.path];
  if (JETBRAINS.test(name)) return line ? [folder, '--line', String(line), file.path] : [folder, file.path];
  if (SUBLIME.test(name)) return [folder, line ? `${file.path}:${line}` : file.path];
  return [file.path];
}

/**
 * Open `folder` in the configured editor (config `editor`, `code` by default), or a file in it at a line
 * (`editorArgs`). Detached + ignored stdio so the spawn returns at once and the parent doesn't hold on to a zombie.
 * Resolves with why it could not start (`could not start <editor>: <reason>`), or null once it runs.
 */
export function startEditor(folder: string, file?: { path: string; line?: number }): Promise<string | null> {
  // cross-spawn, not node's spawn: the editor is usually a `.cmd` shim on
  // Windows (code.cmd), which node refuses to run without a shell since
  // the BatBadBut fix (EINVAL) — and a shell would interpret `&` etc. in
  // the path. cross-spawn escapes the argument for cmd.exe instead.
  const editor = loadConfig()?.editor?.trim() || 'code';
  return new Promise<string | null>((resolve) => {
    try {
      // Not detached on Windows: cmd.exe running code.cmd would then flash a console window (process.ts).
      // keepCwdLookup: the editor is no tool run — its own terminals and tasks would inherit shellEnv's switch (spawn.ts).
      const child = spawn(editor, editorArgs(editor, folder, file), {
        detached: detachHere(),
        stdio: 'ignore',
        windowsHide: true,
        keepCwdLookup: true,
      });
      // A missing editor surfaces as 'error' — on Windows only when the
      // cmd.exe wrapper exits (cross-spawn turns that exit into ENOENT) —
      // so wait for an error, an exit, or a moment of it running.
      const settle = setTimeout(() => resolve(null), 1500);
      child.once('error', (err) => {
        clearTimeout(settle);
        resolve(err.message);
      });
      child.once('exit', () => {
        clearTimeout(settle);
        resolve(null); // `code` hands off to the running editor and exits
      });
      child.unref();
    } catch (err) {
      resolve((err as Error).message);
    }
  }).then((failed) => (failed ? `could not start ${editor}: ${failed}` : null));
}

/** A program to start with its arguments (argv, never a shell line). */
export interface LaunchCommand {
  cmd: string;
  args: string[];
}

/** What opens `target` with the system's default app for its type. */
export function defaultAppCommand(target: string, platform: NodeJS.Platform = process.platform): LaunchCommand {
  if (platform === 'darwin') return { cmd: 'open', args: [target] };
  if (platform === 'win32') return { cmd: 'explorer.exe', args: [target] };
  return { cmd: 'xdg-open', args: [target] };
}

/**
 * What shows `target` in the file manager. Finder and Explorer select it in its folder (`/select,<path>` is one argument
 * to Explorer); on Linux there is no common way to select, so its folder is opened.
 */
export function revealCommand(target: string, platform: NodeJS.Platform = process.platform): LaunchCommand {
  if (platform === 'darwin') return { cmd: 'open', args: ['-R', target] };
  if (platform === 'win32') return { cmd: 'explorer.exe', args: [`/select,${target}`] };
  return { cmd: 'xdg-open', args: [path.dirname(target)] };
}

/** How long a just-started opener may take to say it could not start. */
const OPENER_SETTLE_MS = 500;

/**
 * Start an opener (open / explorer.exe / xdg-open) and leave it running. Only a failure to start counts: explorer.exe
 * exits non-zero even when it opened the file, so its exit is not waited for. Resolves with the reason, or null.
 */
function startOpener({ cmd, args }: LaunchCommand): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    try {
      // Hidden and detached as openUrl's; keepCwdLookup: what it opens is something you work in (spawn.ts).
      const child = spawn(cmd, args, { stdio: 'ignore', detached: detachHere(), windowsHide: true, keepCwdLookup: true });
      const settle = setTimeout(() => resolve(null), OPENER_SETTLE_MS);
      child.once('spawn', () => {
        clearTimeout(settle);
        resolve(null);
      });
      child.once('error', (err) => {
        clearTimeout(settle);
        resolve(err.message);
      });
      child.unref();
    } catch (err) {
      resolve((err as Error).message);
    }
  }).then((failed) => (failed ? `could not start ${cmd}: ${failed}` : null));
}

/** Open `target` with the system's default app. Only for a file that is safe to hand to one (terminal-paths.ts decides). */
export function openWithDefaultApp(target: string): Promise<string | null> {
  return startOpener(defaultAppCommand(target));
}

/** Show `target` in Finder / Explorer / the file manager, without opening it. */
export function revealInFileManager(target: string): Promise<string | null> {
  return startOpener(revealCommand(target));
}

/** Open VS Code in the given directory. */
export function openVSCode(dir: string): void {
  // The editor's window is the point; its terminals and tasks keep cmd.exe's usual lookup (spawn.ts `keepCwdLookup`).
  spawn.sync('code', ['.'], { cwd: dir, stdio: 'inherit', windowsHide: false, keepCwdLookup: true });
}

/**
 * Launch the configured AI tool in the given directory.
 *
 * When `port` is provided it is injected as `$PORT` into the launched process
 * so dev servers started by parallel agent sessions don't collide.
 */
export function launchAi(cwd: string, tool: AiToolSpec, opts: AiLaunchOpts = {}, port?: number, agentEnv?: EnvDelta): void {
  const { cmd, args } = buildAiLaunchArgs(tool, opts);
  // This terminal's environment, with the session's account change over it (agent.launch.env) and its port.
  const env =
    hasEnvDelta(agentEnv) || port !== undefined
      ? { ...applyEnvDelta(process.env, agentEnv), ...(port !== undefined ? { PORT: String(port) } : {}) }
      : undefined;
  const spawnOpts: Parameters<typeof spawn.sync>[2] =
    // The AI tool runs in this terminal: nothing to hide.
    env ? { cwd, stdio: 'inherit', windowsHide: false, env: env as NodeJS.ProcessEnv } : { cwd, stdio: 'inherit', windowsHide: false };
  // Windows: npm's claude.cmd is skipped for node on its script, and another batch file never gets a prompt
  // cmd.exe would act on (`&`, `%`, quotes, a line break that cuts the rest): refused, said why (batch-launch.ts).
  const launch = launchFor(cmd, args, { env: env ?? process.env });
  if ('refused' in launch) throw new Error(`${launch.refused} (give it the prompt in its terminal instead)`);
  spawn.sync(launch.cmd, launch.args, spawnOpts);
}
