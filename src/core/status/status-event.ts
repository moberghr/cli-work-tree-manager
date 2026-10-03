import type { PermissionRequest } from '../api-types.js';

/**
 * What happened to a session's agent, in work's terms — from its hooks (an
 * agent's adapter turns its hook payloads into these: agents/), or from the
 * dashboard. session-status.ts applies them. Types only, so the agent
 * adapters and the status store can both name them.
 */
export type StatusEvent =
  | { kind: 'prompt'; prompt?: string }
  | { kind: 'stop'; lastMessage?: string }
  | { kind: 'notification'; message?: string; request?: PermissionRequest; type?: string }
  /** The user answered the permission prompt from the dashboard. */
  | { kind: 'answered'; answer: 'allow' | 'deny' }
  /** A Stop that handed the agent more to do (pending comments, a PR note): the turn goes on. */
  | { kind: 'continue'; what?: string };
