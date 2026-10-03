import crypto from 'node:crypto';

/**
 * The one session identity: sha1(target:branch), 12 hex chars. Every
 * per-session store is keyed by it (see session-store.ts). Its own module so
 * callers that just need the id don't load web-state's file watcher.
 */
export function sessionIdFor(s: { target: string; branch: string }): string {
  return crypto.createHash('sha1').update(`${s.target}:${s.branch}`).digest('hex').slice(0, 12);
}
