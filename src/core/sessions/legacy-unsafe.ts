import type { WorktreeSession } from './session-types.js';

// REMOVE IN THE NEXT RELEASE, with `--unsafe`'s hidden option (commands/shared/retired-unsafe.ts).
//
// `--unsafe` is retired: work never starts an agent with its skip-permissions flag. But an agent started that way
// before the upgrade may still run — the PTY host outlives updates, and an older host restarting or resuming one
// starts it again from its stored spec, flag and all; a Claude launched directly in a terminal runs until it is quit.
// For one release, such an agent keeps the guards it had: the PR watch hands it no review text, `work send` refuses
// it, and `work pr reply` / `post` refuse in it. Each case is lifted its own way (`stillUnsafeMessage`): an older
// host's entry says `unsafe: true` until a current host runs it (pty-registry.ts writes only what it starts with,
// so `work pty-host --restart`); a direct launch from before is only gone once it was quit — a current `work`
// clears the row's flag when it launches with no agent of the session running anywhere (`clearLaunchedUnsafeWhenIdle`).

/** Which agent from before keeps the guards: one an older PTY host runs (`old-host`), one launched directly in a
 *  terminal and still running outside the host (`outside`), or both. */
export type LegacyUnsafe = 'old-host' | 'outside' | 'both';

/**
 * Whether the session's agent still runs as started `--unsafe` before the retirement, and how (pure; null: it
 * doesn't). Either holds on its own: the host's restore entry saying `unsafe: true` (an older host keeps it there for
 * as long as it runs it), or the history row's `launchedUnsafe` while an agent of the session runs outside the host —
 * even when a current host also has an entry for it (a direct launch from before is still running beside it).
 */
export function legacyUnsafeCase(
  session: Pick<WorktreeSession, 'launchedUnsafe'> | null | undefined,
  hostEntry: unknown,
  runsOutsideHost: () => boolean,
): LegacyUnsafe | null {
  const oldHost = !!hostEntry && typeof hostEntry === 'object' && (hostEntry as { unsafe?: unknown }).unsafe === true;
  const outside = session?.launchedUnsafe === true && runsOutsideHost();
  if (oldHost && outside) return 'both';
  if (oldHost) return 'old-host';
  return outside ? 'outside' : null;
}

/** `legacyUnsafeCase` as a yes / no. */
export function startedUnsafeBefore(
  session: Pick<WorktreeSession, 'launchedUnsafe'> | null | undefined,
  hostEntry: unknown,
  runsOutsideHost: () => boolean,
): boolean {
  return legacyUnsafeCase(session, hostEntry, runsOutsideHost) !== null;
}

const LIFT_OLD_HOST = 'run `work pty-host --restart` (the host is from before --unsafe was retired)';
const LIFT_OUTSIDE = 'quit it in its terminal and start it again with `work tree`';

/** What lifts the guard, for the case at hand. */
export function howToLift(c: LegacyUnsafe): string {
  if (c === 'old-host') return LIFT_OLD_HOST;
  if (c === 'outside') return LIFT_OUTSIDE;
  return `${LIFT_OLD_HOST}, and ${LIFT_OUTSIDE}`;
}

/** What a guarded action says. */
export function stillUnsafeMessage(c: LegacyUnsafe): string {
  return `this agent still runs without permission prompts from before --unsafe was retired: ${howToLift(c)}`;
}
