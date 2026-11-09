import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

/**
 * On Windows, start every process the tests start with `windowsHide`.
 *
 * Why: a console program (git, node, cmd, taskkill) started by a process with
 * no console of its own — the test run started from an agent's shell, an
 * editor, a scheduled task — gets a new console window, which flashes up and
 * is gone a moment later. The suite starts thousands (real git repos, the
 * built `work`, fake tools), so a run blinked windows all over the screen.
 * The app itself passes `windowsHide` everywhere; the tests' own calls
 * (`execSync('git …')`) didn't. Patched here once, in every worker, rather
 * than in each of the ~140 calls; cross-spawn reads `child_process.spawn` at
 * call time, so it is covered too.
 *
 * Only where the run has no console to share: vitest.config.ts decides (tests/setup/hide-decision.ts),
 * since hiding costs a console per process where one could be shared (a terminal, CI).
 */

type Args = unknown[];

const isOptions = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The call's arguments with `windowsHide: true` in its options (added when it has none; one it set stays). */
export function withHide(args: Args): Args {
  const out = [...args];
  const at = out.findIndex((a, i) => i > 0 && isOptions(a));
  if (at >= 0) {
    const opts = out[at] as Record<string, unknown>;
    if (opts.windowsHide === undefined) out[at] = { ...opts, windowsHide: true };
    return out;
  }
  // No options: before a trailing callback (exec, execFile), else at the end.
  const cb = typeof out[out.length - 1] === 'function' ? out.length - 1 : out.length;
  out.splice(cb, 0, { windowsHide: true });
  return out;
}

const NAMES = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;

if (process.env.WORK_TESTS_HIDE_WINDOWS === '1') {
  const cp = childProcess as unknown as Record<string, ((...a: Args) => unknown) & { [promisify.custom]?: (...a: Args) => unknown }>;
  for (const name of NAMES) {
    const original = cp[name];
    const hidden = Object.assign((...a: Args) => original(...withHide(a)), original);
    // exec / execFile promisify to { stdout, stderr } through their own custom form: keep it, hidden too.
    const custom = original[promisify.custom];
    if (custom) Object.defineProperty(hidden, promisify.custom, { value: (...a: Args) => custom(...withHide(a)) });
    cp[name] = hidden;
  }
  // `import { execSync } from 'node:child_process'` reads the ESM copy: bring it up to date.
  syncBuiltinESMExports();
}
