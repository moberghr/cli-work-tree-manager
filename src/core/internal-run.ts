/**
 * The marker on work's OWN internal agent runs (an agent's oneShot:
 * checkpoint names, catch-up, archive summaries, a group's instructions
 * file). `runInternal` sets it on every one, whatever the agent; the hooks
 * those runs fire (they inherit the env) see it, and `work hook` bails at
 * once — so a run doesn't trip work's own turn hooks.
 *
 * Without it, naming a checkpoint starts an agent whose turn-start hook
 * seals the live step and whose turn-end appends a new checkpoint — which
 * triggers another naming run, and so on: one round fragmented into many
 * spurious steps. The name is kept from when only Claude ran these.
 */
export const INTERNAL_RUN_ENV = 'WORK_INTERNAL_CLAUDE';

/** Env overlay for an internal run: `{ ...process.env, ...internalRunEnv() }`. */
export function internalRunEnv(): Record<string, string> {
  return { [INTERNAL_RUN_ENV]: '1' };
}

/** True when this process was started by one of work's internal runs (or a hook it fired). */
export function isInternalRun(): boolean {
  return process.env[INTERNAL_RUN_ENV] === '1';
}
