import spawn from 'cross-spawn';

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

/** Open VS Code in the given directory. */
export function openVSCode(dir: string): void {
  spawn.sync('code', ['.'], { cwd: dir, stdio: 'inherit' });
}

/** Launch Claude Code in the given directory. */
export function launchClaude(
  cwd: string,
  unsafe: boolean = false,
): void {
  const args = unsafe ? ['--dangerously-skip-permissions'] : [];
  spawn.sync('claude', args, { cwd, stdio: 'inherit' });
}
