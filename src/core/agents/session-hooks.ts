import type { TurnEdge } from './types.js';

/**
 * work's hooks, as every session's agent runs them: one per turn edge — `turn-start` (seal the checkpoint step,
 * record "working", attach pending comments), `turn-end` (checkpoint, record "done", deliver) — and the notification
 * (permission prompts). Given to the agents work starts, never written into the user's own settings: a Claude work
 * didn't start (another project, a plain `claude`) runs none of them (Claude's: session-settings.ts, `--settings`).
 */
export interface SessionHook {
  edge: TurnEdge;
  /** `work hook <event>`. */
  event: string;
  timeoutSec: number;
}

export const SESSION_HOOKS: readonly SessionHook[] = [
  { edge: 'turn-start', event: 'turn-start', timeoutSec: 10 },
  { edge: 'turn-end', event: 'turn-end', timeoutSec: 10 },
  { edge: 'notify', event: 'status-notify', timeoutSec: 5 },
];

/** The owner a bridged hook (`AgentEvents.bridge`) is written under: one of the retired ones, so their removal takes it. */
export const BRIDGE_OWNER: Record<TurnEdge, string> = { 'turn-start': 'web-turn', 'turn-end': 'web-turn', notify: 'web-status' };

/**
 * The hooks work web once wrote into the user's own settings (every owner it used, at every edge): taken out at its
 * start, since the agents it starts carry their own now — left there, every other Claude on the machine ran them, with
 * whatever `work` its PATH found (an old one printed its usage as a hook error on every turn).
 */
export const RETIRED_HOOK_OWNERS: ReadonlyArray<{ owner: string; edge: TurnEdge }> = [
  'web',
  'web-turn',
  'web-status',
  'web-checkpoint',
].flatMap((owner) => (['turn-start', 'turn-end', 'notify'] as const).map((edge) => ({ owner, edge })));
