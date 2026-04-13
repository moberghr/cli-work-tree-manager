import spawn from 'cross-spawn';
import { buildAiLaunchArgs, type AiLaunchOpts, type AiToolSpec } from '../core/ai-launcher.js';

/** Get the platform-appropriate default editor. */
export function getEditor(): string {
  return (
    process.env.EDITOR ??
    process.env.VISUAL ??
    (process.platform === 'win32' ? 'notepad' : 'vi')
  );
}

/** Open a file in the user's editor. */
export function openInEditor(filePath: string): void {
  const editor = getEditor();
  spawn.sync(editor, [filePath], { stdio: 'inherit' });
}

/** Open a URL in the default browser. */
export function openUrl(url: string): void {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

/** Open VS Code in the given directory. */
export function openVSCode(dir: string): void {
  spawn.sync('code', ['.'], { cwd: dir, stdio: 'inherit' });
}

/** Launch the configured AI tool in the given directory. */
export function launchAi(cwd: string, tool: AiToolSpec, opts: AiLaunchOpts = {}): void {
  const { cmd, args } = buildAiLaunchArgs(tool, opts);
  spawn.sync(cmd, args, { cwd, stdio: 'inherit' });
}
