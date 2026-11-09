import { runWorkChild } from '../worktree/setup-child.js';
import type { SkillsOutcome } from './account-admin.js';

/** The last line a run printed (its outcome, or why it failed). */
const lastLine = (text: string): string =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop() ?? '';

/**
 * Work's skills into one account's folder, in a child (`work account skills <name>`): the agent's own CLI runs several
 * times synchronously, which in work web would hold up every request — terminals and status hooks too.
 */
export function accountSkillsInChild(
  workBin: () => string,
  run: typeof runWorkChild = runWorkChild,
): (name: string) => Promise<SkillsOutcome> {
  return async (name) => {
    const r = await run(workBin(), ['account', 'skills', name], { timeoutMs: 5 * 60_000 });
    if (r.spawnError) return { ok: false, message: `couldn't start work: ${r.spawnError}` };
    if (r.timedOut) return { ok: false, message: 'installing work’s skills took too long' };
    const said = lastLine(r.stdout) || lastLine(r.stderr);
    return r.code === 0
      ? { ok: true, message: said || 'installed' }
      : { ok: false, message: lastLine(r.stderr) || said || `exited ${r.code}` };
  };
}
