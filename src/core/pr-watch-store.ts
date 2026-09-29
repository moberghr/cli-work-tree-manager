import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from './config.js';
import { atomicWriteFile } from './fs-safe.js';

/**
 * What the PR watch has already acted on, per session:
 * ~/.work/pr-watch/<sessionId>.json = { "seen": [key, …] }. Keys are
 * review-comment ids, per-PR baselines, and CI head commits already
 * reported (see pr-watch.ts / pr-review.ts).
 *
 * One file per session so deleting a session deletes its keys
 * (session-store.ts lists this path) and nothing needs a global cap.
 * Only work web writes these (it is a per-user singleton), so writes are
 * atomic but not locked.
 */

export function prWatchDir(): string {
  return path.join(getConfigDir(), 'pr-watch');
}
export function prWatchFileFor(sessionId: string): string {
  return path.join(prWatchDir(), `${sessionId}.json`);
}

function read(file: string): string[] {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf-8')) as { seen?: unknown };
    return Array.isArray(j.seen) ? j.seen.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

/** The pre-split ~/.work/pr-watch.json (one capped list for everyone):
 *  hand each key to its session's file, then remove it. Keys start with
 *  the session id, or `rv:` + the session id. */
function migrateLegacy(): void {
  const legacy = path.join(getConfigDir(), 'pr-watch.json');
  if (!fs.existsSync(legacy)) return;
  let keys: string[] = [];
  try {
    const j = JSON.parse(fs.readFileSync(legacy, 'utf-8')) as { told?: unknown };
    keys = Array.isArray(j.told) ? j.told.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    keys = [];
  }
  const bySession = new Map<string, string[]>();
  for (const k of keys) {
    const id = (k.startsWith('rv:') ? k.slice(3) : k).split(':')[0];
    if (id) bySession.set(id, [...(bySession.get(id) ?? []), k]);
  }
  fs.mkdirSync(prWatchDir(), { recursive: true });
  for (const [id, ks] of bySession) {
    const file = prWatchFileFor(id);
    atomicWriteFile(file, JSON.stringify({ seen: [...new Set([...read(file), ...ks])] }));
  }
  fs.rmSync(legacy, { force: true });
}

/** A per-session seen-store factory, cached in memory. (Structurally the
 *  SeenStore of pr-review.ts — not imported, so session-store, which lists
 *  our path, doesn't pull the ship/history types into a cycle.) */
export function createSeenStores(): (sessionId: string) => { has: (k: string) => boolean; add: (k: string) => void } {
  try {
    migrateLegacy();
  } catch {
    /* best-effort: worst case a known failure is reported once more */
  }
  const cache = new Map<string, Set<string>>();
  return (sessionId) => {
    let set = cache.get(sessionId);
    if (!set) {
      set = new Set(read(prWatchFileFor(sessionId)));
      cache.set(sessionId, set);
    }
    const keys = set;
    return {
      has: (k) => keys.has(k),
      add: (k) => {
        if (keys.has(k)) return;
        keys.add(k);
        try {
          fs.mkdirSync(prWatchDir(), { recursive: true });
          atomicWriteFile(prWatchFileFor(sessionId), JSON.stringify({ seen: [...keys] }));
        } catch {
          /* best-effort: worst case something is reported twice */
        }
      },
    };
  };
}
