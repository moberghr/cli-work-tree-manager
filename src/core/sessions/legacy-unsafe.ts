import type { WorktreeSession } from './session-types.js';

// REMOVE IN THE NEXT RELEASE, with `--unsafe`'s hidden option (commands/shared/retired-unsafe.ts).
//
// `--unsafe` is retired: work never starts an agent with its skip-permissions flag. But an agent started that way
// before the upgrade may still run — the PTY host outlives updates, and an older host restarting or resuming one
// starts it again from its stored spec, flag and all. For one release, such an agent keeps the guards it had:
// the PR watch hands it no review text, `work send` refuses it, and `work pr reply` / `post` refuse in it.
// Once a current host (re)starts it, its restore entry no longer says unsafe (pty-registry.ts writes only
// what it starts with) and the guards drop out; a direct launch by a current `work` clears the row's flag.

/** What a guarded action says. */
export const STILL_UNSAFE =
  'this agent still runs without permission prompts from before --unsafe was retired: restart it (work restart) first';

/**
 * Whether the session's agent still runs as started `--unsafe` before the retirement (pure).
 * `hostEntry`: its PTY-host restore entry, when the host has one — then that decides (an older host keeps
 * `unsafe: true` there for as long as it runs it). With none: the history row's `launchedUnsafe`, and only while an
 * agent of it runs outside the host (a direct launch from before) — one not running starts normally next time.
 */
export function startedUnsafeBefore(
  session: Pick<WorktreeSession, 'launchedUnsafe'> | null | undefined,
  hostEntry: unknown,
  runsOutsideHost: () => boolean,
): boolean {
  if (hostEntry && typeof hostEntry === 'object') return (hostEntry as { unsafe?: unknown }).unsafe === true;
  return session?.launchedUnsafe === true && runsOutsideHost();
}
