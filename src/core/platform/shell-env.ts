/**
 * The environment for a command line a shell runs (`shell: true`, `cmd.exe /c …`): the user's own commands —
 * status hooks, `work run`, a dev server — run with a worktree as the working folder, and on Windows cmd.exe looks
 * a bare program name up in the working folder before PATH, so a `node.bat` or `git.cmd` committed at a branch's
 * root ran in place of the program the command names (measured with an echo-only file). Windows' own switch,
 * `NoDefaultCurrentDirectoryInExePath`, turns that lookup off for the shell and what it starts. A command that
 * means a file of the branch names it by its path (`.\scripts\dev.cmd`), which still runs. Off Windows: the
 * environment as given (a POSIX shell never looks in the working folder unless PATH says so).
 */
export const NO_CWD_LOOKUP = 'NoDefaultCurrentDirectoryInExePath';

export function shellEnv(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  if (platform !== 'win32') return env;
  // Windows' variable names are case-blind: drop any other spelling (one saying 0 would win or clash).
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (k.toLowerCase() !== NO_CWD_LOOKUP.toLowerCase()) out[k] = v;
  out[NO_CWD_LOOKUP] = '1';
  return out;
}
