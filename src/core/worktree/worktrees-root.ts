import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The worktrees folder (config `worktreesRoot`), made or refused in words.
 *
 * Reported: a Mac's `worktreesRoot` was `/Users/worktrees` — beside the home folder, where only an
 * admin may create one — and creating a worktree failed with Node's `EACCES` stack as its message.
 * `work init` accepted the path without trying it, so the first worktree was where it surfaced.
 */

/** Why a folder can't be made, in words: `permission denied`, `a file is in the way`, … */
function reasonOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
  if (code === 'EROFS') return 'the disk is read-only';
  if (code === 'ENOTDIR' || code === 'EEXIST') return 'a file is in the way';
  if (code === 'ENOENT') return "its drive or folder doesn't exist";
  return (err as Error | null)?.message ?? String(err);
}

/** Make `dir` (and what's above it); null when it's there, else why not, in words. */
export function makeFolder(dir: string, mkdir: (p: string) => void = (p) => fs.mkdirSync(p, { recursive: true })): string | null {
  try {
    mkdir(dir);
    return null;
  } catch (err) {
    return `can't create ${dir}: ${reasonOf(err)}`;
  }
}

/** What to tell someone whose worktree folder couldn't be made: what, why, and where the setting is. */
export function worktreeFolderMessage(dir: string, worktreesRoot: string, why: string): string {
  const fix = `Set worktreesRoot (now ${worktreesRoot}) to a folder you own, e.g. ${path.join(os.homedir(), 'worktrees')}: \`work config edit\`, or ~/.work/config.json.`;
  return `Can't create the worktree folder ${dir}: ${why.replace(/^can't create .*?: /, '')}. ${fix}`;
}

/**
 * A typed worktrees folder (`work init`), checked by making it: the full path to save, or why it
 * can't be used — so a folder nobody may create is refused when it's typed, not at the first worktree.
 */
export function chooseWorktreesRoot(
  typed: string,
  opts: { home?: string; mkdir?: (p: string) => void } = {},
): { root: string } | { problem: string } {
  const p = expandHome(typed, opts.home);
  if (!p) return { problem: 'give a folder' };
  if (!path.isAbsolute(p)) return { problem: `${p} isn't a full path (start it from the drive, / or ~)` };
  const root = path.resolve(p);
  const problem = makeFolder(root, opts.mkdir);
  return problem ? { problem: `${problem} — pick a folder you own, e.g. under ${opts.home ?? os.homedir()}` } : { root };
}

/** `~` and `~/…` as the home folder (a typed path; the shell would have done it). */
export function expandHome(p: string, home = os.homedir()): string {
  const t = p.trim();
  if (t === '~') return home;
  if (t.startsWith('~/') || t.startsWith('~\\')) return path.join(home, t.slice(2));
  return t;
}
