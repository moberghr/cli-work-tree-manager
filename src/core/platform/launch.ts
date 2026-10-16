import spawn from './spawn.js';
import { detachHere } from './process.js';
import { buildAiLaunchArgs, type AiLaunchOpts, type AiToolSpec } from './ai-launcher.js';

/** Get the platform-appropriate default editor. */
export function getEditor(): string {
  return process.env.EDITOR ?? process.env.VISUAL ?? (process.platform === 'win32' ? 'notepad' : 'vi');
}

/** Open a file in the user's editor. */
export function openInEditor(filePath: string): void {
  const editor = getEditor();
  // This terminal's (vi) or a window of its own (notepad): to be seen.
  spawn.sync(editor, [filePath], { stdio: 'inherit', windowsHide: false });
}

/** Open a URL in the default browser. */
export function openUrl(url: string): void {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  // `cmd /c start` is a console program: hidden, or a window flashes before the browser opens.
  spawn(cmd, args, { stdio: 'ignore', detached: detachHere(), windowsHide: true }).unref();
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

/** Open VS Code in the given directory. */
export function openVSCode(dir: string): void {
  spawn.sync('code', ['.'], { cwd: dir, stdio: 'inherit', windowsHide: false }); // the editor's window is the point
}

/**
 * Launch the configured AI tool in the given directory.
 *
 * When `port` is provided it is injected as `$PORT` into the launched process
 * so dev servers started by parallel agent sessions don't collide.
 */
export function launchAi(cwd: string, tool: AiToolSpec, opts: AiLaunchOpts = {}, port?: number): void {
  const { cmd, args } = buildAiLaunchArgs(tool, opts);
  const spawnOpts: Parameters<typeof spawn.sync>[2] =
    // The AI tool runs in this terminal: nothing to hide.
    port !== undefined
      ? { cwd, stdio: 'inherit', windowsHide: false, env: { ...process.env, PORT: String(port) } }
      : { cwd, stdio: 'inherit', windowsHide: false };
  spawn.sync(cmd, args, spawnOpts);
}
